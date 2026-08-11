import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CodexAppServerService } from '../../common/services/codex-app-server.service';
import { LLMRiskService } from '../../common/services/llm-risk.service';
import {
  CrmAdapter,
  DingTalkAdapter,
  CRM_ADAPTER,
  DINGTALK_ADAPTER,
} from './adapters/adapter.interfaces';
import { CreateProjectDto, CreateProjectMessageDto, ReplyProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ChildProcess } from 'child_process';
import { Prisma } from '@prisma/client';
import { injectSkillSection } from '../../common/utils/skill-prompt';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly appServer: CodexAppServerService,
    private readonly riskService: LLMRiskService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
    private readonly createProjectUseCase: CreateProjectUseCase,
    private readonly accessPolicy: ProjectAccessPolicy,
    private readonly query: ProjectQueryService,
    private readonly stateMachine: ProjectStateMachine,
    private readonly claimProject: ClaimProjectUseCase,
    private readonly escalateToLegal: EscalateProjectToLegalUseCase,
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
    const { project, created } = await this.createProjectUseCase.execute({
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

    // 4. P2 + llm 路由：异步触发 AI 答复（不阻塞响应；ChildProcess 错误由 on('error') 处理）
    if (route === 'llm' && created) {
      this.triggerAIResponse(project.id, dto.input).catch((e) =>
        this.logger.error(`AI 触发失败：${e}`),
      );
    }

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
  ): Promise<{ message: any; stream?: ChildProcess; route: string }> {
    const role = actor.role === 'business' ? 'user' : 'legal';

    // 1. 锁定工单后鉴权并写消息。MySQL 生产路径使用 FOR UPDATE，避免
    // 检查 assignment 后到 INSERT 之间被转派/撤销；全部本地写入同事务。
    const { project, message } = await this.prisma.$transaction(async (tx) => {
      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
      }
      const lockedProject = await tx.project.findUnique({ where: { id: projectId } });
      if (!lockedProject) throw new NotFoundException('工单不存在');
      this.accessPolicy.assertCan(actor, ProjectAction.SendMessage, lockedProject);
      const createdMessage = await tx.projectMessage.create({
        data: { projectId, role, text: dto.text },
      });
      return { project: lockedProject, message: createdMessage };
    });

    // 2. 根据路由决定后续
    if (project.route === 'llm' && role === 'user') {
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

      return { message, route: 'llm', stream: await this.triggerAIResponse(projectId, dto.text, signal) };
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

  /** 触发 AI 生成答复 — 经共享 Codex 队列，app-server 双路流(思考+内容)供 SSE 流式 */
  private async triggerAIResponse(
    projectId: string,
    userQuery: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const project = await this.prisma.project
      .findUnique({
        where: { id: projectId },
        select: { extra: true, skillName: true },
      })
      .catch(() => null);
    const skillPrompt = (project?.extra as any)?.skillPrompt ?? null;
    const prompt = this.buildConsultPrompt(
      userQuery,
      project?.skillName ?? undefined,
      skillPrompt ?? undefined,
    );

    const child = await this.appServer.executeStream(prompt, {
      timeout: 120_000,
      sessionId: projectId,
      signal,
    });
    let fullText = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      fullText += chunk.toString();
    });

    child.on('close', async (code) => {
      // 连接断开主动取消 → 不写失败状态（刷新 ≠ 生成失败）
      if ((child as any).__cancelled) return;
      if (code === 0 && fullText.trim()) {
        try {
          await this.prisma.$transaction([
            this.prisma.projectMessage.create({
              data: { projectId, role: 'assistant', text: fullText.trim() },
            }),
            this.prisma.project.update({
              where: { id: projectId },
              data: { status: '已回传', result: fullText.trim() },
            }),
          ]);
          await this.addEvent(projectId, this.formatTime() + ' · AI 答复已完成');
        } catch (err) {
          this.logger.error(`AI 答复落库失败：${err}`);
        }
      } else {
        this.logger.error(`Codex 进程异常退出，code=${code}`);
        try {
          await this.prisma.project.update({
            where: { id: projectId },
            data: { status: '待处理', isFailed: true },
          });
          await this.addEvent(projectId, this.formatTime() + ' · AI 答复生成失败，已转人工处理');
        } catch (err) {
          this.logger.error(`失败状态更新失败：${err}`);
        }
      }
    });

    child.on('error', async (err) => {
      this.logger.error(`Codex spawn 失败：${err.message}`);
      try {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { status: '待处理', isFailed: true },
        });
        await this.addEvent(projectId, this.formatTime() + ' · AI 服务不可用，已转人工处理');
      } catch (dbErr) {
        this.logger.error(`失败状态更新失败：${dbErr}`);
      }
    });

    return child;
  }

  /** 构建业务咨询 prompt（技能指令段注入顶部，工程评审决策 #3/#5） */
  private buildConsultPrompt(userQuery: string, skillName?: string, skillPrompt?: string): string {
    const base = `## Role
你是一名企业法务顾问，为业务人员提供法律咨询答复。

## Output Format（严格按四段式输出）
### 核心结论
一句话总结你的法律判断。

### 重点风险
列出 2-3 个最关键的法律风险点，每条不超过两句话。

### 建议动作
给出具体可执行的下一步行动建议。

### 需补充确认
列出需要进一步确认的事实或信息（如有）。如果信息足够，写"无，以上判断基于现有信息可执行"。

## Rules
- 不引用具体法条号（除非用户追问或所选技能明确要求援引）
- 只说你能确定的事，不确定的事项放在"需补充确认"
- 如果问题超出法务范围（如税务、财务），明确告知并建议联系对应部门
- 每条答复末尾追加免责声明："> ⚠️ 本答复由AI生成，不构成正式法律意见。如需正式法务意见，请联系法务BP确认。"

## User Query
${userQuery}`;
    // 技能段由共享 util 注入（含边界标记剥除）；无技能时原样返回
    return injectSkillSection(base, skillName ?? '', skillPrompt ?? '');
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
