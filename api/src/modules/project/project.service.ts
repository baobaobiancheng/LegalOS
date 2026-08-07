import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CodexService } from '../../common/services/codex.service';
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
import { Prisma, ProjectKind, ProjectStatus, RiskLevel, Role } from '@prisma/client';
import { injectSkillSection } from '../../common/utils/skill-prompt';

// 用户选择器，避免暴露密码哈希
const userSelect = { id: true, username: true, displayName: true, role: true };

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codexService: CodexService,
    private readonly riskService: LLMRiskService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
  ) {}

  // ═══════════════════════════════════════════
  // 工单 CRUD
  // ═══════════════════════════════════════════

  /** 创建工单 — 含风险判定 + 领域匹配 BP + 路由 + 钉钉拉群（2026-08-05 真实链路） */
  async create(dto: CreateProjectDto, currentUserId: string) {
    // 0. 幂等（P1-03）：同一 idempotencyKey 只创建一个工单，防客户端/CRM 重试重复建单/建群
    if (dto.idempotencyKey) {
      const existing = await this.prisma.project.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { creator: { select: userSelect }, owner: { select: userSelect } },
      });
      if (existing) return this.formatProject(existing);
    }

    // 1. 风险判定 + 领域标签（工程评审决策 #11：双标签，风险部分失败默认 P1）
    const { risk, route, domain } = await this.riskService.assess(dto.input);

    // 1.5 技能服务端解析（工程评审决策 OV#2：客户端字段仅参考，防伪造与快照分歧）
    // 仅解析 active 的公有技能或创建者自己的私有技能；失败按无技能处理（含存量 junk skillId）
    let skillId: string | null = null;
    let skillName: string | null = null;
    let skillGroup: string | null = null; // 2026-08-05：领域优先来源（工程评审决策 #10）
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
        skillPrompt = skill.prompt; // prompt 快照进 extra（在途多轮对话稳定，工程评审决策 #2）
      } else {
        // 解析失败（不存在/停用/不可见）→ 按无技能处理 + 日志（工程评审决策 OV#2）
        this.logger.warn(`skillId=${dto.skillId} 解析失败（不存在/停用/无权），工单按无技能处理`);
      }
    }

    // 1.6 领域解析 + BP 匹配（仅 legalbp 路由拉群，P2 保持 AI 处理语义——工程评审决策 #10）
    // 领域来源优先级：技能 group（用户自选、确定性）→ LLM 标签兜底 → null（未匹配走兜底阶梯）
    let legalBpId: string | null = null;
    if (route === 'legalbp') {
      const effectiveDomain = skillGroup ?? domain ?? null;
      legalBpId = await this.matchLegalBp(effectiveDomain);
    }

    // 2. 创建工单（幂等键唯一约束兜底：并发重试撞键 → P2002 → 返回已存在工单）
    let project;
    try {
      project = await this.prisma.project.create({
        data: {
          kind: dto.kind,
          title: dto.title,
          status: '分析中',
          risk,
          route,
          creatorId: currentUserId,
          ownerId: currentUserId, // 初始 owner = creator
          legalBpId, // 2026-08-05：意图识别匹配的 BP（创建即指派 → 拉群）
          skillId,
          skillName,
          requesterName: dto.requesterName ?? null,
          requesterDepartment: dto.requesterDepartment ?? null,
          crmReference: dto.crmReference ?? null,
          idempotencyKey: dto.idempotencyKey ?? null,
          extra: skillPrompt ? { skillPrompt } : Prisma.JsonNull,
        },
        include: { creator: { select: userSelect }, owner: { select: userSelect } },
      });
    } catch (e: any) {
      if (dto.idempotencyKey && e?.code === 'P2002') {
        const existing = await this.prisma.project.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: { creator: { select: userSelect }, owner: { select: userSelect } },
        });
        if (existing) return this.formatProject(existing);
      }
      throw e;
    }

    // 3. 存入用户第一条消息
    await this.prisma.projectMessage.create({
      data: { projectId: project.id, role: 'user', text: dto.input },
    });

    // 技能解析失败的用户可见反馈（工程评审决策 #6："记录日志事件"）
    // dto.skillId 提供但解析失败（不存在/停用/无权）→ 工单事件提示按通用口径答复
    if (dto.skillId && !skillId) {
      await this.addEvent(project.id, this.formatTime() + ' · 所选技能不可用，已按通用口径答复');
    }

    // 4. 存入事件
    await this.addEvent(project.id, this.formatTime() + ' · 工单已创建');
    await this.addEvent(
      project.id,
      `系统判定 ${risk} 风险${route === 'llm' ? '，AI 正在生成答复…' : '，已通知法务 BP'}`,
    );

    // 5. 钉钉拉群（仅 legalbp；同步 await——工程评审决策：create() 同步，接口 +1-3s 可接受）
    if (route === 'legalbp') {
      await this.ensureDingTalkGroup(project.id, project.title, currentUserId, legalBpId, risk, dto.requesterName ?? null);
    }

    // 6. P2 + llm 路由：触发 AI 答复
    if (route === 'llm') {
      // 异步触发 AI，不阻塞响应。ChildProcess 错误由 on('error') 处理
      this.triggerAIResponse(project.id, dto.input).catch((e) =>
        this.logger.error(`AI 触发失败：${e}`),
      );
    }

    // /review 2026-08-05 脱敏：extra（技能 prompt 快照）不随响应返回
    return this.formatProject(project);
  }

  /** 工单响应脱敏：extra（技能 prompt 快照）不返回；route/risk 冗余展开（P1-03 幂等返回复用） */
  private formatProject(project: any) {
    const { extra: _extra, ...safeProject } = project;
    return { ...safeProject, route: project.route, risk: project.risk };
  }

  /** 工单列表 — include 预加载 User */
  async findAll(params: {
    status?: ProjectStatus;
    kind?: ProjectKind;
    ownerId?: string;
    creatorId?: string;
    legalBpId?: string;
    page?: number;
    size?: number;
  }) {
    const { status, kind, ownerId, creatorId, legalBpId, page = 1, size = 20 } = params;
    const where: Prisma.ProjectWhereInput = {};

    if (status) where.status = status;
    if (kind) where.kind = kind;
    if (ownerId) where.ownerId = ownerId;
    if (creatorId) where.creatorId = creatorId;
    if (legalBpId) where.legalBpId = legalBpId;

    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        include: {
          creator: { select: userSelect },
          owner: { select: userSelect },
          legalBp: { select: userSelect },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.project.count({ where }),
    ]);

    // /review 2026-08-05 脱敏：extra（技能 prompt 快照）不随列表响应返回（items 与 groups 同源）
    const safeItems = items.map(({ extra: _extra, ...rest }) => rest);

    // 按状态分组
    const groups: Record<string, typeof safeItems> = {
      待处理: [],
      合同协作: [],
      已回传: [],
      数字分身处理: [],
    };
    // 先按 kind=contract 分到「合同协作」（无论 route），避免 route=llm 的合同草稿
    // 错误进入「数字分身处理」（工程评审决策 #8）
    for (const p of safeItems) {
      if (p.kind === 'contract') groups['合同协作'].push(p);
      else if (p.route === 'llm') groups['数字分身处理'].push(p);
      else if (p.status === '已回传' || p.status === '已取消') groups['已回传'].push(p);
      else groups['待处理'].push(p);
    }

    return { items: safeItems, groups, total, page, size };
  }

  /** 工单详情 — 含消息和事件 */
  async findOne(id: string, currentUserId?: string, currentRole?: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        creator: { select: userSelect },
        owner: { select: userSelect },
        legalBp: { select: userSelect },
        messages: { orderBy: { createdAt: 'asc' }, take: 200 },
        events: { orderBy: { createdAt: 'asc' }, take: 100 },
        files: {
          include: { uploader: { select: { displayName: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!project) throw new NotFoundException('工单不存在');

    // 权限：法务 BP 只能看自己的工单；业务人员只能看自己创建的
    if (currentUserId && currentRole === 'business' && project.creatorId !== currentUserId) {
      throw new ForbiddenException('无权查看此工单');
    }
    if (
      currentUserId &&
      (currentRole === 'legal_bp' || currentRole === 'legal_lead') &&
      project.legalBpId &&
      project.legalBpId !== currentUserId &&
      project.ownerId !== currentUserId
    ) {
      // 法务端可查看但没有被分配的工单 — 允许查看但提示
    }

    // /review 2026-08-05 脱敏：extra（技能 prompt 快照）不随详情响应返回
    const { extra: _extra, ...safeProject } = project;
    return safeProject;
  }

  /** 更新工单（状态/转派/风险/回传）— 2026-08-05：角色校验 + 转派加人 + route 补建群 */
  async update(id: string, dto: UpdateProjectDto) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');

    // 角色校验（工程评审决策 #3）：legalBpId 只能设为法务 BP/负责人（现状 PATCH 无校验）
    if (dto.legalBpId) {
      const bp = await this.prisma.user.findUnique({ where: { id: dto.legalBpId } });
      if (!bp || (bp.role !== 'legal_bp' && bp.role !== 'legal_lead')) {
        throw new ForbiddenException('目标用户不是法务 BP');
      }
    }

    const updated = await this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.status && { status: dto.status }),
        ...(dto.risk && { risk: dto.risk }),
        ...(dto.ownerId && { ownerId: dto.ownerId }),
        ...(dto.legalBpId && { legalBpId: dto.legalBpId }),
        ...(dto.route && { route: dto.route }),
        ...(dto.result && { result: dto.result }),
      },
      include: {
        creator: { select: userSelect },
        owner: { select: userSelect },
        legalBp: { select: userSelect },
      },
    });

    // 钉钉联动（工程评审决策 #2/#4）：
    // - legalBpId 变更 → 新 BP 进群（异步，不阻塞 PATCH 响应；.catch 防崩溃）
    if (dto.legalBpId && dto.legalBpId !== project.legalBpId) {
      void this.onLegalBpChanged(id, dto.legalBpId, project.legalBpId).catch((e) =>
        this.logger.error(`转派加群失败（${id}）：${e}`),
      );
    }
    // - route 变更 llm→legalbp → 补建群（完整匹配链：重新匹配 BP，/review 2026-08-05 修复）
    if (dto.route === 'legalbp' && project.route !== 'legalbp') {
      const bpId = await this.matchLegalBp(null);
      let bpForGroup = updated.legalBpId;
      if (bpId && bpId !== updated.legalBpId) {
        await this.prisma.project.update({ where: { id }, data: { legalBpId: bpId } });
        bpForGroup = bpId;
      }
      void this.ensureDingTalkGroup(id, updated.title, updated.creatorId, bpForGroup, updated.risk, null).catch((e) =>
        this.logger.error(`补建群失败（${id}）：${e}`),
      );
    }

    return updated;
  }

  /** 取消工单 */
  async cancel(id: string, currentUserId: string) {
    const updated = await this.prisma.project.updateMany({
      where: { id, creatorId: currentUserId, status: { notIn: ['已取消', '已回传'] } },
      data: { status: '已取消' },
    });
    if (updated.count === 0) {
      throw new ForbiddenException('只能取消自己创建的、未完成或未取消的工单');
    }
    await this.addEvent(id, this.formatTime() + ' · 工单已取消');

    return { status: '已取消' };
  }

  /** 转派给另一个法务 BP（2026-08-05：新 BP 自动进群，工程评审决策 #2/#15——旧 BP 留群） */
  async transfer(id: string, legalBpId: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');

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

    // 钉钉：新 BP 进群（先加人成功再通知——工程评审决策 #15 顺序）
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

  /** 发送消息 — P2+llm 路由调用 CodexService SSE，P1/P0 只存消息 */
  async createMessage(
    projectId: string,
    dto: CreateProjectMessageDto,
    currentUserId: string,
  ): Promise<{ message: any; stream?: ChildProcess; route: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');

    const role = dto.role || 'user';

    // 1. 存入用户消息
    const message = await this.prisma.projectMessage.create({
      data: { projectId, role, text: dto.text },
    });

    // 2. 根据路由决定后续
    if (project.route === 'llm' && role === 'user') {
      // P2 追问：重新风险判定
      const { risk, route, domain } = await this.riskService.assess(dto.text);

      if (route === 'legalbp') {
        // 追问触发升级 → 切换路由 + 通知法务BP
        const updated = await this.prisma.project.update({
          where: { id: projectId },
          data: { route: 'legalbp', status: '待复核', risk },
        });
        await this.addEvent(
          projectId,
          this.formatTime() + ` · 追问触发 ${risk} 风险判定，已升级人工处理`,
        );
        // 钉钉：补建群（完整匹配链——llm 工单创建时 legalBpId 恒 null，升级时按新领域
        // 重新匹配指派，最紧急的工单群里必须有 BP 认领，工程评审决策 #1；/review 2026-08-05 修复）
        const bpId = await this.matchLegalBp(domain ?? null);
        let bpForGroup = updated.legalBpId;
        if (bpId && bpId !== updated.legalBpId) {
          await this.prisma.project.update({
            where: { id: projectId },
            data: { legalBpId: bpId },
          });
          bpForGroup = bpId;
        }
        // 异步 fire-and-forget：不挂住 SSE 消息流（工程评审决策 #14）；必须 .catch 防 unhandled rejection 崩溃
        void this.ensureDingTalkGroup(projectId, updated.title, updated.creatorId, bpForGroup, risk, null).catch((e) =>
          this.logger.error(`升级补建群失败：${e}`),
        );
        // 已有群则通知
        try {
          if (project.dingtalkChatId) {
            await this.dingtalk.sendNotification(project.dingtalkChatId, `工单已升级为 ${risk} 风险，需法务 BP 处理`);
          }
        } catch (e) {
          this.logger.warn(`钉钉通知失败：${e}`);
        }
        return { message, route: 'legalbp' };
      }

      return { message, route: 'llm', stream: await this.triggerAIResponse(projectId, dto.text) };
    }

    return { message, route: project.route };
  }

  /** 法务 BP 正式回传 */
  async reply(projectId: string, dto: ReplyProjectDto, currentUserId: string) {
    // 原子化状态流转：只有 待复核 状态才能回传
    const updated = await this.prisma.project.updateMany({
      where: { id: projectId, status: '待复核' },
      data: { status: '已回传', result: dto.text, legalBpId: currentUserId },
    });
    if (updated.count === 0) {
      throw new ForbiddenException('只有待复核状态的工单才能回传');
    }

    // 重新读取 project 用于后续操作
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('工单不存在');

    // 存入法务回复
    await this.prisma.projectMessage.create({
      data: { projectId, role: 'legal', text: dto.text, label: '法务BP 正式回复' },
    });

    // 事件
    await this.addEvent(projectId, this.formatTime() + ' · 已回传业务端');
    await this.addEvent(projectId, this.formatTime() + ' · 通知业务端 + 钉钉群同步');

    // 钉钉：回传即认领（legalBpId = 回传人）→ 若此前不在群则加人（工程评审决策 #2 三处检测；.catch 防崩溃）
    if (currentUserId !== project.legalBpId) {
      void this.onLegalBpChanged(projectId, currentUserId, project.legalBpId).catch((e) =>
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
      if (project.dingtalkChatId) {
        await this.dingtalk.sendNotification(project.dingtalkChatId, '工单已回传');
      }
    } catch (e) {
      this.logger.warn(`钉钉通知失败：${e}`);
    }

    return { status: '已回传' };
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /** 触发 AI 生成答复 — 返回 ChildProcess 供 SSE 流式 */
  private async triggerAIResponse(projectId: string, userQuery: string): Promise<ChildProcess> {
    // 技能注入：优先读工单快照 extra.skillPrompt（在途多轮对话行为稳定，工程评审决策 #2）
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

    const child = this.codexService.executeStream(prompt, { timeout: 120_000, sessionId: projectId });
    let fullText = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      fullText += chunk.toString();
    });

    child.on('close', async (code) => {
      if (code === 0 && fullText.trim()) {
        // 流结束 → 一次性落库
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
        // AI 失败 → 转待处理
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
  // 钉钉拉群（2026-08-05）
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
    // 兜底：第一个已绑定钉钉的法务负责人（工程评审决策 #4——最该人工处理的工单群里必须有人）
    const lead = await this.prisma.user.findFirst({
      where: { role: 'legal_lead', dingtalkUserId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return lead?.id ?? null;
  }

  /**
   * 建群链（原子认领 + 幂等，/review 2026-08-05 重构）：
   * 1. 原子认领：updateMany(where dingtalkChatId:null → 占位 'PENDING')，count=0 说明已被
   *    并发入口认领或已有群 → 直接返回（防重复群/孤儿群，对抗性评审 #2）
   * 2. 成员 = creator + BP（去重）；无法务角色成员 → 释放认领 + 事件（工程评审决策 #9）
   * 3. 建群成功写真实 chatId + 成员 reconciliation（对照当前 legalBpId 补拉——防升级建群
   *    在途时转派漏加新 BP，对抗性评审 #8）
   * 4. 失败释放认领（恢复 null 可重试）；同步 await（create）或异步（升级/转派路径）。
   */
  private async ensureDingTalkGroup(
    projectId: string,
    title: string,
    creatorUserId: string,
    legalBpId: string | null,
    risk: RiskLevel,
    requesterName: string | null,
  ): Promise<void> {
    const release = async () => {
      await this.prisma.project
        .updateMany({ where: { id: projectId, dingtalkChatId: 'PENDING' }, data: { dingtalkChatId: null } })
        .catch((e: any) => this.logger.warn(`释放建群认领失败（${projectId}）：${e}`));
    };
    try {
      // 1. 原子认领（唯一得手者继续）
      const claimed = await this.prisma.project.updateMany({
        where: { id: projectId, dingtalkChatId: null },
        data: { dingtalkChatId: 'PENDING' },
      });
      if (claimed.count === 0) return; // 已有群或已被并发认领

      // 2. 成员解析：creator（提出人）+ 指派 BP
      const [creator, bp] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: creatorUserId },
          select: { dingtalkUserId: true, displayName: true },
        }),
        legalBpId
          ? this.prisma.user.findUnique({
              where: { id: legalBpId },
              select: { dingtalkUserId: true, displayName: true },
            })
          : Promise.resolve(null),
      ]);

      const memberUserIds = [creator?.dingtalkUserId, bp?.dingtalkUserId]
        .filter((u): u is string => !!u);
      const memberIds = [...new Set(memberUserIds)]; // 去重（owner 可能等于 creator 场景）

      // 无法务角色成员 → 不建群（工程评审决策 #9：单业务成员群无触达价值）
      const legalUserIds = (bp?.dingtalkUserId ? [bp.dingtalkUserId] : []);
      if (!legalUserIds.length) {
        await release();
        await this.addEvent(
          projectId,
          this.formatTime() + ' · 未匹配到已绑定钉钉的法务 BP，请人工建群',
        );
        this.logger.warn(`工单 ${projectId} 无法务成员，跳过建群`);
        return;
      }

      // 3. 建群 + 落库（群名：工单#<id前6位> <标题>，适配器内截断 ≤20 字，工程评审决策 #5）
      // dedupKey = legalos-{projectId}：建群去重，同一工单重试只建一个群（P1-03）
      const group = await this.dingtalk.createGroup(
        memberIds,
        `工单#${projectId.slice(0, 6)} ${title}`,
        creator?.dingtalkUserId || undefined,
        `legalos-${projectId}`,
      );
      await this.prisma.project.update({
        where: { id: projectId },
        data: { dingtalkChatId: group.chatId, dingtalkMembers: JSON.stringify(group.members) },
      });
      // 成员 reconciliation（对抗性评审 #8）：建群在途期间 legalBpId 可能已被转派修改
      await this.reconcileGroupMembers(projectId, group.chatId, group.members);
      await this.addEvent(
        projectId,
        this.formatTime() + ` · 钉钉群已创建${this.isMock() ? '（模拟）' : ''}`,
      );

      // 首条消息（纯文字，工程评审决策：无链接）：工单标题 + 风险 + 提出人
      try {
        const requester = requesterName || creator?.displayName || '业务人员';
        await this.dingtalk.sendNotification(
          group.chatId,
          `【法律咨询工单】${title}\n风险等级：${risk}\n提出人：${requester}`,
        );
      } catch (e) {
        // 群已建但首条消息失败——可观测（工程评审决策 #F2）
        await this.addEvent(
          projectId,
          this.formatTime() + ' · 群已创建但首条消息发送失败，请检查机器人配置',
        );
        this.logger.warn(`首条消息发送失败：${e}`);
      }
    } catch (e) {
      // 拉群失败不阻断工单（沿用 try/catch 模式，新增事件记录——工程评审决策 #CS4）
      // /review 2026-08-05：事件只写通用文案，原始错误仅日志（避免钉钉错误细节暴露给业务用户）
      await release();
      await this.addEvent(projectId, this.formatTime() + ' · 钉钉拉群失败，请人工建群');
      this.logger.warn(`钉钉拉群失败（工单 ${projectId}）：${e}`);
    }
  }

  /** 成员 reconciliation：对照工单当前 legalBpId 补拉缺员（建群在途被转派场景，对抗性评审 #8） */
  private async reconcileGroupMembers(projectId: string, chatId: string, currentMembers: string[]) {
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { legalBpId: true },
      });
      if (!project?.legalBpId) return;
      const bp = await this.prisma.user.findUnique({
        where: { id: project.legalBpId },
        select: { dingtalkUserId: true, displayName: true },
      });
      if (!bp?.dingtalkUserId || currentMembers.includes(bp.dingtalkUserId)) return;
      await this.dingtalk.addMember(chatId, bp.dingtalkUserId);
      const members = [...currentMembers, bp.dingtalkUserId];
      await this.prisma.project.update({
        where: { id: projectId },
        data: { dingtalkMembers: JSON.stringify(members) },
      });
      this.logger.log(`reconciliation：${bp.displayName} 已补拉入群（${projectId}）`);
    } catch (e) {
      this.logger.warn(`成员 reconciliation 失败（${projectId}）：${e}`);
    }
  }

  /** 转派/认领检测（三处共用：transfer/update/reply——工程评审决策 #2）：新 BP 进群，旧 BP 留群 */
  private async onLegalBpChanged(projectId: string, newBpId: string, oldBpId: string | null) {
    if (!newBpId || newBpId === oldBpId) return;
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { dingtalkChatId: true, dingtalkMembers: true },
      });
      if (!project?.dingtalkChatId) return; // 无群跳过（从未建群工单不在此路径）

      const bp = await this.prisma.user.findUnique({
        where: { id: newBpId },
        select: { dingtalkUserId: true, displayName: true },
      });
      if (!bp?.dingtalkUserId) {
        await this.addEvent(
          projectId,
          this.formatTime() + ` · ${bp?.displayName || '新法务 BP'} 未绑定钉钉，无法加入群`,
        );
        return;
      }
      await this.dingtalk.addMember(project.dingtalkChatId, bp.dingtalkUserId);
      // 同步 dingtalkMembers（append 新成员，避免列表展示过时）
      let members: string[] = [];
      try {
        members = JSON.parse(project.dingtalkMembers || '[]');
      } catch {}
      if (!members.includes(bp.dingtalkUserId)) members.push(bp.dingtalkUserId);
      await this.prisma.project.update({
        where: { id: projectId },
        data: { dingtalkMembers: JSON.stringify(members) },
      });
      await this.addEvent(
        projectId,
        this.formatTime() + ` · ${bp.displayName} 已加入钉钉群${this.isMock() ? '（模拟）' : ''}`,
      );
    } catch (e) {
      // /review 2026-08-05：事件只写通用文案，原始错误仅日志
      await this.addEvent(projectId, this.formatTime() + ' · 转派加群失败，请人工处理');
      this.logger.warn(`转派加群失败（工单 ${projectId}）：${e}`);
    }
  }

  /** Mock 开关（事件文案区分模拟/真实，工程评审决策 #17） */
  private isMock(): boolean {
    return process.env.DINGTALK_MOCK === 'true';
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
