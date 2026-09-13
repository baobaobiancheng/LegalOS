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
import { ContractGenerationRun, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DshService, DshExecutionHandle } from '../../common/services/dsh.service';
import { DINGTALK_ADAPTER, DingTalkAdapter } from '../project/adapters/adapter.interfaces';
import { ContractTemplateService } from './contract-template.service';
import { ContractDocumentWriter } from './application/contract-document.writer';
import { buildDraftPrompt, buildReviewPrompt, buildElementsText, hasAnyElement } from './contract-prompt.builder';
import { CreateContractDto } from './dto/create-contract.dto';
import { ProjectAccessPolicy } from '../project/domain/project-access.policy';
import { ProjectAction, ProjectActor } from '../project/domain/project-access.types';
import { CreateProjectUseCase } from '../project/application/create-project.use-case';
import { EscalateProjectToLegalUseCase } from '../project/application/escalate-project-to-legal.use-case';
import { formatEventTime } from '../../common/utils/event-time';
import { safeErrorTag } from '../../common/utils/safe-error';
import {
  AiProjectVersion,
  aiProjectVersionWhere,
  nextProjectVersion,
} from '../project/domain/ai-project-version';

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
    private readonly documentWriter: ContractDocumentWriter,
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
      this.logger.error(`dsh 执行失败：${safeErrorTag(error)}`);
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
    completion?: Promise<unknown>;
  }> {
    let resolvedProjectId = dto.projectId;
    if (!dto.projectId && dto.idempotencyKey) {
      const existing = await this.createProjectUseCase.findExistingByIdempotencyKey(
        dto.idempotencyKey,
        actor.id,
      );
      if (existing) {
        this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, existing);
        resolvedProjectId = existing.id;
      }
    }

    const template = await this.templateService.findBySlug(dto.templateSlug);
    const elements = dto.elements || {};

    // 空要素校验（测试用例 #13）
    if (!hasAnyElement(elements)) {
      throw new BadRequestException('请至少填写一个合同要素');
    }
    const canonicalElements = JSON.stringify(
      Object.entries(elements)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const elementsHash = createHash('sha256').update(canonicalElements).digest('hex');

    let projectId: string;
    let approvedText: string | undefined;
    let createdProject = false;
    if (resolvedProjectId) {
      const existingProject = await this.prisma.project.findUnique({ where: { id: resolvedProjectId } });
      if (!existingProject) throw new NotFoundException('工单不存在');
      this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, existingProject);
      if (existingProject.route !== 'llm') {
        throw new ConflictException('该工单已进入法务流程，无法继续生成'); // 升级守卫
      }
      if (existingProject.status === '已取消' || existingProject.reviewStatus === 'review_completed') {
        throw new ConflictException('该工单已人工办结或取消，无法继续生成');
      }
      projectId = existingProject.id;

      const candidateRequestKey = this.buildGenerationRequestKey(dto, projectId, elementsHash);
      const existingGenerationRun = await this.prisma.contractGenerationRun.findUnique({
        where: { requestKey: candidateRequestKey },
      });
      if (existingGenerationRun) {
        this.assertGenerationPayload(existingGenerationRun, projectId, dto.templateSlug, elementsHash);
        if (['queued', 'running', 'succeeded'].includes(existingGenerationRun.status)) {
          return {
            projectId,
            reused: true,
            status: existingProject.status,
            generationRunId: existingGenerationRun.id,
            documentId: existingGenerationRun.documentId,
          };
        }
      }
    } else {
      // 缺少审定正文时不创建孤立的“分析中”工单。
      approvedText = await this.templateService.readApprovedText(template.slug);
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
        events: [formatEventTime() + ' · AI 正在生成合同草稿…'],
      });
      projectId = project.id;
      createdProject = created;
    }

    approvedText ??= await this.templateService.readApprovedText(template.slug);
    const prompt = buildDraftPrompt(template.prompt, elements, approvedText, template.name);
    const requestKey = this.buildGenerationRequestKey(dto, projectId, elementsHash);
    const generationRun = await this.claimGenerationRun(
      projectId,
      requestKey,
      dto.templateSlug,
      elementsHash,
      actor,
      createdProject ? undefined : buildElementsText(elements),
    );
    if (!generationRun.claimed) {
      return {
        projectId,
        reused: true,
        status: generationRun.projectVersion.status,
        generationRunId: generationRun.run.id,
        documentId: generationRun.run.documentId,
      };
    }

    const projectVersion = generationRun.projectVersion;
    // 合同草稿远长于咨询回复：timeout 放宽到 600s（实测超时根因，2026-08-03）
    const generationRunId = generationRun.run.id;
    const runningAttempt = {
      id: generationRunId, projectId, status: 'running' as const, startedAt: generationRun.run.startedAt,
    };
    let handle: DshExecutionHandle;
    try {
      handle = await this.dshService.executeStream(prompt, {
        timeout: 600_000,
        sessionId: projectId,
        signal,
      });
    } catch (error) {
      await this.settleGenerationAttempt(runningAttempt, projectVersion,
        signal?.aborted ? 'cancelled' : 'failed', '合同生成未启动，请重试');
      throw error;
    }

    const stream = this.adaptDshHandle(handle);
    let fullText = '';
    stream.stdout?.on('data', (chunk: Buffer) => { fullText += chunk.toString(); });
    const deferred = createDeferred();

    stream.on('close', async (code) => {
      // dsh 侧权威完整文本（done 事件携带），回退到增量重拼（理论一致，防御分叉）
      const finalText = (stream as any).__finalText ?? fullText;
      if (stream.__cancelled) {
        await this.settleGenerationAttempt(runningAttempt, projectVersion, 'cancelled', '合同生成已取消');
        deferred.reject(new Error('合同生成已取消'));
        return;
      }
      if (code === 0 && finalText.trim()) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
            const runUpdated = await tx.contractGenerationRun.updateMany({
              where: runningAttempt,
              data: {
                status: 'succeeded',
                completedAt: new Date(),
                errorMessage: null,
              },
            });
            if (runUpdated.count !== 1) throw new StaleContractCompletionError();
            const projectUpdated = await tx.project.updateMany({
              where: aiProjectVersionWhere(projectId, projectVersion),
              data: {
                status: '待复核',
                result: finalText.trim(),
                updatedAt: nextProjectVersion(projectVersion),
              },
            });
            if (projectUpdated.count !== 1) throw new StaleContractCompletionError();
            // AI 草稿 → ContractDocument(type=draft, version=N)；消息仅供 UI，不是审查数据源
            const document = await this.documentWriter.create(tx, {
              projectId,
              documentType: 'draft',
              content: finalText.trim(),
              createdBy: actor.id,
            });
            await tx.projectMessage.create({
              data: { projectId, role: 'assistant', text: finalText.trim() },
            });
            await tx.contractGenerationRun.update({
              where: { id: generationRunId },
              data: { documentId: document.id },
            });
            await tx.projectEvent.create({
              data: { projectId, text: formatEventTime() + ' · 合同草稿已生成' },
            });
            const pendingCount = (finalText.match(/【待补充】/g) || []).length;
            await tx.projectEvent.create({
              data: {
                projectId,
                text: `本稿共 ${pendingCount} 处【待补充】，需双方确认后填写。本稿由 AI 生成，仅供参考，需经法务审阅后生效。`,
              },
            });
          });
          deferred.resolve({ projectId, generationRunId });
        } catch (err) {
          this.logger.error(`合同草稿未提交：${safeErrorTag(err)}`);
          await this.settleGenerationAttempt(runningAttempt, projectVersion,
            err instanceof StaleContractCompletionError ? 'cancelled' : 'failed',
            err instanceof StaleContractCompletionError ? err.message : '合同草稿写入失败');
          deferred.reject(err);
        }
      } else {
        this.logger.error(`合同草稿生成失败，code=${code}`);
        await this.settleGenerationAttempt(runningAttempt, projectVersion, 'failed', 'AI 合同生成失败或超时');
        deferred.reject(new Error('AI 合同生成失败或超时'));
      }
    });

    return { projectId, stream, generationRunId, completion: deferred.promise };
  }

  /**
   * 生成请求键：显式 idempotencyKey 优先；已有工单无 key 时用模板+要素指纹。
   * 同一 key 只允许一条运行流；不同指纹可以安全生成新 ContractDocument 版本。
   */
  private buildGenerationRequestKey(dto: CreateContractDto, projectId: string, elementsHash: string): string {
    return dto.idempotencyKey
      ? `contract:idempotency:${dto.idempotencyKey}`
      : `contract:project:${projectId}:template:${dto.templateSlug}:elements:${elementsHash}`;
  }

  private assertGenerationPayload(
    run: Pick<ContractGenerationRun, 'projectId' | 'templateSlug' | 'elementsHash'>,
    projectId: string,
    templateSlug: string,
    elementsHash: string,
  ): void {
    if (run.projectId !== projectId || run.templateSlug !== templateSlug || run.elementsHash !== elementsHash) {
      throw new ConflictException('同一生成请求键不能用于不同合同或要素');
    }
  }

  /** 项目行锁保护不同请求键的并发启动；失败重试使用 startedAt 隔离旧执行回调。 */
  private async claimGenerationRun(
    projectId: string,
    requestKey: string,
    templateSlug: string,
    elementsHash: string,
    actor: ProjectActor,
    userMessage?: string,
  ): Promise<{ run: ContractGenerationRun; claimed: boolean; projectVersion: AiProjectVersion }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
      this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, project);
      if (project.kind !== 'contract' || project.route !== 'llm' || project.status === '已取消'
        || project.reviewStatus === 'review_completed') {
        throw new ConflictException('工单当前状态不允许生成合同');
      }
      const previous = await tx.contractGenerationRun.findUnique({ where: { requestKey } });
      if (previous) this.assertGenerationPayload(previous, projectId, templateSlug, elementsHash);
      if (previous && ['queued', 'running', 'succeeded'].includes(previous.status)) {
        return { run: previous, claimed: false, projectVersion: project };
      }
      const active = await tx.contractGenerationRun.findFirst({
        where: { projectId, status: { in: ['queued', 'running'] } },
      });
      if (active) return { run: active, claimed: false, projectVersion: project };

      const startedAt = new Date(Math.max(Date.now(), (previous?.startedAt?.getTime() ?? 0) + 1));
      const data = { status: 'running' as const, startedAt, completedAt: null, errorMessage: null };
      const run = previous
        ? await tx.contractGenerationRun.update({ where: { id: previous.id }, data })
        : await tx.contractGenerationRun.create({ data: { projectId, requestKey, templateSlug, elementsHash, ...data } });
      const updatedAt = nextProjectVersion(project);
      const updated = await tx.project.updateMany({
        where: aiProjectVersionWhere(projectId, project), data: { status: '分析中', isFailed: false, updatedAt },
      });
      if (updated.count !== 1) throw new ConflictException('工单状态已变化，未启动合同生成');
      if (userMessage) {
        await tx.projectMessage.create({ data: { projectId, role: 'user', text: userMessage } });
      }
      return { run, claimed: true, projectVersion: { ...project, status: '分析中' as const, updatedAt } };
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('生成请求键已被其他工单使用');
      }
      throw error;
    });
  }

  /** 错误详情不入业务记录；只更新本次仍拥有的运行和项目版本。 */
  private async settleGenerationAttempt(
    attempt: { id: string; projectId: string; status: 'running'; startedAt: Date | null },
    version: AiProjectVersion,
    status: 'failed' | 'cancelled',
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${attempt.projectId} FOR UPDATE`;
        const updated = await tx.contractGenerationRun.updateMany({
          where: attempt, data: { status, completedAt: new Date(), errorMessage },
        });
        if (updated.count !== 1) return;
        const projectUpdated = await tx.project.updateMany({
          where: aiProjectVersionWhere(attempt.projectId, version),
          data: { status: '待处理', isFailed: status === 'failed', updatedAt: nextProjectVersion(version) },
        });
        if (!projectUpdated.count) {
          await tx.contractGenerationRun.update({
            where: { id: attempt.id },
            data: { status: 'cancelled', errorMessage: '执行上下文已变更，迟到结果未写入' },
          });
        }
      });
    } catch (error) {
      this.logger.error(`合同生成终态写入失败：${safeErrorTag(error)}`);
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
      eventTexts: [formatEventTime() + ' · 已发起法务审阅，已提交法务处理，等待 BP 分配'],
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
    completion: Promise<unknown>;
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
    let projectVersion: AiProjectVersion = project;
    if (skillName) {
      const updatedAt = nextProjectVersion(projectVersion);
      const updated = await this.prisma.project.updateMany({
        where: aiProjectVersionWhere(projectId, projectVersion),
        data: { skillId: skillId ?? null, skillName, updatedAt },
      });
      if (updated.count !== 1) {
        throw new ConflictException('工单状态已变化，未启动 AI 审查');
      }
      projectVersion = { ...projectVersion, updatedAt };
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
        .updateMany({
          where: { id: reviewRun.id, projectId, status: 'running' },
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
    const deferred = createDeferred();

    stream.on('close', async (code) => {
      // dsh 侧权威完整文本（done 事件携带），回退到增量重拼（理论一致，防御分叉）
      const finalText = (stream as any).__finalText ?? fullText;
      if ((stream as any).__cancelled) {
        await this.prisma.contractReviewRun
          .updateMany({
            where: { id: reviewRun.id, projectId, status: 'running' },
            data: { status: 'cancelled', errorMessage: '审查已取消', completedAt: new Date() },
          })
          .catch(() => undefined);
        deferred.reject(new Error('审查已取消'));
        return;
      }
      if (code === 0 && finalText.trim()) {
        try {
          // 风险报告只进 ReviewRun.result（9.3-6）；另写 ProjectMessage 供 UI 展示
          await this.prisma.$transaction(async (tx) => {
            const runUpdated = await tx.contractReviewRun.updateMany({
              where: { id: reviewRun.id, projectId, sourceDocumentId: sourceDoc.id, status: 'running' },
              data: { status: 'succeeded', result: finalText.trim(), completedAt: new Date() },
            });
            if (runUpdated.count !== 1) throw new StaleContractCompletionError();
            const projectUpdated = await tx.project.updateMany({
              where: aiProjectVersionWhere(projectId, projectVersion),
              data: { updatedAt: nextProjectVersion(projectVersion) },
            });
            if (projectUpdated.count !== 1) throw new StaleContractCompletionError();
            await tx.projectMessage.create({
              data: { projectId, role: 'assistant', text: finalText.trim(), label: 'AI 风险审查' },
            });
            await tx.projectEvent.create({
              data: { projectId, text: formatEventTime() + ' · AI 风险审查完成' },
            });
          });
          deferred.resolve({ projectId, reviewRunId: reviewRun.id });
        } catch (err) {
          this.logger.error(`审查结果未提交：${safeErrorTag(err)}`);
          await this.prisma.contractReviewRun.updateMany({
            where: { id: reviewRun.id, projectId, status: 'running' },
            data: {
              status: err instanceof StaleContractCompletionError ? 'cancelled' : 'failed',
              errorMessage: err instanceof StaleContractCompletionError
                ? '执行上下文已变更，迟到结果未写入'
                : '审查结果写入失败',
              completedAt: new Date(),
            },
          }).catch(() => undefined);
          deferred.reject(err);
        }
      } else {
        const errorMessage = (stream as any).__errorMessage
          ? String((stream as any).__errorMessage).slice(0, 200)
          : 'AI 审查失败或超时';
        try {
          await this.prisma.$transaction(async (tx) => {
            const runUpdated = await tx.contractReviewRun.updateMany({
              where: { id: reviewRun.id, projectId, sourceDocumentId: sourceDoc.id, status: 'running' },
              data: { status: 'failed', errorMessage, completedAt: new Date() },
            });
            if (runUpdated.count !== 1) throw new StaleContractCompletionError();
            const projectUpdated = await tx.project.updateMany({
              where: aiProjectVersionWhere(projectId, projectVersion),
              data: { updatedAt: nextProjectVersion(projectVersion) },
            });
            if (projectUpdated.count !== 1) throw new StaleContractCompletionError();
            await tx.projectEvent.create({
              data: { projectId, text: formatEventTime() + ' · AI 风险审查失败，请人工审阅' },
            });
          });
        } catch (err) {
          this.logger.error(`审查失败状态未提交：${safeErrorTag(err)}`);
          await this.prisma.contractReviewRun.updateMany({
            where: { id: reviewRun.id, projectId, status: 'running' },
            data: {
              status: err instanceof StaleContractCompletionError ? 'cancelled' : 'failed',
              errorMessage: err instanceof StaleContractCompletionError
                ? '执行上下文已变更，迟到结果未写入'
                : '审查失败状态写入失败',
              completedAt: new Date(),
            },
          }).catch(() => undefined);
        }
        deferred.reject(new Error('AI 审查失败或超时'));
      }
    });

    return {
      projectId,
      stream,
      reviewRunId: reviewRun.id,
      sourceDocumentId: sourceDoc.id,
      sourceVersion: sourceDoc.version,
      completion: deferred.promise,
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

}


function createDeferred(): {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Service 创建后 controller 才注册等待者；先挂拒绝处理器避免同步 close 形成短暂未处理拒绝。
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class StaleContractCompletionError extends Error {
  constructor() {
    super('执行上下文已变更，迟到结果未写入');
    this.name = 'StaleContractCompletionError';
  }
}
