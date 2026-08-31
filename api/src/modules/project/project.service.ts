import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConsultationAttachmentService } from '../../common/services/consultation-attachment.service';
import { LLMRiskService } from '../../common/services/llm-risk.service';
import {
  DingTalkAdapter,
  DINGTALK_ADAPTER,
} from './adapters/adapter.interfaces';
import { CreateProjectDto, CreateProjectMessageDto, ReplyProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Prisma, Role } from '@prisma/client';
import { ConsultationReplyOrchestrator } from './application/consultation-reply.orchestrator';
import { formatEventTime } from '../../common/utils/event-time';
import { ProjectAccessPolicy } from './domain/project-access.policy';
import { ProjectAction, ProjectActor } from './domain/project-access.types';
import {
  CreateProjectUseCase,
  dingtalkMemberOutboxDedupKey,
  OUTBOX_EVENT_DINGTALK_MEMBER_ADD,
} from './application/create-project.use-case';
import { ProjectListParams, ProjectQueryService } from './queries/project-query.service';
import { ProjectStateMachine } from './domain/project-state-machine';
import { ClaimProjectUseCase } from './application/claim-project.use-case';
import { EscalateProjectToLegalUseCase } from './application/escalate-project-to-legal.use-case';
import { normalizeConsultationCapability } from './domain/consultation-capability';
import { AuditService } from '../../common/audit/audit.service';
import { AuditRequestContext } from '../../common/audit/audit.types';
import { RecordDownloadDto } from './dto/record-download.dto';
import {
  crmReviewDeliveryOutboxDedupKey,
  OUTBOX_EVENT_CRM_REVIEW_RESULT_DELIVER,
} from './application/crm-delivery';

