import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Role, SkillVisibility, Skill, Prisma } from '@prisma/client';
import { pinyin } from 'pinyin';
import { CreateSkillDto, UpdateSkillDto, ReviewSkillDto } from './dto/skill.dto';
import { RESERVED_SLUGS } from '../../common/constants/skill.constants';

// 用户选择器，避免暴露敏感字段
const userSelect = { id: true, username: true, displayName: true, role: true };

/**
 * 技能库服务（2026-08-04 技能库模块）。
 *
 * 状态机（ASCII）：
 *   private ──submit──> pending ──review(approve)──> public
 *      ^                  │
 *      └─────withdraw/reject────┘
 *
 * 规则（设计文档 §2/§7）：
 * - private 仅创建者可见可编辑（含 lead/admin 均不可见他人私有）
 * - pending 不可编辑/不可停用（审核中的快照不可改）；创建者可撤回，lead/admin 可审核
 * - public 编辑权仅 lead/admin；business 响应剥离 prompt
 * - 全部状态变更用条件更新（WHERE visibility=...），影响 0 行 → 409（并发防护）
 * - 审核记录 append-only（reviewLog Json 数组），驳回历史不覆盖丢失（工程评审决策 OV#2）
 */
@Injectable()
export class SkillService {
  private readonly logger = new Logger(SkillService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════
  // 注册 / 列表 / 详情
  // ═══════════════════════════════════════════

  /** 注册技能：slug 校验（保留字/格式）+ 唯一冲突处理 + 默认 private */
  async create(dto: CreateSkillDto, userId: string, role: Role) {
    // 保留字拦截（工程评审决策 OV#2：general + seed slug 禁注册）
    if (dto.slug && RESERVED_SLUGS.includes(dto.slug)) {
      throw new BadRequestException(`slug "${dto.slug}" 为系统保留，请更换`);
    }

    // slug：提供则用，未提供则 pinyin 自动生成；冲突时 -2/-3 递增重试
    let slug = dto.slug?.trim() || '';
    if (!slug) {
      slug = this.slugifyName(dto.name);
      // 自动生成遇到保留字则追加后缀
      if (RESERVED_SLUGS.includes(slug)) slug = `${slug}-custom`;
    }

    // lead/admin 可直接建公有；普通 BP 强制 private
    const visibility: SkillVisibility =
      dto.visibility === 'public' && this.isLead(role)
        ? 'public'
        : 'private';

    const base = {
      name: dto.name,
      group: dto.group,
      description: dto.description ?? '',
      prompt: dto.prompt,
      visibility,
      creatorId: userId,
      approvedBy: visibility === 'public' ? userId : null,
      approvedAt: visibility === 'public' ? new Date() : null,
      reviewLog: [],
    };

    // 手填 slug：一次尝试，冲突即 409
    if (dto.slug) {
      try {
        return await this.prisma.skill.create({ data: { ...base, slug } });
      } catch (e) {
        if (this.isUniqueViolation(e)) throw new ConflictException('slug 已被占用');
        throw e;
      }
    }

    // 自动生成 slug：冲突递增后缀重试（工程评审决策 #8）
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
      try {
        return await this.prisma.skill.create({ data: { ...base, slug: candidate } });
      } catch (e) {
        if (!this.isUniqueViolation(e)) throw e;
        // 冲突 → 下一轮换后缀
      }
    }
    throw new ConflictException('slug 生成冲突过多，请手动指定');
  }

