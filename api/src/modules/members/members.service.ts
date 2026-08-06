import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DINGTALK_ADAPTER,
  DingTalkAdapter,
} from '../project/adapters/adapter.interfaces';
import { isBpDomain, BP_DOMAINS } from './dto/members.dto';

/**
 * 管理端成员管理（2026-08-05 钉钉拉群模块）：
 * - syncContacts：拉钉钉通讯录 → 落快照表 → 按真实姓名自动匹配绑定（重名落手动）
 * - bind：手动绑定（快照搜索）
 * - BP 领域映射 CRUD：法务 BP × 6 领域白名单
 * - failures：拉群失败工单计数（dingtalkChatId 为空的 legalbp 工单）
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DINGTALK_ADAPTER) private readonly dingtalk: DingTalkAdapter,
  ) {}

  /** 一键同步：拉全量 → 快照 upsert → 姓名自动匹配绑定（重名 → 落手动，工程评审决策 #CR4） */
  async syncContacts() {
    const contacts = await this.dingtalk.syncContacts();

    // 1. 快照落库（upsert by 钉钉 userid）
    for (const c of contacts) {
      await this.prisma.dingTalkContact.upsert({
        where: { userId: c.userId },
        update: { name: c.name, mobile: c.mobile },
        create: { userId: c.userId, name: c.name, mobile: c.mobile },
      });
    }

    // 1b. 清理快照中已不存在的成员（对比现网：离职/删除/被过滤的机器人账号
    //     不再出现在手动绑定搜索源——2026-08-06 修复首次同步残留的机器人行）
    const freshIds = contacts.map((c) => c.userId);
    if (freshIds.length) {
      await this.prisma.dingTalkContact.deleteMany({
        where: { userId: { notIn: freshIds } },
      });
    }

    // 2. 按姓名自动匹配：未绑定用户 × 通讯录（重名 → 跳过，落手动绑定）
    const unbound = await this.prisma.user.findMany({
      where: { dingtalkUserId: null },
      select: { id: true, displayName: true },
    });
    const nameToUsers = new Map<string, typeof unbound>();
    for (const u of unbound) {
      const list = nameToUsers.get(u.displayName) || [];
      list.push(u);
      nameToUsers.set(u.displayName, list);
    }

    let autoBound = 0;
    const ambiguous: string[] = [];
    for (const c of contacts) {
      const candidates = nameToUsers.get(c.name);
      if (!candidates || candidates.length !== 1) {
        if (candidates && candidates.length > 1) ambiguous.push(c.name); // 重名不自动绑定
        continue;
      }
      await this.prisma.user.update({
        where: { id: candidates[0].id },
        data: { dingtalkUserId: c.userId, dingtalkPhone: c.mobile },
      });
      autoBound++;
    }

    this.logger.log(`通讯录同步完成：${contacts.length} 人，自动绑定 ${autoBound} 人`);
    return {
      total: contacts.length,
      autoBound,
      ambiguous,
      contacts: contacts.slice(0, 500), // 前端表格展示上限
    };
  }

  /** 系统用户列表（含钉钉绑定状态，管理端绑定表） */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        displayName: true,
        role: true,
        dingtalkUserId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { items: users };
  }

  /** 通讯录快照列表（手动绑定搜索源） */
  async listContacts(keyword?: string) {
    return this.prisma.dingTalkContact.findMany({
      where: keyword
        ? { OR: [{ name: { contains: keyword } }, { mobile: { contains: keyword } }] }
        : undefined,
      orderBy: { name: 'asc' },
      take: 200,
    });
  }

  /** 手动绑定：系统用户 ↔ 钉钉成员 */
  async bind(userId: string, dingtalkUserId: string) {
    const contact = await this.prisma.dingTalkContact.findUnique({
      where: { userId: dingtalkUserId },
    });
    if (!contact) throw new BadRequestException('钉钉通讯录中不存在该成员，请先同步');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('系统用户不存在');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { dingtalkUserId, dingtalkPhone: contact.mobile },
    });
    return { id: updated.id, displayName: updated.displayName, dingtalkUserId: updated.dingtalkUserId };
  }

  /** 解绑 */
  async unbind(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { dingtalkUserId: null, dingtalkPhone: null },
    });
    return { ok: true };
  }

  /** 系统用户 + 现有 BP 领域映射（法务角色，前端编辑用） */
  async listBpDomains() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: ['legal_bp', 'legal_lead'] } },
      select: {
        id: true,
        displayName: true,
        dingtalkUserId: true,
        bpDomainMaps: { select: { domain: true } },
      },
      orderBy: { displayName: 'asc' },
    });
    return {
      users: users.map((u) => ({
        id: u.id,
        displayName: u.displayName,
        bound: !!u.dingtalkUserId,
        domains: u.bpDomainMaps.map((m) => m.domain),
      })),
      domains: [...BP_DOMAINS], // SKILL_GROUPS 单一来源（/review 2026-08-05）
    };
  }

  /** 设置 BP 领域映射（勾选/取消） */
  async setBpDomain(userId: string, domain: string, enabled: boolean) {
    if (!isBpDomain(domain)) throw new BadRequestException(`领域不在白名单：${domain}`);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'legal_bp' && user.role !== 'legal_lead')) {
      throw new BadRequestException('仅法务 BP/负责人可配置领域');
    }
    if (enabled) {
      await this.prisma.bpDomainMap.upsert({
        where: { userId_domain: { userId, domain } },
        update: {},
        create: { userId, domain },
      });
    } else {
      await this.prisma.bpDomainMap.deleteMany({ where: { userId, domain } });
    }
    return { ok: true };
  }

  /**
   * 拉群失败计数（/review 2026-08-05 口径修正）：route=legalbp 且无钉钉群的工单
   * （含合同类工单——原实现 kind='consult' 过滤会漏计；拉群失败与未匹配到可绑定 BP 均计入）
   */
  async failures() {
    const noGroup = await this.prisma.project.count({
      where: { route: 'legalbp', dingtalkChatId: null },
    });
    return { noGroup };
  }
}