// 用户选择器，避免暴露密码哈希
const userSelect = { id: true, username: true, displayName: true, role: true };

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly riskService: LLMRiskService,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    private readonly createProjectUseCase: CreateProjectUseCase,
    private readonly accessPolicy: ProjectAccessPolicy,
    private readonly query: ProjectQueryService,
    private readonly stateMachine: ProjectStateMachine,
    private readonly claimProject: ClaimProjectUseCase,
    private readonly escalateToLegal: EscalateProjectToLegalUseCase,
    private readonly replyOrchestrator: ConsultationReplyOrchestrator,
    private readonly attachmentService: ConsultationAttachmentService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  // ═══════════════════════════════════════════
  // 工单 CRUD
  // ═══════════════════════════════════════════

  /** 创建工单 — 事务化（项目/首消息/事件/Outbox 同事务，P1-03），钉钉建群交由 Outbox Worker */
  async create(dto: CreateProjectDto, currentUserId: string) {
    // 幂等重试必须在风险模型、技能解析和 BP 匹配前短路；否则网络重试
    // 虽然不会重复建单，却会重复消耗模型额度并触发不必要的查询。
    if (dto.idempotencyKey) {
      const existing = await this.createProjectUseCase.findExistingByIdempotencyKey(
        dto.idempotencyKey,
        currentUserId,
      );
      if (existing) return this.formatProject(existing);
    }

    // 0.5 附件校验（归属/状态/过期；绑定在工单创建后执行）
    if (dto.attachmentIds?.length) {
      await this.attachmentService.validateForUser(dto.attachmentIds, currentUserId);
    }

    // 1. 风险判定 + 领域标签（事务前：外部 LLM 调用；P1-11 带回规则下限证据）
    //    附件参与分级（受限正文），避免「请审查附件」因附件有诉讼/违约却路由为普通 P2
    const riskInput = await this.replyOrchestrator.buildRiskInput(dto.input, dto.attachmentIds);
    const { risk, route, domain, evidence } = await this.riskService.assess(riskInput);

    // 1.5 技能服务端解析（仅解析 active 的公有技能或创建者自己的私有技能）
    let skillId: string | null = null;
    let skillName: string | null = null;
    let skillGroup: string | null = null;
    let skillPrompt: string | null = null;
    if (dto.skillId) {
      const skill = await this.prisma.skill
        .findFirst({
          where: {
            id: dto.skillId,
            isActive: true,
            OR: [{ visibility: 'public' }, { creatorId: currentUserId, visibility: 'private' }],
          },
        })
        .catch((e) => {
          this.logger.warn(`技能解析查询失败（按无技能处理）：${e}`);
          return null;
        });
      if (skill) {
        skillId = skill.id;
        skillName = skill.name;
        skillGroup = skill.group;
        skillPrompt = skill.prompt;
      } else {
        this.logger.warn(`skillId=${dto.skillId} 解析失败（不存在/停用/无权），工单按无技能处理`);
      }
    }

    // 1.6 领域解析 + BP 匹配（仅 legalbp 路由拉群）
    let legalBpId: string | null = null;
    if (route === 'legalbp') {
      const effectiveDomain = skillGroup ?? domain ?? null;
      legalBpId = await this.matchLegalBp(effectiveDomain);
    }

    // 2. 事件文案（事务内写入）
    const events: string[] = [];
    if (dto.skillId && !skillId) {
      events.push(formatEventTime() + ' · 所选技能不可用，已按通用口径答复');
    }
    events.push(formatEventTime() + ' · 工单已创建');
    events.push(
      formatEventTime() +
        ` · 系统判定 ${risk} 风险${route === 'llm' ? '，AI 正在生成答复…' : legalBpId ? '，已提交法务 BP 处理' : '，等待法务 BP 分配'}`,
    );

    // 3. 事务创建（幂等由 use case 处理：同一幂等键返回旧工单前校验创建者一致）
    const { project } = await this.createProjectUseCase.execute({
      kind: dto.kind,
      title: dto.title,
      input: dto.input,
      creatorId: currentUserId,
      risk,
      route,
      legalBpId,
      // P1-11：分类证据随事务写入 RiskAssessmentLog（审计可追溯）
      ...(evidence
        ? {
            riskLog: {
              finalRisk: risk,
              route,
              domain,
              ruleFloor: evidence.ruleFloor,
              matchedRuleIds: evidence.matchedRuleIds,
              modelRisk: evidence.modelRisk,
              modelReason: evidence.modelReason,
              classifierVersion: evidence.classifierVersion,
            },
          }
        : {}),
      skillId,
      skillName,
      requesterName: dto.requesterName ?? null,
      requesterDepartment: dto.requesterDepartment ?? null,
      crmReference: dto.crmReference ?? null,
      idempotencyKey: dto.idempotencyKey ?? null,
      extra: skillPrompt ? { skillPrompt } : null,
      events,
      enqueueDingtalkGroup: route === 'legalbp',
      attachmentIds: dto.attachmentIds,
    });

    // 3.5 附件绑定到工单（首次使用才写 projectId）
    if (dto.attachmentIds?.length) {
      await this.attachmentService.bind(dto.attachmentIds, project.id);
    }

    // 4. 首条消息已由建单落库；不再在此自动触发 AI —— 前端随后用 firstReply=true 启动首轮回答，
    //    避免「同一问题触发两次 AI、存两条用户消息」（review 2026-08-11 P0 双重提交）。
    return this.formatProject(project);
  }

  /** 工单响应脱敏：extra（技能 prompt 快照）不返回；route/risk 冗余展开 */
  private formatProject(project: any) {
    const {
      extra: _extra,
      crmDeliveryLastError: _crmDeliveryLastError,
      crmPayloadSha256: _crmPayloadSha256,
      crmFileManifestSha256: _crmFileManifestSha256,
      ...safeProject
    } = project;
    return { ...safeProject, route: project.route, risk: project.risk };
  }

  /**
   * 工单列表 — 由服务端根据 actor 生成查询范围（P1-01 5.3.4），
   * 禁止客户端提交任意 creatorId/ownerId/legalBpId 绕过范围。
   */
  async findAll(actor: ProjectActor, params: ProjectListParams) {
    return this.query.findAll(actor, params);
  }

  /** 工单详情 — 委派 ProjectQueryService（P2-01） */
  async findOne(id: string, actor: ProjectActor) {
    return this.query.findOne(id, actor);
  }

  /** 更新工单（状态/风险/结果）— 法务 BP 仅可改已指派给自己工单的状态/风险/结果字段 */
  async update(id: string, dto: UpdateProjectDto, actor: ProjectActor, request?: AuditRequestContext) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Update, project);

    // 字段受限（5.2 权限矩阵）：legal_bp 只能更新状态/风险/结果，不能改指派/路由（转派属 lead/admin）
    if (actor.role === 'legal_bp') {
      const restricted = (['ownerId', 'legalBpId', 'route'] as const).filter(
        (f) => (dto as any)[f] !== undefined,
      );
      if (restricted.length) {
        throw new ForbiddenException('法务 BP 无权修改指派或路由字段');
      }
    }

    // 目标 BP 角色校验（lead/admin 转派路径；工程评审决策 #3）
    if (dto.legalBpId) {
      const bp = await this.prisma.user.findUnique({ where: { id: dto.legalBpId } });
      if (!bp || (bp.role !== 'legal_bp' && bp.role !== 'legal_lead')) {
        throw new ForbiddenException('目标用户不是法务 BP');
      }
    }

    // P2-01 状态机：非法状态迁移(PATCH 直接赋值)返回 409,不静默覆盖
    if (dto.status && dto.status !== project.status && !this.stateMachine.canTransition(project.status, dto.status)) {
      throw new ConflictException(`非法状态迁移: ${project.status} → ${dto.status}`);
    }

    // llm → legalbp 也是法务升级入口，必须复用统一用例，不能先改 route
    // 再分步匹配/入队，否则会绕过升级事务和 BP 匹配边界。
    if (dto.route === 'legalbp' && project.route === 'llm') {
      await this.escalateToLegal.execute({
        projectId: id,
        route: 'legalbp',
        status: dto.status,
        risk: dto.risk,
        result: dto.result,
        legalBpId: dto.legalBpId ?? undefined,
        ownerId: dto.ownerId ?? undefined,
        eventTexts: [formatEventTime() + ' · 工单已升级人工处理，等待 BP 分配'],
      });
      const escalated = await this.prisma.project.findUnique({
        where: { id },
        include: {
          creator: { select: userSelect },
          owner: { select: userSelect },
          legalBp: { select: userSelect },
        },
      });
      if (!escalated) throw new NotFoundException('工单不存在');
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'project.escalate',
          resourceType: 'project',
          resourceId: id,
          projectId: id,
          source: 'web',
          outcome: 'success',
          request,
          before: projectAuditSnapshot(project),
          after: projectAuditSnapshot(escalated),
          changes: projectChanges(project, escalated, this.audit) as Prisma.InputJsonValue,
          retentionClass: 'business',
        });
      }
      return escalated;
    }

    const updateData = {
      ...(dto.status && { status: dto.status }),
      ...(dto.risk && { risk: dto.risk }),
      ...(dto.ownerId && { ownerId: dto.ownerId }),
      ...(dto.legalBpId && { legalBpId: dto.legalBpId }),
      ...(dto.route && { route: dto.route }),
      ...(dto.result && { result: dto.result }),
    };
    const { result: updated, previousLegalBpId } = await this.prisma.$transaction(async (tx) => {
      const before = await this.lockProjectForAudit(tx, id, project);
      this.accessPolicy.assertCan(actor, ProjectAction.Update, before);
      if (dto.status && dto.status !== before.status && !this.stateMachine.canTransition(before.status, dto.status)) {
        throw new ConflictException(`非法状态迁移: ${before.status} → ${dto.status}`);
      }
      const guardedWhere: Prisma.ProjectWhereInput = {
        id,
        // 锁定后的状态是审计 before 和并发更新的共同基准。
        ...(dto.status && { status: before.status }),
      };
      if (actor.role === 'legal_bp') {
        guardedWhere.OR = [{ legalBpId: actor.id }, { ownerId: actor.id }];
      }
      const updatedCount = await tx.project.updateMany({ where: guardedWhere, data: updateData });
      if (updatedCount.count === 0) {
        throw actor.role === 'legal_bp'
          ? new ForbiddenException('工单指派已变化，无法更新')
          : new ConflictException('工单状态已变化，请刷新后重试');
      }
      const result = await tx.project.findUnique({
        where: { id },
        include: {
          creator: { select: userSelect },
          owner: { select: userSelect },
          legalBp: { select: userSelect },
        },
      });
      if (!result) throw new NotFoundException('工单不存在');
      if (this.audit) {
        const assignmentChanged = before.legalBpId !== result.legalBpId || before.ownerId !== result.ownerId;
        await this.audit.record({
          actor,
          action: assignmentChanged ? 'project.transfer' : 'project.update',
          resourceType: 'project',
          resourceId: id,
          projectId: id,
          source: 'web',
          outcome: 'success',
          request,
          before: projectAuditSnapshot(before),
          after: projectAuditSnapshot(result),
          changes: projectChanges(before, result, this.audit) as Prisma.InputJsonValue,
          retentionClass: 'business',
        }, tx);
      }
      return { result, previousLegalBpId: before.legalBpId };
    });

    // 钉钉联动：
    // - legalBpId 变更 → 新 BP 进群（异步，不阻塞 PATCH 响应）
    if (dto.legalBpId && dto.legalBpId !== previousLegalBpId) {
      void this.onLegalBpChanged(id, dto.legalBpId, previousLegalBpId).catch((e) =>
        this.logger.error(`转派加群失败（${id}）：${e}`),
      );
    }
    return updated;
  }

  /** 认领未分配工单（P1-01 5.3.9）：原子条件更新，count=0 时重读判断是被认领还是不存在 */
  /** 认领 — 委派 ClaimProjectUseCase（P2-01） */
  claim(id: string, actor: ProjectActor) {
    return this.claimProject.execute(id, actor);
  }

  /** 取消工单 — 原子条件更新 + 对象级授权（business 仅创建者且未完成；legal_bp 禁止） */
  async cancel(id: string, actor: ProjectActor, request?: AuditRequestContext) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Cancel, project);

    const where: Prisma.ProjectWhereInput = { id, status: { notIn: ['已取消', '已回传'] } };
    if (actor.role === 'business') where.creatorId = actor.id;

    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockProjectForAudit(tx, id, project);
      this.accessPolicy.assertCan(actor, ProjectAction.Cancel, before);
      const updated = await tx.project.updateMany({ where, data: { status: '已取消' } });
      if (updated.count === 0) {
        throw new ForbiddenException('只能取消自己创建的、未完成或未取消的工单');
      }
      await tx.projectEvent.create({ data: { projectId: id, text: formatEventTime() + ' · 工单已取消' } });
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'project.cancel',
          resourceType: 'project',
          resourceId: id,
          projectId: id,
          source: 'web',
          outcome: 'success',
          request,
          before: projectAuditSnapshot(before),
          after: { ...projectAuditSnapshot(before), status: '已取消' },
          changes: { status: { from: before.status, to: '已取消' } },
          retentionClass: 'business',
        }, tx);
      }
    });

    return { status: '已取消' };
  }

  /** 转派给另一个法务 BP（仅 legal_lead/admin，P1-01 5.2；新 BP 自动进群，旧 BP 留群） */
  async transfer(id: string, legalBpId: string, actor: ProjectActor, request?: AuditRequestContext) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Transfer, project);

    const bp = await this.prisma.user.findUnique({ where: { id: legalBpId } });
    if (!bp || (bp.role !== 'legal_bp' && bp.role !== 'legal_lead')) {
      throw new ForbiddenException('目标用户不是法务 BP');
    }

    const { result: updated, before } = await this.prisma.$transaction(async (tx) => {
      const before = await this.lockProjectForAudit(tx, id, project);
      this.accessPolicy.assertCan(actor, ProjectAction.Transfer, before);
      const result = await tx.project.update({
        where: { id },
        data: { legalBpId, ownerId: legalBpId },
        include: {
          creator: { select: userSelect },
          owner: { select: userSelect },
          legalBp: { select: userSelect },
        },
      });
      await tx.projectEvent.create({ data: { projectId: id, text: formatEventTime() + ` · 工单已转派给 ${bp.displayName}` } });
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'project.transfer',
          resourceType: 'project',
          resourceId: id,
          projectId: id,
          source: 'web',
          outcome: 'success',
          request,
          before: projectAuditSnapshot(before),
          after: projectAuditSnapshot(result),
          changes: {
            legalBpId: { from: before.legalBpId, to: legalBpId },
            ownerId: { from: before.ownerId, to: legalBpId },
          },
          retentionClass: 'business',
        }, tx);
      }
      return { result, before };
    });

    // 钉钉：新 BP 加群改由 Outbox Worker 执行，HTTP 请求只提交本地事件。
    await this.onLegalBpChanged(id, legalBpId, before.legalBpId);
    try {
      if (before.dingtalkChatId) {
        await this.dingtalk.sendNotification(
          before.dingtalkChatId,
          `工单已转派给 ${bp.displayName}`,
        );
      }
    } catch (e) {
      this.logger.warn(`钉钉通知失败：${e}`);
    }

    return updated;
  }

  /** 用户申请升级人工处理（2026-08-12 review P0）：独立接口，复用 EscalateProjectToLegalUseCase。
   *   business 仅能升级自己创建且未取消的工单；lead/admin 全部。
   *   不启动模型、不新增用户消息、不创建 ConsultationRun；重复点击幂等返回 200。 */
  async escalate(projectId: string, actor: ProjectActor, request?: AuditRequestContext) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Escalate, project);
    if (project.status === '已取消') throw new ForbiddenException('已取消的工单不能升级');

    // 已是法务流程：幂等返回 200，不重复写事件/建群
    if (project.route === 'legalbp') {
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'project.escalate',
          resourceType: 'project',
          resourceId: projectId,
          projectId,
          source: 'web',
          outcome: 'success',
          request,
          before: projectAuditSnapshot(project),
          after: projectAuditSnapshot(project),
          metadata: { idempotent: true },
          retentionClass: 'business',
        });
      }
      return { upgraded: false, route: 'legalbp', status: project.status };
    }

    await this.escalateToLegal.execute({
      projectId,
      route: 'legalbp',
      status: '待复核',
      domain: null,
      eventTexts: [formatEventTime() + ' · 用户申请升级为人工处理，已通知法务 BP'],
    });

    if (this.audit) {
      const updated = await this.prisma.project.findUnique({ where: { id: projectId } });
      await this.audit.record({
        actor,
        action: 'project.escalate',
        resourceType: 'project',
        resourceId: projectId,
        projectId,
        source: 'web',
        outcome: 'success',
        request,
        before: projectAuditSnapshot(project),
        after: updated ? projectAuditSnapshot(updated) : { route: 'legalbp', status: '待复核' },
        changes: { route: { from: project.route, to: 'legalbp' }, status: { from: project.status, to: '待复核' } },
        retentionClass: 'business',
      });
    }

    return { upgraded: true, route: 'legalbp', status: '待复核' };
  }

  // ═══════════════════════════════════════════
  // 消息流
  // ═══════════════════════════════════════════

  /**
   * 发送消息 — 先鉴权（P1-01 5.3.6）再创建；消息 role 由服务端根据 actor 派生，
   * 不接受客户端伪造的 role（AI 消息只能由内部 AI 完成回调创建）。
   */
  async createMessage(
    projectId: string,
    dto: CreateProjectMessageDto,
    actor: ProjectActor,
    signal?: AbortSignal,
  ): Promise<{ message: any; stream?: any; route: string; status?: 'succeeded' | 'running'; completion?: Promise<unknown> }> {
    const role = actor.role === 'business' ? 'user' : 'legal';
    const capability = normalizeConsultationCapability(dto.capability);

    // 统一前置：加载工单 + 鉴权（F5：幂等快捷返回也须过鉴权；idempotencyKey 不是访问凭证）
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, project);

    // 0. 首轮回答（review 2026-08-11 P0/P1）：首条消息已在建单时落库。
    //    只启动首轮 AI 回答；ConsultationRun(userMessageId 唯一) 兜并发幂等。
    if (dto.firstReply) {
      if (project.route !== 'llm') {
        return { message: null, route: project.route };
      }
      const first = await this.prisma.projectMessage.findFirst({
        where: { projectId, role: 'user' },
        orderBy: { createdAt: 'asc' },
      });
      if (!first) throw new BadRequestException('工单没有首条消息');

      const claimed = await this.replyOrchestrator.claimRun(projectId, first.id, capability);
      if (claimed.status === 'succeeded' && claimed.answer) {
        return { message: claimed.answer, route: 'llm', status: 'succeeded' };
      }
      if (claimed.status === 'running') {
        return { message: first, route: 'llm', status: 'running' }; // 已在跑,不再启动第二个
      }
      return {
        message: first,
        route: 'llm',
        ...(await this.replyOrchestrator.reply(projectId, first.id, signal, claimed.runId, capability)),
      };
    }

    // 0.5 客户端幂等键去重（2026-08-12）：同 key 已建消息 → 复用其结果/等待，
    //     防双重提交、网络重试产生重复消息与重复 AI 回答。
    if (dto.idempotencyKey) {
      const existing = await this.prisma.projectMessage
        .findUnique({ where: { clientKey: dto.idempotencyKey } })
        .catch(() => null);
      if (existing && existing.projectId === projectId) {
        // F5：工单已升级/非 llm → 不重触发 AI
        if (project.route !== 'llm') {
          return { message: existing, route: project.route };
        }
        const claimed = await this.replyOrchestrator.claimRun(projectId, existing.id, capability);
        if (claimed.status === 'succeeded' && claimed.answer) {
          return { message: claimed.answer, route: 'llm', status: 'succeeded' };
        }
        if (claimed.status === 'running') {
          return { message: existing, route: 'llm', status: 'running' };
        }
        // 无 run / 失败 / 已取消：重新回答该消息（不重复建消息）
        return {
          message: existing,
          route: 'llm',
          ...(await this.replyOrchestrator.reply(projectId, existing.id, signal, claimed.runId, capability)),
        };
      }
    }

    // 1. 锁定工单后鉴权并写消息。MySQL 生产路径使用 FOR UPDATE，避免
    // 检查 assignment 后到 INSERT 之间被转派/撤销；全部本地写入同事务。
    // clientKey unique 兜并发：同 key 两个并发请求只有一个能建消息成功。
    let txProject: any;
    let message: any;
    // 附件校验（归属/状态/过期），绑定在消息创建后执行
    if (dto.attachmentIds?.length) {
      await this.attachmentService.validateForUser(dto.attachmentIds, actor.id);
    }
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        if (typeof tx.$queryRaw === 'function') {
          await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
        }
        const lockedProject = await tx.project.findUnique({ where: { id: projectId } });
        if (!lockedProject) throw new NotFoundException('工单不存在');
        this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, lockedProject);
        const createdMessage = await tx.projectMessage.create({
          data: {
            projectId,
            role,
            text: dto.text,
            ...(dto.idempotencyKey ? { clientKey: dto.idempotencyKey } : {}),
            ...(dto.attachmentIds?.length ? { attachmentIds: dto.attachmentIds } : {}),
          },
        });
        return { project: lockedProject, message: createdMessage };
      });
      ({ project: txProject, message } = result);
      if (dto.attachmentIds?.length) {
        await this.attachmentService.bind(dto.attachmentIds, projectId);
      }
    } catch (e: any) {
      if (e?.code === 'P2002' && dto.idempotencyKey) {
        // 并发方同 key 先建成功：复用其消息（校验归属同工单，防跨工单 key 碰撞）
        const winner = await this.prisma.projectMessage
          .findUnique({ where: { clientKey: dto.idempotencyKey } })
          .catch(() => null);
        if (winner && winner.projectId === projectId) {
          const claimed = await this.replyOrchestrator.claimRun(projectId, winner.id, capability);
          if (claimed.status === 'succeeded' && claimed.answer) {
            return { message: claimed.answer, route: 'llm', stream: undefined };
          }
          if (claimed.status === 'running') {
            return { message: winner, route: 'llm', stream: undefined };
          }
          return {
            message: winner,
            route: 'llm',
            ...(await this.replyOrchestrator.reply(projectId, winner.id, signal, claimed.runId, capability)),
          };
        }
      }
      throw e;
    }

    // 2. 根据路由决定后续
    if (txProject.route === 'llm' && role === 'user') {
      // P2 追问：重新风险判定
      const riskInput = await this.replyOrchestrator.buildRiskInput(dto.text, dto.attachmentIds);
      const { risk, route, domain } = await this.riskService.assess(riskInput);

      if (route === 'legalbp') {
        // 追问触发升级：匹配、条件切换、事件、Outbox 全部由统一用例完成。
        await this.escalateToLegal.execute({
          projectId,
          route: 'legalbp',
          status: '待复核',
          risk,
          domain: domain ?? null,
          eventTexts: [
            formatEventTime() + ` · 追问触发 ${risk} 风险判定，已升级人工处理，等待 BP 分配`,
          ],
        });
        return { message, route: 'legalbp' };
      }

      // 认领 run（userMessageId=message.id）：确保每轮只启动一次模型
      const claimed = await this.replyOrchestrator.claimRun(projectId, message.id, capability);
      if (claimed.status === 'succeeded' && claimed.answer) {
        return { message: claimed.answer, route: 'llm', status: 'succeeded' };
      }
      if (claimed.status === 'running') {
        return { message, route: 'llm', status: 'running' };
      }
      return {
        message,
        route: 'llm',
        ...(await this.replyOrchestrator.reply(projectId, message.id, signal, claimed.runId, capability)),
      };
    }

    return { message, route: project.route };
  }

  /**
   * 法务 BP 正式回传 — "有权回传"与"状态允许回传"同时放进条件更新（P1-01 5.3.7），
   * 防止检查后状态或指派发生变化。
   */
  async reply(projectId: string, dto: ReplyProjectDto, actor: ProjectActor, request?: AuditRequestContext) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Reply, project);

    // 原子化：状态=待复核 + （legal_bp 需已指派给自己）
    const where: Prisma.ProjectWhereInput = { id: projectId, status: '待复核' };
    if (actor.role === 'legal_bp') {
      where.OR = [{ legalBpId: actor.id }, { ownerId: actor.id }];
    }
    const { result: fresh, before } = await this.prisma.$transaction(async (tx) => {
      const before = await this.lockProjectForAudit(tx, projectId, project);
      this.accessPolicy.assertCan(actor, ProjectAction.Reply, before);
      const reviewCompletedAt = new Date();
      const needsCrmDelivery = Boolean(before.sourceAppId && before.crmTaskId);
      let deliveryFileId: string | null = null;
      if (needsCrmDelivery) {
        if (!dto.deliveryFileId) {
          throw new ConflictException('CRM 合同任务必须明确选择法务确认的回传文件');
        }
        const deliveryFile = await tx.contractFile.findFirst({
          where: {
            id: dto.deliveryFileId,
            projectId,
            kind: { in: ['final', 'revised'] },
            uploader: { role: { in: [Role.legal_bp, Role.legal_lead, Role.admin] } },
          },
          select: { id: true },
        });
        if (!deliveryFile) {
          throw new ConflictException('回传文件不存在、已不属于本工单，或未经法务角色上传确认');
        }
        deliveryFileId = deliveryFile.id;
      }
      const updated = await tx.project.updateMany({
        where,
        data: {
          status: '已回传',
          result: dto.text,
          legalBpId: actor.id,
          reviewStatus: 'review_completed',
          reviewCompletedAt,
          ...(needsCrmDelivery
            ? {
                crmDeliveryStatus: 'pending' as const,
                crmDeliveryUpdatedAt: reviewCompletedAt,
                crmDeliveredAt: null,
                crmDeliveryLastError: null,
                crmDeliveryFileId: deliveryFileId,
              }
            : {}),
        },
      });
      if (updated.count === 0) {
        throw new ForbiddenException('只有待复核状态、且已指派给您的工单才能回传');
      }
      const result = await tx.project.findUnique({ where: { id: projectId } });
      if (!result) throw new NotFoundException('工单不存在');
      await tx.projectMessage.create({
        data: { projectId, role: 'legal', text: dto.text, label: '法务BP 正式回复' },
      });
      await tx.projectEvent.create({ data: { projectId, text: formatEventTime() + ' · 法务审核已完成' } });
      await tx.projectEvent.create({ data: { projectId, text: formatEventTime() + ' · 通知业务端 + 钉钉群同步' } });
      if (needsCrmDelivery && deliveryFileId) {
        await tx.outboxEvent.create({
          data: {
            eventType: OUTBOX_EVENT_CRM_REVIEW_RESULT_DELIVER,
            aggregateType: 'project',
            aggregateId: projectId,
            dedupKey: crmReviewDeliveryOutboxDedupKey(before.sourceAppId, before.crmTaskId),
            payload: { projectId, contractFileId: deliveryFileId },
            projectId,
          },
        });
        await tx.projectEvent.create({
          data: { projectId, text: formatEventTime() + ' · CRM 交付任务已入队' },
        });
      }
      if (this.audit) {
        const latestRun = await tx.consultationRun.findFirst({
          where: { projectId, status: 'succeeded' },
          orderBy: { completedAt: 'desc' },
        });
        const auditEvent = await this.audit.record({
          actor,
          action: 'project.reply',
          resourceType: 'project',
          resourceId: projectId,
          projectId,
          source: 'web',
          outcome: 'success',
          request,
          correlationId: latestRun?.id ?? null,
          before: projectAuditSnapshot(before),
          after: projectAuditSnapshot(result),
          changes: {
            status: { from: before.status, to: '已回传' },
            legalBpId: { from: before.legalBpId, to: actor.id },
            resultHash: { from: before.result ? this.audit.digestCanonical(before.result) : null, to: this.audit.digestCanonical(dto.text) },
            ...(deliveryFileId
              ? { crmDeliveryFileId: { from: before.crmDeliveryFileId ?? null, to: deliveryFileId } }
              : {}),
          },
          metadata: latestRun ? {
            consultationRunId: latestRun.id,
            dshSessionId: latestRun.dshSessionId,
            modelVersion: latestRun.modelVersion,
            aiOutputHash: latestRun.outputHash,
          } : { consultationRunId: null },
          retentionClass: 'business',
        }, tx) as any;
        if (latestRun) {
          await tx.consultationRun.update({
            where: { id: latestRun.id },
            data: { humanAuditEventId: auditEvent.eventId },
          });
        }
      }
      return { result, before };
    });

    // 钉钉：若此前不在群则加人（.catch 防崩溃）
    if (actor.id !== before.legalBpId) {
      void this.onLegalBpChanged(projectId, actor.id, before.legalBpId).catch((e) =>
        this.logger.error(`认领加群失败（${projectId}）：${e}`),
      );
    }

    // 钉钉通知
    try {
      if (fresh.dingtalkChatId) {
        await this.dingtalk.sendNotification(fresh.dingtalkChatId, '法务审核已完成');
      }
    } catch (e) {
      this.logger.warn(`钉钉通知失败：${e}`);
    }

    return {
      status: '已回传',
      reviewStatus: fresh.reviewStatus,
      crmDeliveryStatus: fresh.crmDeliveryStatus ?? null,
    };
  }

  async recordDownload(
    projectId: string,
    dto: RecordDownloadDto,
    actor: ProjectActor,
    request?: AuditRequestContext,
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Read, project);
    if (dto.resourceId) {
      const message = await this.prisma.projectMessage.findFirst({
        where: { id: dto.resourceId, projectId, role: { in: ['assistant', 'legal'] } },
        select: { id: true },
      });
      if (!message) throw new NotFoundException('下载记录不存在');
    }
    if (!this.audit) throw new ConflictException('审计服务不可用，暂不能下载敏感记录');
    await this.audit.record({
      actor,
      action: dto.resourceType === 'contract' ? 'contract.download' : 'consultation_record.download',
      resourceType: dto.resourceType,
      resourceId: dto.resourceId ?? projectId,
      projectId,
      source: 'web',
      outcome: 'success',
      request,
      metadata: { format: dto.format },
      retentionClass: 'business',
    });
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /** MySQL 生产路径锁定工单后再采集 before，避免并发转派/状态变更使审计快照失真。 */
  private async lockProjectForAudit(tx: Prisma.TransactionClient, projectId: string, testFallback: any) {
    if (typeof (tx as any).$queryRaw !== 'function') return testFallback;
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    return project;
  }


  // ═══════════════════════════════════════════
  // 钉钉联动
  // ═══════════════════════════════════════════

  /** 领域 → BP 匹配（工程评审决策 #16）：映射表取第一个已绑定 userid 的 BP；失败兜底 legal_lead */
  private async matchLegalBp(domain: string | null): Promise<string | null> {
    if (domain) {
      const maps = await this.prisma.bpDomainMap.findMany({
        where: { domain },
        include: { user: { select: { id: true, dingtalkUserId: true } } },
      });
      const bound = maps.find((m) => m.user.dingtalkUserId);
      if (bound) return bound.user.id;
    }
    const lead = await this.prisma.user.findFirst({
      where: { role: 'legal_lead', dingtalkUserId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return lead?.id ?? null;
  }

  /**
   * 转派/认领检测（transfer/update/reply 共用）：新 BP 进群，旧 BP 留群。
   * 这里只写 Outbox，不直接调用钉钉，避免外部成功后本地请求失败造成不可追踪状态。
   */
  private async onLegalBpChanged(projectId: string, newBpId: string, oldBpId: string | null) {
    if (!newBpId || newBpId === oldBpId) return;
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { dingtalkChatId: true },
      });
      if (!project?.dingtalkChatId) return; // 无群跳过

      const dedupKey = dingtalkMemberOutboxDedupKey(projectId, newBpId);
      await this.prisma.outboxEvent.create({
        data: {
          eventType: OUTBOX_EVENT_DINGTALK_MEMBER_ADD,
          aggregateType: 'project',
          aggregateId: projectId,
          dedupKey,
          payload: { projectId, userId: newBpId },
          projectId,
        },
      });
    } catch (e) {
      if ((e as any)?.code === 'P2002') return;
      await this.addEvent(projectId, formatEventTime() + ' · 转派加群任务入队失败，请人工处理');
      this.logger.warn(`转派加群失败（工单 ${projectId}）：${e}`);
    }
  }

  /** 添加事件 */
  private async addEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({
      data: { projectId, text },
    });
  }

}

function projectAuditSnapshot(project: any) {
  return {
    id: project.id,
    status: project.status,
    risk: project.risk,
    route: project.route,
    ownerId: project.ownerId,
    legalBpId: project.legalBpId ?? null,
    resultPresent: Boolean(project.result),
  };
}

function projectChanges(before: any, after: any, audit: AuditService) {
  const fields = ['status', 'risk', 'route', 'ownerId', 'legalBpId'] as const;
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    if (before[field] !== after[field]) changes[field] = { from: before[field] ?? null, to: after[field] ?? null };
  }
  if (before.result !== after.result) {
    changes.resultHash = {
      from: before.result ? audit.digestCanonical(before.result) : null,
      to: after.result ? audit.digestCanonical(after.result) : null,
    };
  }
  return changes;
}
