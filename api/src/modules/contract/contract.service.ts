import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { SseStream } from '../../common/utils/sse';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DshService, DshExecutionHandle } from '../../common/services/dsh.service';
import { DINGTALK_ADAPTER, DingTalkAdapter } from '../project/adapters/adapter.interfaces';
import { ContractTemplateService } from './contract-template.service';
import { ContractFileService } from './contract-file.service';
import { buildDraftPrompt, buildReviewPrompt, buildElementsText, hasAnyElement } from './contract-prompt.builder';
import { CreateContractDto } from './dto/create-contract.dto';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../project/domain/project-access.types';
import { CreateProjectUseCase } from '../project/application/create-project.use-case';
import { EscalateProjectToLegalUseCase } from '../project/application/escalate-project-to-legal.use-case';

/**
 * 合同协作服务（生成/审查编排；文件管理见 ContractFileService，prompt 组装见 contract-prompt.builder）。
 *
 * 数据流（ASCII 图）：
 *   generateDraft（复用 CreateProjectUseCase 事务建单，P1-03；绕过咨询 riskService/prompt）
 *     → executeStream(合同起草 prompt, timeout 600s) → SSE 推前端
 *     → 流结束: ContractDocument(type=draft, version=N) 落库 + assistant 消息 + status→待复核
 *   submitReview（business 发起法务审阅，统一 Policy 校验）
 *   reviewContract（legal AI 风险审查，P1-05）
 *     → 显式 sourceDocumentId（缺省取项目最新可审查 ContractDocument，不再按 role/label 推断）
 *     → 先创建 ContractReviewRun(queued/running, sourceDocumentId) 再启动 AI
 *     → 风险报告只进 ReviewRun.result，绝不创建为 ContractDocument
 */
