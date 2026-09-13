import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConsultationAttachmentService } from '../../../common/services/consultation-attachment.service';
import { ConsultationContextBuilder } from './consultation-context-builder';
import { buildSkillSection } from '../../../common/utils/skill-prompt';
import { formatEventTime } from '../../../common/utils/event-time';
import { ConsultationExecutionRouter } from './consultation-execution.router';
import {
  ConsultationCapability,
  ConsultationCapabilityChoice,
  normalizeConsultationCapability,
} from '../domain/consultation-capability';
import { AuditService } from '../../../common/audit/audit.service';
import { createHash } from 'node:crypto';
import { safeErrorTag } from '../../../common/utils/safe-error';
import { ConsultationIntentRouter } from './consultation-intent.router';
import { DSH_SESSION_PREFIX } from '../../../common/services/dsh-runtime';
import {
  AiProjectVersion,
  aiProjectVersionSelect,
  aiProjectVersionWhere,
  nextProjectVersion,
} from '../domain/ai-project-version';

/**
 * 咨询 AI 答复编排器（从 ProjectService 抽出，2026-08-20 上帝类拆分）。
 *
 * 职责：一次"用户消息 → AI 答复"的完整编排——
 *   claimRun()：run 幂等认领（一条 userMessageId 最多一个生成任务，CAS 抢占防并发重复启动）；
 *   reply()：   F4 同工单串行锁 + 上下文构建 + 直连网关流式调用 + 落库/失败回写 + completion 门控。
 *
 * 只做编排，不做消息路由（createMessage 的幂等键/FOR UPDATE/路由切换仍在 ProjectService）。
 * 与 ProjectService 的关系是单向依赖：service 调 orchestrator，orchestrator 不反向依赖 service。
 */