  /**
   * 列表。scope=public|mine|pending|usable，group 筛选。
   * 列表响应一律剥离 prompt（选择器/列表不需要；编辑用详情接口）——核心资产最小暴露。
   */
  async list(scope: string, group: string | undefined, userId: string, role: Role) {
    const where: Prisma.SkillWhereInput = {};

    if (scope === 'mine') {
      where.creatorId = userId;
      // 我的技能包含全部状态（含已停用，展示"已停用"徽标）
      if (group) where.group = group;
    } else if (scope === 'pending') {
      // 待审核列表仅审核人可见（工程评审决策：审核流治理）
      if (!this.isLead(role)) {
        throw new ForbiddenException('无权查看待审核列表');
      }
      where.visibility = 'pending';
      where.isActive = true;
      if (group) where.group = group;
    } else {
      // public / usable
      where.visibility = 'public';
      where.isActive = true;
      if (group) where.group = group;
      if (scope === 'usable') {
        // 可用列表 = 公有 + 自己的私有（业务端仅公有 + 兜底由前端处理）
        where.OR = [{ visibility: 'public' }, { creatorId: userId, visibility: 'private' }];
      }
    }

    const items = await this.prisma.skill.findMany({
      where,
      include: {
        creator: { select: userSelect },
        approver: { select: userSelect },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 列表剥离 prompt + 按可见性过滤（私有硬边界，工程评审决策 #6）；
    // 我的技能保留 reviewLog（驳回原因直接展示，无需逐条 detail）；其余 scope 剥离
    return items
      .filter((s) => this.canView(s, userId, role))
      .map(({ prompt, reviewLog, ...rest }) =>
        scope === 'mine' ? { ...rest, reviewLog } : rest,
      );
  }

  /** 详情（审核页需要 prompt 全文；business 剥离） */
  async detail(id: string, userId: string, role: Role) {
    const skill = await this.prisma.skill.findUnique({
      where: { id },
      include: { creator: { select: userSelect }, approver: { select: userSelect } },
    });
    if (!skill) throw new NotFoundException('技能不存在');
    if (!this.canView(skill, userId, role)) throw new ForbiddenException('无权查看此技能');

    const { reviewLog, ...rest } = skill;
    const result: any = { ...rest, reviewLog };
    if (role === Role.business) {
      // business 剥离 prompt + 审核记录（核心资产与内部治理信息最小暴露）
      delete result.prompt;
      delete result.reviewLog;
    }
    return result;
  }

  // ═══════════════════════════════════════════
  // 编辑 / 状态机流转
  // ═══════════════════════════════════════════

  /** 编辑：private 仅创建者 / public 仅 lead/admin / pending 不可编辑 */
  async update(id: string, dto: UpdateSkillDto, userId: string, role: Role) {
    const skill = await this.mustGet(id);
    if (skill.visibility === 'pending') {
      throw new ConflictException('审核中的技能不可编辑，请先撤回');
    }
    const canEdit =
      skill.visibility === 'private'
        ? skill.creatorId === userId
        : this.isLead(role);
    if (!canEdit) throw new ForbiddenException('无权编辑此技能');

    return this.prisma.skill.update({
      where: { id },
      data: {
        name: dto.name ?? skill.name,
        group: dto.group ?? skill.group,
        description: dto.description ?? skill.description,
        prompt: dto.prompt ?? skill.prompt,
      },
    });
  }

  /** 提交审核：private → pending（仅创建者，条件更新） */
  async submit(id: string, userId: string) {
    const updated = await this.prisma.skill.updateMany({
      where: { id, creatorId: userId, visibility: 'private' },
      data: { visibility: 'pending' },
    });
    if (updated.count === 0) {
      const skill = await this.prisma.skill.findUnique({ where: { id } });
      if (!skill) throw new NotFoundException('技能不存在');
      throw skill.creatorId === userId
        ? new ConflictException('只有私有状态的技能可提交审核')
        : new ForbiddenException('无权操作此技能');
    }
    return { id, visibility: 'pending' };
  }

  /** 撤回：pending → private（仅创建者，条件更新） */
  async withdraw(id: string, userId: string) {
    const updated = await this.prisma.skill.updateMany({
      where: { id, creatorId: userId, visibility: 'pending' },
      data: { visibility: 'private' },
    });
    if (updated.count === 0) {
      const skill = await this.prisma.skill.findUnique({ where: { id } });
      if (!skill) throw new NotFoundException('技能不存在');
      throw skill.creatorId === userId
        ? new ConflictException('只有待审核状态的技能可撤回')
        : new ForbiddenException('无权操作此技能');
    }
    return { id, visibility: 'private' };
  }

  /** 审核：pending → public（approve）/ private（reject，reason 必填）。条件更新 + reviewLog append-only */
  async review(id: string, dto: ReviewSkillDto, userId: string) {
    if (!dto.approved && !dto.reason?.trim()) {
      throw new BadRequestException('驳回必须填写原因');
    }

    // 条件更新：只有 pending 才能被审核（并发防护，工程评审决策 C-3）
    const updated = await this.prisma.skill.updateMany({
      where: { id, visibility: 'pending' },
      data: dto.approved
        ? { visibility: 'public', approvedBy: userId, approvedAt: new Date() }
        : { visibility: 'private', approvedBy: null, approvedAt: null },
    });
    if (updated.count === 0) {
      const skill = await this.prisma.skill.findUnique({ where: { id } });
      if (!skill) throw new NotFoundException('技能不存在');
      throw new ConflictException('只有待审核状态的技能可审核');
    }

    // append-only 审核记录（不覆盖历史驳回原因）
    await this.appendReviewLog(id, dto.approved ? 'approve' : 'reject', userId, dto.reason);

    return { id, visibility: dto.approved ? 'public' : 'private' };
  }

  /** 停用（pending 不可停用，须先撤回） */
  async archive(id: string, userId: string, role: Role) {
    const skill = await this.mustGet(id);
    if (skill.visibility === 'pending') {
      throw new ConflictException('审核中的技能不可停用，请先撤回');
    }
    this.assertOwnerOrLead(skill, userId, role);

    const updated = await this.prisma.skill.updateMany({
      where: { id, isActive: true },
      data: { isActive: false },
    });
    if (updated.count === 0) throw new ConflictException('技能已处于停用状态');
    return { id, isActive: false };
  }

  /** 恢复 */
  async restore(id: string, userId: string, role: Role) {
    const skill = await this.mustGet(id);
    this.assertOwnerOrLead(skill, userId, role);

    const updated = await this.prisma.skill.updateMany({
      where: { id, isActive: false },
      data: { isActive: true },
    });
    if (updated.count === 0) throw new ConflictException('技能未处于停用状态');
    return { id, isActive: true };
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /** 审核人角色判断（legal_lead / admin） */
  private isLead(role: Role): boolean {
    return role === Role.legal_lead || role === Role.admin;
  }

  /** 私有硬边界（工程评审决策 #6）：private 仅创建者可见；pending 创建者+审核人；public 全员 */
  private canView(skill: Skill, userId: string, role: Role): boolean {
    if (skill.visibility === 'private') return skill.creatorId === userId;
    if (skill.visibility === 'pending') {
      return skill.creatorId === userId || this.isLead(role);
    }
    return true; // public
  }

  /** 停用/恢复权限：创建者（自己的私有或公有）+ lead/admin */
  private assertOwnerOrLead(skill: Skill, userId: string, role: Role) {
    const isOwner = skill.creatorId === userId;
    const isLead = this.isLead(role);
    if (!isOwner && !isLead) throw new ForbiddenException('无权操作此技能');
  }

  private async mustGet(id: string): Promise<Skill> {
    const skill = await this.prisma.skill.findUnique({ where: { id } });
    if (!skill) throw new NotFoundException('技能不存在');
    return skill;
  }

  /** append-only 审核记录：读当前数组 → 追加 → 写回（驳回历史不覆盖，OV#2） */
  private async appendReviewLog(
    id: string,
    action: 'approve' | 'reject',
    reviewerId: string,
    reason?: string,
  ) {
    try {
      const skill = await this.prisma.skill.findUnique({ where: { id } });
      const log = Array.isArray(skill?.reviewLog) ? (skill.reviewLog as any[]) : [];
      log.push({
        action,
        reviewerId,
        reason: reason?.trim() ?? null,
        at: new Date().toISOString(),
      });
      await this.prisma.skill.update({ where: { id }, data: { reviewLog: log } });
    } catch (e) {
      // 审核记录失败不阻断主流程（可降级：仅当前审核结果生效）
      this.logger.warn(`reviewLog 追加失败：${e}`);
    }
  }

  /** Prisma 唯一约束冲突判断（P2002） */
  private isUniqueViolation(e: unknown): boolean {
    return (
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
    );
  }

  /** 中文名 → slug（pinyin 库固定版本，多音字取常用读音；工程评审决策 #8） */
  private slugifyName(name: string): string {
    try {
      const py = pinyin(name, { style: 'normal', heteronym: false })
        .map((arr) => arr[0])
        .join('-');
      const slug = py
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
      return slug || 'skill';
    } catch {
      return 'skill'; // pinyin 不可用时兜底
    }
  }
}