@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dshService: DshService,
    private readonly templateService: ContractTemplateService,
    private readonly fileService: ContractFileService,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    private readonly createProjectUseCase: CreateProjectUseCase,
    private readonly accessPolicy: ProjectAccessPolicy,
    private readonly escalateToLegal: EscalateProjectToLegalUseCase,
  ) {}

  // ═══════════════════════════════════════════
  // 生成合同草稿
  // ═══════════════════════════════════════════

  /**
   * 把 DshService 的语义化事件句柄适配成 sendSSE 期望的 SseStream 形状
   * （.stdout 增量 + on('close', code) + __cancelled/__finalText/__errorMessage 标记）。
   *
   * 适配只做在这一处：DshService 本身不伪装 ChildProcess（迁移计划 D2 决策的落地），
   * controller 侧的 sendSSE 复用不变——它仍然只服务咨询/合同两条通路的共同 SSE 协议，
   * 与执行引擎（Codex 还是 dsh）无关。sendSSE 的参数类型本身已是 SseStream
   * （sse.ts），合同模块这里只需适配成该形状，无需伪造完整 ChildProcess。
   */
  private adaptDshHandle(handle: DshExecutionHandle): SseStream {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const fake: SseStream = Object.assign(emitter, {
      stdout,
      __finalText: undefined,
      __errorMessage: undefined,
    });

    handle.on('text', (delta: string) => stdout.write(delta));
    handle.on('done', (result: { text: string }) => {
      // 用 dsh 侧权威的完整文本覆盖增量重拼，避免两个来源分叉（sendSSE 读取 __finalText）
      fake.__finalText = result.text;
      stdout.end();
      emitter.emit('close', 0);
    });
    handle.on('cancelled', () => {
      (fake as any).__cancelled = true;
      stdout.end();
      emitter.emit('close', null);
    });
    handle.on('error', (error: Error) => {
      this.logger.error(`dsh 执行失败：${error.message}`);
      // 真实错误信息经 __errorMessage 透传（落库/SSE error 分支读取）；
      // 不单独 emit 'error'——无监听时 EventEmitter 会抛未处理错误，
      // 而 close(code≠0) 已同时覆盖 DB 失败写入与前端 SSE 失败响应。
      fake.__errorMessage = error.message;
      stdout.end();
      emitter.emit('close', 1);
    });

    return fake;
  }

  /**
   * 生成合同草稿。新建工单复用 CreateProjectUseCase（事务 + 幂等 + Outbox，P1-03），
   * 不再手工分步创建。返回 SSE 子进程供 controller 推送。
   */
  async generateDraft(
    dto: CreateContractDto,
    actor: ProjectActor,
    signal?: AbortSignal,
  ): Promise<{
    projectId: string;
    stream?: SseStream;
    reused?: boolean;
    status?: string;
    generationRunId?: string;
    documentId?: string | null;
  }> {
    // Project.idempotencyKey 只保护“建单”；生成流还必须有自己的唯一运行记录。
    // 否则两个请求可能只落一个 Project，却各自启动一条 Codex 流。
    if (!dto.projectId && dto.idempotencyKey) {
      const existing = await this.createProjectUseCase.findExistingByIdempotencyKey(
        dto.idempotencyKey,
        actor.id,
      );
      if (existing) {
        this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, existing);
        const requestKey = this.buildGenerationRequestKey(dto, existing.id).requestKey;
        const existingRun = await this.prisma.contractGenerationRun.findUnique({
          where: { requestKey },
        });
        // 竞态窗口：首个请求可能刚提交 Project、尚未创建 GenerationRun。
        // 此时只返回处理中，不得再启动第二条流；首个请求会继续完成自己的 claim。
        return {
          projectId: existing.id,
          reused: true,
          status: existingRun?.status === 'succeeded' ? existing.status : existing.status,
          generationRunId: existingRun?.id,
          documentId: existingRun?.documentId,
        };
      }
    }

    const template = await this.templateService.findBySlug(dto.templateSlug);
    const elements = dto.elements || {};

    // 空要素校验（测试用例 #13）
    if (!hasAnyElement(elements)) {
      throw new BadRequestException('请至少填写一个合同要素');
    }

    let projectId: string;
    let existingProject: any | null = null;
    let createdProject = false;
    if (dto.projectId) {
      existingProject = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
      if (!existingProject) throw new NotFoundException('工单不存在');
      this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, existingProject);
      if (existingProject.route !== 'llm') {
        throw new ConflictException('该工单已进入法务流程，无法继续生成'); // 升级守卫
      }
      projectId = existingProject.id;

      const candidateRequestKey = this.buildGenerationRequestKey(dto, projectId).requestKey;
      const existingGenerationRun = await this.prisma.contractGenerationRun.findUnique({
        where: { requestKey: candidateRequestKey },
      });
      // 已有处理中/已完成项目的同一请求是幂等重试，不得追加用户消息或重新启动 Codex。
      // 已完成项目若使用不同要素指纹，则允许生成新版本；版本由 ContractDocument 唯一约束保护。
      if (['分析中', '待复核', '已回传'].includes(existingProject.status)) {
        if (existingGenerationRun || existingProject.status === '分析中') {
          return {
            projectId,
            reused: true,
            status: existingProject.status,
            generationRunId: existingGenerationRun?.id,
            documentId: existingGenerationRun?.documentId,
          };
        }
      }
    } else {
      const { project, created } = await this.createProjectUseCase.execute({
        kind: 'contract',
        title: `合同草稿·${template.name}`,
        input: buildElementsText(elements),
        creatorId: actor.id,
        risk: 'P2',
        route: 'llm',
        legalBpId: null,
        idempotencyKey: dto.idempotencyKey ?? null,
        contractTemplateSlug: template.slug,
        events: [this.formatTime() + ' · AI 正在生成合同草稿…'],
      });
      projectId = project.id;
      createdProject = created;
      if (!created) {
        const requestKey = this.buildGenerationRequestKey(dto, projectId).requestKey;
        const existingRun = await this.prisma.contractGenerationRun.findUnique({
          where: { requestKey },
        });
        return {
          projectId,
          reused: true,
          status: project.status,
          generationRunId: existingRun?.id,
          documentId: existingRun?.documentId,
        };
      }
    }

    const { requestKey, elementsHash } = this.buildGenerationRequestKey(dto, projectId);
    const generationRun = await this.claimGenerationRun(
      projectId,
      requestKey,
      dto.templateSlug,
      elementsHash,
    );
    if (!generationRun.claimed) {
      return {
        projectId,
        reused: true,
        status: generationRun.run.status === 'succeeded'
          ? (existingProject?.status ?? '待复核')
          : (existingProject?.status ?? '分析中'),
        generationRunId: generationRun.run.id,
        documentId: generationRun.run.documentId,
      };
    }

    // 只有真正 claim 到 GenerationRun 的请求才能写首条续生成消息和启动 Codex。
    if (!createdProject && dto.projectId) {
      await this.prisma.projectMessage.create({
        data: { projectId, role: 'user', text: buildElementsText(elements) },
      });
    }

    const prompt = buildDraftPrompt(template.prompt, elements, template.slug, template.name);
    // 合同草稿远长于咨询回复：timeout 放宽到 600s（实测超时根因，2026-08-03）
    const generationRunId = generationRun.run.id;
    let handle: DshExecutionHandle;
    try {
      handle = await this.dshService.executeStream(prompt, {
        timeout: 600_000,
        sessionId: projectId,
        signal,
      });
    } catch (error) {
      await this.prisma.contractGenerationRun.update({
        where: { id: generationRunId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: String((error as Error)?.message ?? error).slice(0, 200),
        },
      }).catch(() => undefined);
      throw error;
    }

    const stream = this.adaptDshHandle(handle);
    let fullText = '';
    stream.stdout?.on('data', (chunk: Buffer) => { fullText += chunk.toString(); });

    stream.on('close', async (code) => {
      // dsh 侧权威完整文本（done 事件携带），回退到增量重拼（理论一致，防御分叉）
      const finalText = (stream as any).__finalText ?? fullText;
      // 连接断开主动取消 → 不写失败状态（刷新 ≠ 生成失败）
      if ((stream as any).__cancelled) {
        await this.prisma.contractGenerationRun.update({
          where: { id: generationRunId },
          data: { status: 'cancelled', completedAt: new Date(), errorMessage: '合同生成已取消' },
        }).catch(() => undefined);
        return;
      }
      if (code === 0 && finalText.trim()) {
        try {
          await this.prisma.$transaction(async (tx) => {
            // AI 草稿 → ContractDocument(type=draft, version=N)；消息仅供 UI，不是审查数据源
            const document = await this.fileService.createContractDocument(tx, {
              projectId,
              documentType: 'draft',
              content: finalText.trim(),
              createdBy: actor.id,
            });
            await tx.projectMessage.create({
              data: { projectId, role: 'assistant', text: finalText.trim() },
            });
            await tx.project.update({
              where: { id: projectId },
              data: { status: '待复核', result: finalText.trim() },
            });
            await tx.contractGenerationRun.update({
              where: { id: generationRunId },
              data: {
                status: 'succeeded',
                documentId: document.id,
                completedAt: new Date(),
                errorMessage: null,
              },
            });
          });
          await this.addEvent(projectId, this.formatTime() + ' · 合同草稿已生成');
          // 独立提示消息（不放入合同正文）
          const pendingCount = (finalText.match(/【待补充】/g) || []).length;
          await this.addEvent(
            projectId,
            `本稿共 ${pendingCount} 处【待补充】，需双方确认后填写。本稿由 AI 生成，仅供参考，需经法务审阅后生效。`,
          );
        } catch (err) {
          this.logger.error(`合同草稿落库失败：${err}`);
        }
      } else {
        this.logger.error(`合同草稿生成失败，code=${code}`);
        try {
          const errorMessage = (stream as any).__errorMessage
            ? String((stream as any).__errorMessage).slice(0, 200)
            : 'AI 合同生成失败或超时';
          await this.prisma.contractGenerationRun.update({
            where: { id: generationRunId },
            data: { status: 'failed', completedAt: new Date(), errorMessage },
          });
          await this.prisma.project.update({
            where: { id: projectId },
            data: { status: '待处理', isFailed: true },
          });
          await this.addEvent(projectId, this.formatTime() + ' · 合同草稿生成失败，已转人工处理');
        } catch (err) {
          this.logger.error(`失败状态更新失败：${err}`);
        }
      }
    });

    return { projectId, stream, generationRunId };
  }

  /**
   * 生成请求键：显式 idempotencyKey 优先；已有工单无 key 时用模板+要素指纹。
   * 同一 key 只允许一条运行流；不同指纹可以安全生成新 ContractDocument 版本。
   */
  private buildGenerationRequestKey(dto: CreateContractDto, projectId: string) {
    const canonicalElements = JSON.stringify(
      Object.entries(dto.elements ?? {})
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const elementsHash = createHash('sha256').update(canonicalElements).digest('hex');
    const requestKey = dto.idempotencyKey
      ? `contract:idempotency:${dto.idempotencyKey}`
      : `contract:project:${projectId}:template:${dto.templateSlug}:elements:${elementsHash}`;
    return { requestKey, elementsHash };
  }

  /** 原子 claim：P2002 竞争者读取既有 running/succeeded 记录，不得再 spawn。 */
  private async claimGenerationRun(
    projectId: string,
    requestKey: string,
    templateSlug: string,
    elementsHash: string,
  ): Promise<{ run: any; claimed: boolean }> {
    try {
      const run = await this.prisma.contractGenerationRun.create({
        data: {
          projectId,
          requestKey,
          templateSlug,
          elementsHash,
          status: 'running',
          startedAt: new Date(),
        },
      });
      return { run, claimed: true };
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const run = await this.prisma.contractGenerationRun.findUnique({ where: { requestKey } });
      if (!run) throw error;
      return { run, claimed: false };
    }
  }

  // ═══════════════════════════════════════════
  // 发起法务审阅 / AI 风险审查
  // ═══════════════════════════════════════════

  /** business 发起法务审阅 — 原子守卫 WHERE route=llm 防重复提交（统一 Policy 校验） */
  async submitReview(projectId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.SubmitReview, project);

    // P1-10：统一法务升级用例（事务内条件更新 + 事件 + Outbox 建群）。
    // 不再向 `project.dingtalkChatId || 'contract-review'` 假群 ID 发通知；
    // 真实通知由 Outbox Worker 建群成功后发送。
    const { upgraded } = await this.escalateToLegal.execute({
      projectId,
      route: 'legalbp',
      status: '待复核',
      eventTexts: [this.formatTime() + ' · 已发起法务审阅，已提交法务处理，等待 BP 分配'],
    });
    if (!upgraded) throw new ConflictException('该工单已进入法务流程');

    return { projectId, status: '待复核' };
  }

  /**
   * legal AI 风险审查（P1-05）：显式 sourceDocumentId，缺省取项目最新可审查 ContractDocument。
   * 风险报告永远只进 ContractReviewRun.result，绝不创建为 ContractDocument。
   */
  async reviewContract(
    projectId: string,
    actor: ProjectActor,
    skillId?: string,
    sourceDocumentId?: string,
    signal?: AbortSignal,
  ): Promise<{
    projectId: string;
    stream: SseStream;
    reviewRunId: string;
    sourceDocumentId: string;
    sourceVersion: number;
  }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    if (project.kind !== 'contract') throw new BadRequestException('非合同工单');
    if (project.status !== '待复核') throw new BadRequestException('当前状态不可发起审查');
    this.accessPolicy.assertCan(actor, ProjectAction.ReviewContract, project);

    // 技能解析（审查时选技能 → 读实时 prompt；可用范围 = 公有 + 自己的私有）
    let skillName: string | null = null;
    let skillPrompt: string | null = null;
    if (skillId) {
      const skill = await this.prisma.skill
        .findFirst({
          where: {
            id: skillId,
            isActive: true,
            OR: [{ visibility: 'public' }, { creatorId: actor.id, visibility: 'private' }],
          },
        })
        .catch(() => null);
      if (skill) {
        skillName = skill.name;
        skillPrompt = skill.prompt;
      } else {
        this.logger.warn(`审查技能 skillId=${skillId} 解析失败，按无技能审查`);
      }
    }
    if (skillName) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { skillId: skillId ?? null, skillName },
      });
    }

    // 解析源文档：显式 sourceDocumentId 必须属于当前项目；缺省取最新可审查文档
    const sourceDoc = await this.resolveSourceDocument(projectId, sourceDocumentId);
    if (!sourceDoc) throw new BadRequestException('未找到可审查的合同文档');

    // 先创建 ContractReviewRun 再启动 Codex（9.3-5）
    const reviewRun = await this.prisma.contractReviewRun.create({
      data: {
        projectId,
        sourceDocumentId: sourceDoc.id,
        status: 'running',
        startedAt: new Date(),
        skillId: skillId ?? null,
        createdBy: actor.id,
      },
    });

    const prompt = buildReviewPrompt(
      sourceDoc.content,
      skillName ?? undefined,
      skillPrompt ?? undefined,
    );

    let handle: DshExecutionHandle;
    try {
      handle = await this.dshService.executeStream(prompt, {
        timeout: 600_000,
        sessionId: projectId,
        signal,
      });
    } catch (e) {
      // 队列繁忙/排队超时：审查未开始，标记 failed（SSE 开始前返回 HTTP 错误）
      await this.prisma.contractReviewRun
        .update({
          where: { id: reviewRun.id },
          data: {
            status: 'failed',
            errorMessage: String((e as Error)?.message ?? e).slice(0, 200),
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw e;
    }

    const stream = this.adaptDshHandle(handle);
    let fullText = '';
    stream.stdout?.on('data', (chunk: Buffer) => { fullText += chunk.toString(); });

    stream.on('close', async (code) => {
      // dsh 侧权威完整文本（done 事件携带），回退到增量重拼（理论一致，防御分叉）
      const finalText = (stream as any).__finalText ?? fullText;
      if ((stream as any).__cancelled) {
        await this.prisma.contractReviewRun
          .update({
            where: { id: reviewRun.id },
            data: { status: 'cancelled', errorMessage: '审查已取消', completedAt: new Date() },
          })
          .catch(() => undefined);
        return;
      }
      if (code === 0 && finalText.trim()) {
        try {
          // 风险报告只进 ReviewRun.result（9.3-6）；另写 ProjectMessage 供 UI 展示
          await this.prisma.$transaction([
            this.prisma.contractReviewRun.update({
              where: { id: reviewRun.id },
              data: { status: 'succeeded', result: finalText.trim(), completedAt: new Date() },
            }),
            this.prisma.projectMessage.create({
              data: { projectId, role: 'assistant', text: finalText.trim(), label: 'AI 风险审查' },
            }),
          ]);
          await this.addEvent(projectId, this.formatTime() + ' · AI 风险审查完成');
        } catch (err) {
          this.logger.error(`审查结果落库失败：${err}`);
        }
      } else {
        const errorMessage = (stream as any).__errorMessage
          ? String((stream as any).__errorMessage).slice(0, 200)
          : 'AI 审查失败或超时';
        await this.prisma.contractReviewRun
          .update({
            where: { id: reviewRun.id },
            data: { status: 'failed', errorMessage, completedAt: new Date() },
          })
          .catch(() => undefined);
        await this.addEvent(projectId, this.formatTime() + ' · AI 风险审查失败，请人工审阅');
      }
    });

    return {
      projectId,
      stream,
      reviewRunId: reviewRun.id,
      sourceDocumentId: sourceDoc.id,
      sourceVersion: sourceDoc.version,
    };
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /**
   * 解析审查源文档（P1-05）：显式 sourceDocumentId 必须属于当前项目；
   * 缺省取项目最新 ContractDocument（风险报告只进 ReviewRun，不会混入文档表，
   * 因此不会把上一次风险报告当合同正文）。
   */
  private async resolveSourceDocument(
    projectId: string,
    sourceDocumentId?: string,
  ): Promise<{ id: string; content: string; version: number } | null> {
    if (sourceDocumentId) {
      const doc = await this.prisma.contractDocument.findFirst({
        where: { id: sourceDocumentId, projectId },
        select: { id: true, content: true, version: true },
      });
      if (!doc) throw new BadRequestException('源文档不存在或不属于当前工单');
      return doc;
    }
    return this.prisma.contractDocument.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true, version: true },
    });
  }

  private async addEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({ data: { projectId, text } });
  }

  private formatTime(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}