@Injectable()
export class ConsultationReplyOrchestrator {
  private readonly logger = new Logger(ConsultationReplyOrchestrator.name);
  /** F4（2026-08-12 review）：同一 Project 的 AI 严格串行（替代原 Codex 队列 sessionId 语义），
   *  后一问的上下文构建等前一问生成结束后才进行，防止上下文缺前一问答案。单实例内有效。 */
  private readonly projectTurnTails = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly intentRouter: ConsultationIntentRouter,
    private readonly executionRouter: ConsultationExecutionRouter,
    private readonly contextBuilder: ConsultationContextBuilder,
    private readonly config: ConfigService,
    private readonly attachmentService: ConsultationAttachmentService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * 认领/复用咨询运行（2026-08-12）：一条 userMessageId 最多一个生成任务。
   *   succeeded → 返回已有答案；running/queued → 不二次启动；
   *   超 CONSULT_RUN_STALE_MS 的卡死 run 重置重跑；failed/cancelled → 复用同 run 重跑。
   *   P2002（并发同时建）→ 读并发方 run 状态决定返回答案还是等待。
   */
  async claimRun(
    projectId: string,
    userMessageId: string,
    capability: ConsultationCapabilityChoice = 'general',
  ): Promise<{ runId: string; status: 'succeeded' | 'running' | 'new'; answer?: any }> {
    const staleMs =
      Number.parseInt(String(this.config.get('CONSULT_RUN_STALE_MS', '600000')), 10) || 600_000;

    const existing = await this.prisma.consultationRun
      .findUnique({ where: { userMessageId } })
      .catch(() => null);
    if (existing) {
      if (existing.status === 'succeeded') {
        const answer = existing.answerMessageId
          ? await this.prisma.projectMessage
              .findUnique({ where: { id: existing.answerMessageId } })
              .catch(() => null)
          : null;
        return { runId: existing.id, status: 'succeeded', answer: answer ?? undefined };
      }
      if (existing.status === 'running' || existing.status === 'queued') {
        const age = Date.now() - new Date(existing.updatedAt).getTime();
        if (age < staleMs) return { runId: existing.id, status: 'running' };
        // F3-CAS：仅当仍 running 且 updatedAt 依旧过期才抢到（count=1），防并发都重置都启动
        const claimed = await this.prisma.consultationRun
          .updateMany({
            where: {
              id: existing.id,
              status: existing.status,
              updatedAt: { lt: new Date(Date.now() - staleMs) },
            },
            data: { status: 'running', errorMessage: null },
          })
          .catch(() => ({ count: 0 }));
        if (claimed.count !== 1) return { runId: existing.id, status: 'running' }; // 并发方已重置
        this.logger.warn(`run ${existing.id} 卡在 ${existing.status} 超 ${staleMs}ms，重置重跑`);
        return { runId: existing.id, status: 'new' };
      }
      // failed / cancelled：CAS 抢占（仅当状态仍旧是 failed/cancelled 才拿到），防并发重复重跑
      const claimed = await this.prisma.consultationRun
        .updateMany({
          where: { id: existing.id, status: existing.status },
          data: { status: 'running', errorMessage: null },
        })
        .catch(() => ({ count: 0 }));
      if (claimed.count !== 1) return { runId: existing.id, status: 'running' };
      return { runId: existing.id, status: 'new' };
    }

    try {
      const run = await this.prisma.consultationRun.create({
        data: { projectId, userMessageId, status: 'running', capability },
      });
      return { runId: run.id, status: 'new' };
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // 并发方已建 run：读其状态
        const winner = await this.prisma.consultationRun.findUnique({ where: { userMessageId } });
        if (winner?.status === 'succeeded' && winner.answerMessageId) {
          const answer = await this.prisma.projectMessage
            .findUnique({ where: { id: winner.answerMessageId } })
            .catch(() => null);
          return { runId: winner.id, status: 'succeeded', answer: answer ?? undefined };
        }
        return { runId: winner?.id ?? '', status: 'running' };
      }
      throw e;
    }
  }

  /**
   * 触发 AI 生成答复 — 直连网关双路流(思考+内容)，上下文由 ConsultationContextBuilder 从数据库重建。
   * 返回 { stream, completion }：stream 供 sendConsultSSE 推送；completion 在落库成功后 resolve，
   * 前端 message_end 必须等它（P0-4）。调用方（ProjectService.createMessage）负责把结果 spread 进响应。
   */
  async reply(
    projectId: string,
    currentUserMessageId: string,
    signal: AbortSignal | undefined,
    runId: string,
    requestedCapability: ConsultationCapabilityChoice = 'general',
  ): Promise<any> {
    // release 只会删除自己仍是最新 tail 的条目；A 完成时不会误删已经排队的 B/C。
    const finishTurn = await this.acquireProjectTurn(projectId);
    // P0-4（review 2026-08-12）：SSE 的 message_end 必须等落库成功后才发，
    // 避免「前端显示成功 → 落库失败 → 刷新答案消失」。
    let resolveCompletion!: (msg: unknown) => void;
    let rejectCompletion!: (e: unknown) => void;
    const completion = new Promise<unknown>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });
    let child: any;
    let projectVersion!: AiProjectVersion;
    let capability = normalizeConsultationCapability(requestedCapability);
    let modelVersion = capability === 'general'
      ? String(this.config.get('LLM_MODEL', 'glm-5-2'))
      : String(this.config.get('DSH_LLM_MODEL') || this.config.get('LLM_MODEL', 'glm-5-2'));
    try {
      const project = await this.prisma.project
        .findUnique({
          where: { id: projectId },
          select: { extra: true, skillName: true, ...aiProjectVersionSelect },
        });
      if (!project) throw new BadRequestException('工单不存在');
      if (project.route !== 'llm' || project.status === '已取消' || project.reviewStatus === 'review_completed') {
        throw new BadRequestException('工单已进入人工流程，停止 AI 答复');
      }
      projectVersion = project;
      const skillPrompt = (project.extra as any)?.skillPrompt ?? null;
      const skillName = project.skillName;

      const run = await this.prisma.consultationRun.findUnique({ where: { id: runId } });
      capability = normalizeConsultationCapability(run?.capability ?? requestedCapability);
      let context;
      try {
        context = await this.contextBuilder.build({
          projectId,
          currentUserMessageId,
          // 技能段复用共享 util：剥边界标记 + 硬边界模板（防 prompt 注入）
          skillPrompt: skillName && skillPrompt ? buildSkillSection(skillName, skillPrompt) : undefined,
        });
      } catch (e) {
        this.logger.error(`咨询上下文构建失败（${projectId}/${currentUserMessageId}）：${safeErrorTag(e)}`);
        throw new BadRequestException('咨询上下文构建失败，请重试');
      }
      if ((run?.capability ?? requestedCapability) === 'auto') {
        capability = await this.intentRouter.resolve(context.messages, { projectId, runId, signal });
        signal?.throwIfAborted();
        // 分类调用在事务外；只为仍在运行且工单版本未变化的本轮保存选择。
        await this.prisma.$transaction(async (tx) => {
          const nextVersion = nextProjectVersion(projectVersion);
          const projectSaved = await tx.project.updateMany({
            where: aiProjectVersionWhere(projectId, projectVersion),
            data: { updatedAt: nextVersion },
          });
          if (projectSaved.count !== 1) throw new BadRequestException('工单状态已变化，请刷新后重试');
          const saved = await tx.consultationRun.updateMany({
            where: {
              id: runId, projectId, userMessageId: currentUserMessageId, status: 'running', capability: 'auto',
            },
            data: { capability },
          });
          if (saved.count !== 1) throw new BadRequestException('工单或运行状态已变化，请刷新后重试');
          const label = { general: '通用法务咨询', law_search: 'AI 搜法', similar_case: 'AI 类案' }[capability];
          await tx.projectEvent.create({ data: { projectId, text: formatEventTime() + ' · 已按问题意图选择：' + label } });
          projectVersion = { ...projectVersion, updatedAt: nextVersion };
        });
      }
      modelVersion = capability === 'general'
        ? String(this.config.get('LLM_MODEL', 'glm-5-2'))
        : String(this.config.get('DSH_LLM_MODEL') || this.config.get('LLM_MODEL', 'glm-5-2'));
      const previous = capability === 'general'
        ? null
        : await this.prisma.consultationRun.findFirst({
            where: {
              projectId,
              capability,
              status: 'succeeded',
              dshSessionId: { startsWith: DSH_SESSION_PREFIX },
              id: { not: runId },
            },
            orderBy: { completedAt: 'desc' },
            select: { dshSessionId: true },
          });
      if (this.audit) {
        await this.audit.record({
          actor: { type: 'system' },
          action: 'ai.run.started',
          resourceType: 'consultation_run',
          resourceId: runId,
          projectId,
          source: capability === 'general' ? 'api' : 'dsh',
          outcome: 'success',
          correlationId: runId,
          metadata: { capability, modelVersion, userMessageId: currentUserMessageId },
          retentionClass: 'ai',
        });
      }
      child = await this.executionRouter.execute({
        capability,
        messages: context.messages,
        projectId,
        runId,
        signal,
        resumeDshSessionId: previous?.dshSessionId ?? undefined,
      });
    } catch (e) {
      await this.failRunBeforeStream(
        projectId,
        runId,
        capability,
        modelVersion,
        e instanceof Error ? e.message : String(e),
      );
      finishTurn();
      throw e;
    }

    // P0-3：流式协议身份——一次 Run 一个稳定 runId，SSE 事件据此去重/丢弃过期
    child.__runId = runId;
    child.__capability = capability;

    let fullText = '';
    let finalized = false;
    const beginFinalize = () => {
      if (finalized) return false;
      finalized = true;
      return true;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      fullText += chunk.toString();
    });

    // P0（review 2026-08-12）：单个结束处理器——先落库/更新 Run，最后才释放同 Project 串行锁，
    // 否则下一轮上下文构建可能发生在上一轮答案入库之前。
    child.once('close', async (code) => {
      if (!beginFinalize()) return;
      try {
        // 连接断开主动取消 → 不写失败状态（刷新 ≠ 生成失败）；run 标记 cancelled 以便重试
        if ((child as any).__cancelled) {
          await this.prisma.$transaction(async (tx) => {
            const updated = await tx.consultationRun.updateMany({
              where: { id: runId, projectId, userMessageId: currentUserMessageId, status: 'running' },
              data: { status: 'cancelled', completedAt: new Date() },
            });
            if (updated.count === 1 && this.audit) {
                await this.audit.record({
                  actor: { type: 'system' },
                  action: 'ai.run.cancelled',
                  resourceType: 'consultation_run',
                  resourceId: runId,
                  projectId,
                  source: capability === 'general' ? 'api' : 'dsh',
                  outcome: 'success',
                  correlationId: runId,
                  metadata: { capability, modelVersion },
                  retentionClass: 'ai',
                }, tx);
            }
          }).catch((error) => this.logger.error(`AI 取消状态/审计写入失败：${safeErrorTag(error)}`));
          rejectCompletion(new Error('cancelled'));
          return;
        }
        // 权威文本优先用网关 content 增量累计（__finalText），流式累计仅兜底
        const finalText = String((child as any).__finalText ?? fullText).trim();
        if (code === 0 && finalText) {
          try {
            const answerMessageId = crypto.randomUUID();
            const outputHash = this.audit?.digestCanonical(finalText)
              ?? createHash('sha256').update(finalText).digest('hex');
            const toolSummary = buildToolSummary(child.__researchTrace);
            const msg = await this.prisma.$transaction(async (tx) => {
              const runUpdated = await tx.consultationRun.updateMany({
                where: { id: runId, projectId, userMessageId: currentUserMessageId, status: 'running' },
                data: {
                  status: 'succeeded',
                  answerMessageId,
                  completedAt: new Date(),
                  modelVersion,
                  toolSummary,
                  outputHash,
                  ...(child.__researchTrace ? {
                    dshSessionId: child.__researchTrace.dshSessionId,
                    researchTrace: child.__researchTrace,
                  } : {}),
                },
              });
              if (runUpdated.count !== 1) throw new StaleAiCompletionError();
              const projectUpdated = await tx.project.updateMany({
                where: aiProjectVersionWhere(projectId, projectVersion),
                data: {
                  status: '已回传',
                  result: finalText,
                  updatedAt: nextProjectVersion(projectVersion),
                },
              });
              if (projectUpdated.count !== 1) throw new StaleAiCompletionError();
              const created = await tx.projectMessage.create({
                data: { id: answerMessageId, projectId, role: 'assistant', text: finalText },
              });
              await tx.projectEvent.create({
                data: { projectId, text: formatEventTime() + ' · AI 答复已完成' },
              });
              if (this.audit) {
                const degraded = child.__researchDegraded as { level?: string; reasonCode?: string } | undefined;
                await this.audit.record({
                  actor: { type: 'system' },
                  action: degraded ? 'ai.run.degraded' : 'ai.run.succeeded',
                  resourceType: 'consultation_run',
                  resourceId: runId,
                  projectId,
                  source: capability === 'general' ? 'api' : 'dsh',
                  outcome: degraded ? 'partial' : 'success',
                  reasonCode: degraded?.reasonCode ?? null,
                  correlationId: child.__researchTrace?.dshSessionId ?? runId,
                  after: { status: 'succeeded', answerMessageId, modelVersion, toolSummary, outputHash },
                  metadata: {
                    capability,
                    modelVersion,
                    toolSummary,
                    outputHash,
                    answerMessageId,
                    dshSessionId: child.__researchTrace?.dshSessionId ?? null,
                    ...(degraded ? { fallbackLevel: degraded.level ?? null } : {}),
                  },
                  retentionClass: 'ai',
                }, tx);
              }
              return created;
            });
            resolveCompletion({
              ...msg,
              ...(child.__researchTrace ? {
                research: { capability: child.__researchTrace.capability, trace: child.__researchTrace },
              } : {}),
            }); // P0-4：落库成功 → 前端可收到 message_end
          } catch (err) {
            this.logger.error(`AI 答复未提交：${safeErrorTag(err)}`);
            rejectCompletion(err);
            await this.settleRunAfterPersistenceError(
              projectId,
              runId,
              currentUserMessageId,
              err,
              'AI 答复写入失败',
            );
            await this.recordAiOutcome(
              'ai.run.failed',
              'failed',
              projectId,
              runId,
              capability,
              modelVersion,
              err instanceof StaleAiCompletionError ? 'STALE_AI_COMPLETION' : 'AI_PERSIST_FAILED',
            );
          }
        } else {
          const publicMessage = child.__errorMessage ?? `AI 答复生成失败（code=${code}）`;
          this.logger.error(`咨询执行流异常退出，code=${code} ${safeErrorTag({
            name: 'ExecutionError',
            code: child.__errorCode ?? 'unknown',
          })}`);
          rejectCompletion(new Error(publicMessage));
          try {
            await this.persistFailure(
              projectId,
              runId,
              currentUserMessageId,
              publicMessage,
              String(child.__errorCode ?? '').startsWith('RESEARCH_'),
              projectVersion,
            );
            await this.recordAiOutcome(
              'ai.run.failed',
              'failed',
              projectId,
              runId,
              capability,
              modelVersion,
              child.__errorCode ?? 'AI_EXECUTION_FAILED',
            );
          } catch (err) {
            this.logger.error(`失败状态更新失败：${safeErrorTag(err)}`);
            await this.settleRunAfterPersistenceError(
              projectId,
              runId,
              currentUserMessageId,
              err,
              'AI 失败状态写入失败',
            );
          }
        }
      } catch (error) {
        // EventEmitter 不观察 async 监听器的 Promise，终态写入失败必须在此收口。
        rejectCompletion(error);
        this.logger.error(`AI 完成状态/审计写入失败：${safeErrorTag(error)}`);
      } finally {
        // 串行锁必须在落库完成后才释放，并清理 Map 条目（防长期增长）
        finishTurn();
      }
    });

    child.once('error', async (err) => {
      if (!beginFinalize()) return;
      this.logger.error(`咨询网关流错误：${safeErrorTag(err)}`);
      rejectCompletion(err);
      try {
        await this.persistFailure(
          projectId,
          runId,
          currentUserMessageId,
          'AI 服务不可用',
          false,
          projectVersion,
        );
        await this.recordAiOutcome('ai.run.failed', 'failed', projectId, runId, capability, modelVersion);
      } catch (dbErr) {
        this.logger.error(`失败状态更新失败：${safeErrorTag(dbErr)}`);
        await this.settleRunAfterPersistenceError(
          projectId,
          runId,
          currentUserMessageId,
          dbErr,
          'AI 失败状态写入失败',
        );
      } finally {
        finishTurn();
      }
    });

    // P0-4：completion 供 sendConsultSSE 门控 message_end（落库成功才发）
    return { stream: child, completion };
  }

  /** F4：同一 Project 的 AI 严格串行（单实例）；锁在 stream close 时释放 */
  private async acquireProjectTurn(projectId: string): Promise<() => void> {
    const prev = this.projectTurnTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    const gate = prev.catch(() => undefined).then(() => undefined);
    const currentTail = gate.then(() => tail).catch(() => tail);
    this.projectTurnTails.set(projectId, currentTail);
    await gate;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.projectTurnTails.get(projectId) === currentTail) {
        this.projectTurnTails.delete(projectId);
      }
    };
  }

  private async persistFailure(
    projectId: string,
    runId: string,
    userMessageId: string,
    publicMessage: string,
    researchOnly: boolean,
    projectVersion: AiProjectVersion,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const runUpdated = await tx.consultationRun.updateMany({
        where: { id: runId, projectId, userMessageId, status: 'running' },
        data: { status: 'failed', errorMessage: publicMessage.slice(0, 500), completedAt: new Date() },
      });
      if (runUpdated.count !== 1) throw new StaleAiCompletionError();
      const projectUpdated = researchOnly
        ? await tx.project.updateMany({
            where: aiProjectVersionWhere(projectId, projectVersion),
            data: { updatedAt: nextProjectVersion(projectVersion) },
          })
        : await tx.project.updateMany({
            where: aiProjectVersionWhere(projectId, projectVersion),
            data: {
              status: '待处理',
              isFailed: true,
              updatedAt: nextProjectVersion(projectVersion),
            },
          });
      if (projectUpdated.count !== 1) throw new StaleAiCompletionError();
      await tx.projectEvent.create({
        data: {
          projectId,
          text: researchOnly
            ? formatEventTime() + ' · 法律检索失败，等待用户重试或切换能力'
            : formatEventTime() + ' · AI 服务不可用，已转人工处理',
        },
      });
    });
  }

  private async settleRunAfterPersistenceError(
    projectId: string,
    runId: string,
    userMessageId: string,
    error: unknown,
    failureMessage: string,
  ): Promise<void> {
    const stale = error instanceof StaleAiCompletionError;
    await this.prisma.consultationRun.updateMany({
      where: { id: runId, projectId, userMessageId, status: 'running' },
      data: {
        status: stale ? 'cancelled' : 'failed',
        errorMessage: stale ? '执行上下文已变更，迟到结果未写入' : failureMessage,
        completedAt: new Date(),
      },
    }).catch(() => undefined);
  }

  /** 风险分级输入：附上受限长度的附件正文（review 2026-08-12 P1-4），防「请审查附件」被路由为普通 P2 */
  async buildRiskInput(text: string, attachmentIds: string[] | undefined): Promise<string> {
    if (!attachmentIds?.length) return text;
    const texts = await this.attachmentService.getTexts(attachmentIds).catch(() => [] as string[]);
    if (!texts.length) return text;
    return `${text}\n\n【附件内容摘要】\n${texts.join('\n').slice(0, 2000)}`;
  }

  /** 添加事件 */
  private async addEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({
      data: { projectId, text },
    });
  }

  private async recordAiOutcome(
    action: string,
    outcome: 'failed' | 'success',
    projectId: string,
    runId: string | undefined,
    capability: ConsultationCapability,
    modelVersion: string,
    reasonCode = 'AI_EXECUTION_FAILED',
  ) {
    if (!runId || !this.audit) return;
    await this.audit.record({
      actor: { type: 'system' },
      action,
      resourceType: 'consultation_run',
      resourceId: runId,
      projectId,
      source: capability === 'general' ? 'api' : 'dsh',
      outcome,
      reasonCode: outcome === 'failed' ? reasonCode : null,
      correlationId: runId,
      metadata: {
        capability,
        modelVersion,
      },
      retentionClass: 'ai',
    });
  }

  private async failRunBeforeStream(
    projectId: string,
    runId: string | undefined,
    capability: ConsultationCapability,
    modelVersion: string,
    reason: string,
  ) {
    if (!runId) return;
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.consultationRun.updateMany({
        where: { id: runId, projectId, status: 'running' },
        data: { status: 'failed', errorMessage: reason.slice(0, 500), completedAt: new Date(), modelVersion },
      });
      if (updated.count === 1 && this.audit) {
        await this.audit.record({
          actor: { type: 'system' },
          action: 'ai.run.failed',
          resourceType: 'consultation_run',
          resourceId: runId,
          projectId,
          source: capability === 'general' ? 'api' : 'dsh',
          outcome: 'failed',
          reasonCode: 'AI_START_FAILED',
          correlationId: runId,
          metadata: {
            capability,
            modelVersion,
            phase: 'startup',
          },
          retentionClass: 'ai',
        }, tx);
      }
    }).catch((error) => this.logger.error(`AI 启动失败终态/审计写入失败：${safeErrorTag(error)}`));
  }

}

function buildToolSummary(trace: any): Array<{ tool: string; recordCount: number }> {
  if (!trace?.calls || !Array.isArray(trace.calls)) return [];
  return trace.calls.slice(0, 5).map((call: any) => ({
    tool: String(call?.tool ?? '').slice(0, 80),
    recordCount: Array.isArray(call?.recordIds) ? call.recordIds.length : 0,
  }));
}

class StaleAiCompletionError extends Error {
  constructor() {
    super('执行上下文已变更，迟到结果未写入');
    this.name = 'StaleAiCompletionError';
  }
}
