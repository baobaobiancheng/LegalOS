import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ConsultationChatService } from '../../common/services/consultation-chat.service';
import { LLMRiskService } from '../../common/services/llm-risk.service';
import {
  CrmAdapter,
  DingTalkAdapter,
  CRM_ADAPTER,
  DINGTALK_ADAPTER,
} from './adapters/adapter.interfaces';
import { CreateProjectDto, CreateProjectMessageDto, ReplyProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Prisma } from '@prisma/client';
import { buildSkillSection } from '../../common/utils/skill-prompt';
import { ConsultationContextBuilder } from './application/consultation-context-builder';
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

// 用户选择器，避免暴露密码哈希
const userSelect = { id: true, username: true, displayName: true, role: true };

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);
  /** F4（2026-08-12 review）：同一 Project 的 AI 严格串行（替代原 Codex 队列 sessionId 语义），
   *  后一问的上下文构建等前一问生成结束后才进行，防止上下文缺前一问答案。单实例内有效。 */
  private readonly projectTurnTails = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly riskService: LLMRiskService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    private readonly createProjectUseCase: CreateProjectUseCase,
    private readonly accessPolicy: ProjectAccessPolicy,
    private readonly query: ProjectQueryService,
    private readonly stateMachine: ProjectStateMachine,
    private readonly claimProject: ClaimProjectUseCase,
    private readonly escalateToLegal: EscalateProjectToLegalUseCase,
    private readonly consultationChat: ConsultationChatService,
    private readonly contextBuilder: ConsultationContextBuilder,
    private readonly config: ConfigService,
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

    // 1. 风险判定 + 领域标签（事务前：外部 LLM 调用；P1-11 带回规则下限证据）
    const { risk, route, domain, evidence } = await this.riskService.assess(dto.input);

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
      events.push(this.formatTime() + ' · 所选技能不可用，已按通用口径答复');
    }
    events.push(this.formatTime() + ' · 工单已创建');
    events.push(
      this.formatTime() +
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
    });

    // 4. 首条消息已由建单落库；不再在此自动触发 AI —— 前端随后用 firstReply=true 启动首轮回答，
    //    避免「同一问题触发两次 AI、存两条用户消息」（review 2026-08-11 P0 双重提交）。
    return this.formatProject(project);
  }

  /** 工单响应脱敏：extra（技能 prompt 快照）不返回；route/risk 冗余展开 */
  private formatProject(project: any) {
    const { extra: _extra, ...safeProject } = project;
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
  async update(id: string, dto: UpdateProjectDto, actor: ProjectActor) {
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
        eventTexts: [this.formatTime() + ' · 工单已升级人工处理，等待 BP 分配'],
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
    const guardedWhere: Prisma.ProjectWhereInput = {
      id,
      // 如果本次更新带状态，必须仍从刚读到的状态开始，避免覆盖并发迁移。
      ...(dto.status && { status: project.status }),
    };
    if (actor.role === 'legal_bp') {
      guardedWhere.OR = [{ legalBpId: actor.id }, { ownerId: actor.id }];
    }
    const updatedCount = await this.prisma.project.updateMany({
      where: guardedWhere,
      data: updateData,
    });
    if (updatedCount.count === 0) {
      throw actor.role === 'legal_bp'
        ? new ForbiddenException('工单指派已变化，无法更新')
        : new ConflictException('工单状态已变化，请刷新后重试');
    }
    const updated = await this.prisma.project.findUnique({
      where: { id },
      include: {
        creator: { select: userSelect },
        owner: { select: userSelect },
        legalBp: { select: userSelect },
      },
    });
    if (!updated) throw new NotFoundException('工单不存在');

    // 钉钉联动：
    // - legalBpId 变更 → 新 BP 进群（异步，不阻塞 PATCH 响应）
    if (dto.legalBpId && dto.legalBpId !== project.legalBpId) {
      void this.onLegalBpChanged(id, dto.legalBpId, project.legalBpId).catch((e) =>
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
  async cancel(id: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Cancel, project);

    const where: Prisma.ProjectWhereInput = { id, status: { notIn: ['已取消', '已回传'] } };
    if (actor.role === 'business') where.creatorId = actor.id;

    const updated = await this.prisma.project.updateMany({
      where,
      data: { status: '已取消' },
    });
    if (updated.count === 0) {
      throw new ForbiddenException('只能取消自己创建的、未完成或未取消的工单');
    }
    await this.addEvent(id, this.formatTime() + ' · 工单已取消');

    return { status: '已取消' };
  }

  /** 转派给另一个法务 BP（仅 legal_lead/admin，P1-01 5.2；新 BP 自动进群，旧 BP 留群） */
  async transfer(id: string, legalBpId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Transfer, project);

    const bp = await this.prisma.user.findUnique({ where: { id: legalBpId } });
    if (!bp || (bp.role !== 'legal_bp' && bp.role !== 'legal_lead')) {
      throw new ForbiddenException('目标用户不是法务 BP');
    }

    const updated = await this.prisma.project.update({
      where: { id },
      data: { legalBpId, ownerId: legalBpId },
      include: {
        creator: { select: userSelect },
        owner: { select: userSelect },
        legalBp: { select: userSelect },
      },
    });
    await this.addEvent(id, this.formatTime() + ` · 工单已转派给 ${bp.displayName}`);

    // 钉钉：新 BP 加群改由 Outbox Worker 执行，HTTP 请求只提交本地事件。
    await this.onLegalBpChanged(id, legalBpId, project.legalBpId);
    try {
      if (project.dingtalkChatId) {
        await this.dingtalk.sendNotification(
          project.dingtalkChatId,
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
  async escalate(projectId: string, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Escalate, project);
    if (project.status === '已取消') throw new ForbiddenException('已取消的工单不能升级');

    // 已是法务流程：幂等返回 200，不重复写事件/建群
    if (project.route === 'legalbp') {
      return { upgraded: false, route: 'legalbp', status: project.status };
    }

    await this.escalateToLegal.execute({
      projectId,
      route: 'legalbp',
      status: '待复核',
      domain: null,
      eventTexts: [this.formatTime() + ' · 用户申请升级为人工处理，已通知法务 BP'],
    });

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

      const claimed = await this.claimConsultationRun(projectId, first.id);
      if (claimed.status === 'succeeded' && claimed.answer) {
        return { message: claimed.answer, route: 'llm', status: 'succeeded' };
      }
      if (claimed.status === 'running') {
        return { message: first, route: 'llm', status: 'running' }; // 已在跑,不再启动第二个
      }
      return {
        message: first,
        route: 'llm',
        ...(await this.triggerAIResponse(projectId, first.id, signal, claimed.runId)),
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
        const claimed = await this.claimConsultationRun(projectId, existing.id);
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
          ...(await this.triggerAIResponse(projectId, existing.id, signal, claimed.runId)),
        };
      }
    }

    // 1. 锁定工单后鉴权并写消息。MySQL 生产路径使用 FOR UPDATE，避免
    // 检查 assignment 后到 INSERT 之间被转派/撤销；全部本地写入同事务。
    // clientKey unique 兜并发：同 key 两个并发请求只有一个能建消息成功。
    let txProject: any;
    let message: any;
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
          },
        });
        return { project: lockedProject, message: createdMessage };
      });
      ({ project: txProject, message } = result);
    } catch (e: any) {
      if (e?.code === 'P2002' && dto.idempotencyKey) {
        // 并发方同 key 先建成功：复用其消息（校验归属同工单，防跨工单 key 碰撞）
        const winner = await this.prisma.projectMessage
          .findUnique({ where: { clientKey: dto.idempotencyKey } })
          .catch(() => null);
        if (winner && winner.projectId === projectId) {
          const claimed = await this.claimConsultationRun(projectId, winner.id);
          if (claimed.status === 'succeeded' && claimed.answer) {
            return { message: claimed.answer, route: 'llm', stream: undefined };
          }
          if (claimed.status === 'running') {
            return { message: winner, route: 'llm', stream: undefined };
          }
          return {
            message: winner,
            route: 'llm',
            ...(await this.triggerAIResponse(projectId, winner.id, signal, claimed.runId)),
          };
        }
      }
      throw e;
    }

    // 2. 根据路由决定后续
    if (txProject.route === 'llm' && role === 'user') {
      // P2 追问：重新风险判定
      const { risk, route, domain } = await this.riskService.assess(dto.text);

      if (route === 'legalbp') {
        // 追问触发升级：匹配、条件切换、事件、Outbox 全部由统一用例完成。
        await this.escalateToLegal.execute({
          projectId,
          route: 'legalbp',
          status: '待复核',
          risk,
          domain: domain ?? null,
          eventTexts: [
            this.formatTime() + ` · 追问触发 ${risk} 风险判定，已升级人工处理，等待 BP 分配`,
          ],
        });
        return { message, route: 'legalbp' };
      }

      // 认领 run（userMessageId=message.id）：确保每轮只启动一次模型
      const claimed = await this.claimConsultationRun(projectId, message.id);
      if (claimed.status === 'succeeded' && claimed.answer) {
        return { message: claimed.answer, route: 'llm', status: 'succeeded' };
      }
      if (claimed.status === 'running') {
        return { message, route: 'llm', status: 'running' };
      }
      return {
        message,
        route: 'llm',
        ...(await this.triggerAIResponse(projectId, message.id, signal, claimed.runId)),
      };
    }

    return { message, route: project.route };
  }

  /**
   * 法务 BP 正式回传 — "有权回传"与"状态允许回传"同时放进条件更新（P1-01 5.3.7），
   * 防止检查后状态或指派发生变化。
   */
  async reply(projectId: string, dto: ReplyProjectDto, actor: ProjectActor) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');
    this.accessPolicy.assertCan(actor, ProjectAction.Reply, project);

    // 原子化：状态=待复核 + （legal_bp 需已指派给自己）
    const where: Prisma.ProjectWhereInput = { id: projectId, status: '待复核' };
    if (actor.role === 'legal_bp') {
      where.OR = [{ legalBpId: actor.id }, { ownerId: actor.id }];
    }
    const updated = await this.prisma.project.updateMany({
      where,
      data: { status: '已回传', result: dto.text, legalBpId: actor.id },
    });
    if (updated.count === 0) {
      throw new ForbiddenException('只有待复核状态、且已指派给您的工单才能回传');
    }

    // 重新读取 project 用于后续操作
    const fresh = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!fresh) throw new NotFoundException('工单不存在');

    // 存入法务回复
    await this.prisma.projectMessage.create({
      data: { projectId, role: 'legal', text: dto.text, label: '法务BP 正式回复' },
    });

    // 事件
    await this.addEvent(projectId, this.formatTime() + ' · 已回传业务端');
    await this.addEvent(projectId, this.formatTime() + ' · 通知业务端 + 钉钉群同步');

    // 钉钉：若此前不在群则加人（.catch 防崩溃）
    if (actor.id !== project.legalBpId) {
      void this.onLegalBpChanged(projectId, actor.id, project.legalBpId).catch((e) =>
        this.logger.error(`认领加群失败（${projectId}）：${e}`),
      );
    }

    // CRM 回写（Mock）
    try {
      await this.crm.writeBack(projectId, dto.text);
    } catch (e) {
      this.logger.warn(`CRM 回写失败（Mock）：${e}`);
    }

    // 钉钉通知
    try {
      if (fresh.dingtalkChatId) {
        await this.dingtalk.sendNotification(fresh.dingtalkChatId, '工单已回传');
      }
    } catch (e) {
      this.logger.warn(`钉钉通知失败：${e}`);
    }

    return { status: '已回传' };
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /** F4：同一 Project 的 AI 严格串行（单实例）；锁在 stream close 时释放 */
  private async acquireProjectTurn(projectId: string): Promise<() => void> {
    const prev = this.projectTurnTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    const gate = prev.catch(() => undefined).then(() => undefined);
    this.projectTurnTails.set(projectId, gate.then(() => tail).catch(() => tail));
    await gate;
    return release;
  }

  /** 触发 AI 生成答复 — 直连网关双路流(思考+内容)，上下文由 ConsultationContextBuilder 从数据库重建 */
  private async triggerAIResponse(
    projectId: string,
    currentUserMessageId: string,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<any> {
    const release = await this.acquireProjectTurn(projectId);
    // 释放串行锁 + 清理 Map 条目（幂等：close 与 error 都可能触发）
    const finishTurn = () => {
      release();
      this.projectTurnTails.delete(projectId);
    };
    // P0-4（review 2026-08-12）：SSE 的 message_end 必须等落库成功后才发，
    // 避免「前端显示成功 → 落库失败 → 刷新答案消失」。
    let resolveCompletion!: (msg: unknown) => void;
    let rejectCompletion!: (e: unknown) => void;
    const completion = new Promise<unknown>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });
    let child: any;
    try {
      const project = await this.prisma.project
        .findUnique({
          where: { id: projectId },
          select: { extra: true, skillName: true },
        })
        .catch(() => null);
      const skillPrompt = (project?.extra as any)?.skillPrompt ?? null;
      const skillName = project?.skillName ?? null;

      let context;
      try {
        context = await this.contextBuilder.build({
          projectId,
          currentUserMessageId,
          // 技能段复用共享 util：剥边界标记 + 硬边界模板（防 prompt 注入）
          skillPrompt: skillName && skillPrompt ? buildSkillSection(skillName, skillPrompt) : undefined,
        });
      } catch (e) {
        this.logger.error(`咨询上下文构建失败（${projectId}/${currentUserMessageId}）：${e}`);
        throw new BadRequestException('咨询上下文构建失败，请重试');
      }

      child = await this.consultationChat.stream(context.messages, {
        // 分级输出预算（review 2026-08-12）：普通 P2 咨询 6000，防简单问题也获得超长生成空间
        // （一旦模型循环，长预算会重复更多）；复杂/长文研究才用 12000~16000
        maxTokens:
          Number.parseInt(String(this.config.get('CONSULT_P2_OUTPUT_TOKENS', '6000')), 10) || 6000,
        timeout: Number.parseInt(String(this.config.get('CONSULT_CHAT_TIMEOUT_MS', '600000')), 10) || 600_000,
        signal,
        runId,
        projectId,
      });
    } catch (e) {
      finishTurn();
      throw e;
    }

    // P0-3：流式协议身份——一次 Run 一个稳定 runId，SSE 事件据此去重/丢弃过期
    if (runId) child.__runId = runId;

    let fullText = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      fullText += chunk.toString();
    });

    // P0（review 2026-08-12）：单个结束处理器——先落库/更新 Run，最后才释放同 Project 串行锁，
    // 否则下一轮上下文构建可能发生在上一轮答案入库之前。
    child.once('close', async (code) => {
      try {
        // 连接断开主动取消 → 不写失败状态（刷新 ≠ 生成失败）；run 标记 cancelled 以便重试
        if ((child as any).__cancelled) {
          if (runId) {
            await this.prisma.consultationRun
              .update({ where: { id: runId }, data: { status: 'cancelled', completedAt: new Date() } })
              .catch(() => undefined);
          }
          rejectCompletion(new Error('cancelled'));
          return;
        }
        // 权威文本优先用网关 content 增量累计（__finalText），流式累计仅兜底
        const finalText = String((child as any).__finalText ?? fullText).trim();
        if (code === 0 && finalText) {
          try {
            const [msg] = await this.prisma.$transaction([
              this.prisma.projectMessage.create({
                data: { projectId, role: 'assistant', text: finalText },
              }),
              this.prisma.project.update({
                where: { id: projectId },
                data: { status: '已回传', result: finalText },
              }),
            ]);
            if (runId) {
              await this.prisma.consultationRun
                .update({
                  where: { id: runId },
                  data: { status: 'succeeded', answerMessageId: msg.id, completedAt: new Date() },
                })
                .catch(() => undefined);
            }
            await this.addEvent(projectId, this.formatTime() + ' · AI 答复已完成');
            resolveCompletion(msg); // P0-4：落库成功 → 前端可收到 message_end
          } catch (err) {
            this.logger.error(`AI 答复落库失败：${err}`);
            rejectCompletion(err);
            if (runId) {
              await this.prisma.consultationRun
                .update({
                  where: { id: runId },
                  data: { status: 'failed', errorMessage: String(err).slice(0, 500), completedAt: new Date() },
                })
                .catch(() => undefined);
            }
          }
        } else {
          this.logger.error(`咨询网关流异常退出，code=${code}`);
          rejectCompletion(new Error(`code=${code}`));
          try {
            await this.prisma.project.update({
              where: { id: projectId },
              data: { status: '待处理', isFailed: true },
            });
            await this.addEvent(projectId, this.formatTime() + ' · AI 答复生成失败，已转人工处理');
            if (runId) {
              await this.prisma.consultationRun
                .update({
                  where: { id: runId },
                  data: { status: 'failed', errorMessage: `code=${code}`, completedAt: new Date() },
                })
                .catch(() => undefined);
            }
          } catch (err) {
            this.logger.error(`失败状态更新失败：${err}`);
          }
        }
      } finally {
        // 串行锁必须在落库完成后才释放，并清理 Map 条目（防长期增长）
        finishTurn();
      }
    });

    child.once('error', async (err) => {
      this.logger.error(`咨询网关流错误：${err.message}`);
      rejectCompletion(err);
      try {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { status: '待处理', isFailed: true },
        });
        await this.addEvent(projectId, this.formatTime() + ' · AI 服务不可用，已转人工处理');
        if (runId) {
          await this.prisma.consultationRun
            .update({
              where: { id: runId },
              data: { status: 'failed', errorMessage: err.message.slice(0, 500), completedAt: new Date() },
            })
            .catch(() => undefined);
        }
      } catch (dbErr) {
        this.logger.error(`失败状态更新失败：${dbErr}`);
      } finally {
        finishTurn();
      }
    });

    // P0-4：completion 供 sendConsultSSE 门控 message_end（落库成功才发）
    return { stream: child, completion };
  }

  /** 认领/复用咨询运行（2026-08-12）：一条 userMessageId 最多一个生成任务。
   *   succeeded → 返回已有答案；running/queued → 不二次启动；
   *   超 CONSULT_RUN_STALE_MS 的卡死 run 重置重跑；failed/cancelled → 复用同 run 重跑。
   *   P2002（并发同时建）→ 读并发方 run 状态决定返回答案还是等待。 */
  private async claimConsultationRun(
    projectId: string,
    userMessageId: string,
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
        data: { projectId, userMessageId, status: 'running' },
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
      await this.addEvent(projectId, this.formatTime() + ' · 转派加群任务入队失败，请人工处理');
      this.logger.warn(`转派加群失败（工单 ${projectId}）：${e}`);
    }
  }

  /** 添加事件 */
  private async addEvent(projectId: string, text: string) {
    return this.prisma.projectEvent.create({
      data: { projectId, text },
    });
  }

  /** 格式化时间戳 */
  private formatTime(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}
