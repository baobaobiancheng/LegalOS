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

  /** 创建工单 — 含风险判定 + 路由 + 钉钉通知 */
  async create(dto: CreateProjectDto, currentUserId: string) {
    // 1. 风险判定
    const { risk, route } = await this.riskService.assess(dto.input);

    // 2. 创建工单
    const project = await this.prisma.project.create({
      data: {
        kind: dto.kind,
        title: dto.title,
        status: '分析中',
        risk,
        route,
        creatorId: currentUserId,
        ownerId: currentUserId, // 初始 owner = creator
        skillId: dto.skillId ?? null,
        skillName: dto.skillName ?? null,
        requesterName: dto.requesterName ?? null,
        requesterDepartment: dto.requesterDepartment ?? null,
        crmReference: dto.crmReference ?? null,
      },
      include: { creator: { select: userSelect }, owner: { select: userSelect } },
    });

    // 3. 存入用户第一条消息
    await this.prisma.projectMessage.create({
      data: { projectId: project.id, role: 'user', text: dto.input },
    });

    // 4. 存入事件
    await this.addEvent(project.id, this.formatTime() + ' · 工单已创建');
    await this.addEvent(
      project.id,
      `系统判定 ${risk} 风险${route === 'llm' ? '，AI 正在生成答复…' : '，已通知法务 BP'}`,
    );

    // 5. 钉钉拉群通知（Mock）
    try {
      const group = await this.dingtalk.createGroup(
        [dto.requesterName || '业务人员', 'Pending BP'],
        dto.title,
      );
      await this.prisma.project.update({
        where: { id: project.id },
        data: { dingtalkChatId: group.chatId, dingtalkMembers: JSON.stringify(group.members) },
      });
      await this.addEvent(project.id, this.formatTime() + ' · 钉钉群已创建（模拟）');
    } catch (e) {
      this.logger.warn(`钉钉拉群失败（Mock）：${e}`);
    }

    // 6. P2 + llm 路由：触发 AI 答复
    if (route === 'llm') {
      // 异步触发 AI，不阻塞响应。ChildProcess 错误由 on('error') 处理
      this.triggerAIResponse(project.id, dto.input);
    }

    return { ...project, route, risk };
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

    // 按状态分组
    const groups: Record<string, typeof items> = {
      待处理: [],
      合同协作: [],
      已回传: [],
      数字分身处理: [],
    };
    // 先按 kind=contract 分到「合同协作」（无论 route），避免 route=llm 的合同草稿
    // 错误进入「数字分身处理」（工程评审决策 #8）
    for (const p of items) {
      if (p.kind === 'contract') groups['合同协作'].push(p);
      else if (p.route === 'llm') groups['数字分身处理'].push(p);
      else if (p.status === '已回传' || p.status === '已取消') groups['已回传'].push(p);
      else groups['待处理'].push(p);
    }

    return { items, groups, total, page, size };
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

    return project;
  }

  /** 更新工单（状态/转派/风险/回传） */
  async update(id: string, dto: UpdateProjectDto) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('工单不存在');

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

  /** 转派给另一个法务 BP */
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

    // 钉钉通知
    try {
      if (project.dingtalkChatId) {
        await this.dingtalk.sendNotification(
          project.dingtalkChatId,
          `工单已转派给 ${bp.displayName}`,
        );
      }
    } catch (e) {
      this.logger.warn(`钉钉通知失败（Mock）：${e}`);
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
      const { risk, route } = await this.riskService.assess(dto.text);

      if (route === 'legalbp') {
        // 追问触发升级 → 切换路由 + 通知法务BP
        await this.prisma.project.update({
          where: { id: projectId },
          data: { route: 'legalbp', status: '待复核', risk },
        });
        await this.addEvent(
          projectId,
          this.formatTime() + ` · 追问触发 ${risk} 风险判定，已升级人工处理`,
        );
        // 钉钉通知
        try {
          if (project.dingtalkChatId) {
            await this.dingtalk.sendNotification(project.dingtalkChatId, `工单已升级为 ${risk} 风险，需法务 BP 处理`);
          }
        } catch (e) {
          this.logger.warn(`钉钉通知失败（Mock）：${e}`);
        }
        return { message, route: 'legalbp' };
      }

      return { message, route: 'llm', stream: this.triggerAIResponse(projectId, dto.text) };
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
      this.logger.warn(`钉钉通知失败（Mock）：${e}`);
    }

    return { status: '已回传' };
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /** 触发 AI 生成答复 — 返回 ChildProcess 供 SSE 流式 */
  private triggerAIResponse(projectId: string, userQuery: string): ChildProcess {
    const prompt = this.buildConsultPrompt(userQuery);

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

  /** 构建业务咨询 prompt */
  private buildConsultPrompt(userQuery: string): string {
    return `## Role
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
- 不引用具体法条号（除非用户追问）
- 只说你能确定的事，不确定的事项放在"需补充确认"
- 如果问题超出法务范围（如税务、财务），明确告知并建议联系对应部门
- 每条答复末尾追加免责声明："> ⚠️ 本答复由AI生成，不构成正式法律意见。如需正式法务意见，请联系法务BP确认。"

## User Query
${userQuery}`;
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
