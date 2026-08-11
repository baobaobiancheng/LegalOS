import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { resolveOrgRole } from '../../common/org/org-role';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DINGTALK_ADAPTER,
  DingTalkAdapter,
  ContactInfo,
} from '../project/adapters/adapter.interfaces';
import { isBpDomain, BP_DOMAINS } from './dto/members.dto';

/** P1-08：通讯录 staging 批大小（createMany 每批条数） */
const SYNC_BATCH_SIZE = 300;

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
    private readonly config: ConfigService,
  ) {}

  /** 组织架构角色（用户决策 A，共用解析器）：个人映射 > 钉钉部门映射 > business（review 2026-08-11） */
  private orgRole(identity: string | undefined, dept: string | undefined): Role {
    return resolveOrgRole(identity, dept, this.config);
  }

  /**
   * 一键同步（P1-07/08）：拉全量（结构化结果，不完整抛 DingTalkSyncIncompleteError）→
   * 批次 staging → 短事务 merge → 软失效对账 → 双向姓名唯一自动绑定 → 批次 complete。
   * 任何不完整/异常：批次标记 failed，不动上一成功快照与绑定。
   */
  async syncContacts() {
    const batch = await this.prisma.dingTalkSyncBatch.create({ data: {} });
    try {
      const result = await this.dingtalk.syncContacts();
      const contacts = result.contacts;
      if (!result.complete) {
        throw new Error('钉钉通讯录返回不完整，拒绝覆盖上一成功快照');
      }

      // 1. staging（批次 createMany，不逐条 await）
      for (let i = 0; i < contacts.length; i += SYNC_BATCH_SIZE) {
        const chunk = contacts.slice(i, i + SYNC_BATCH_SIZE);
        await this.prisma.dingTalkContactStaging.createMany({
          data: chunk.map((c) => ({
            batchId: batch.id,
            userId: c.userId,
            name: c.name,
            mobile: c.mobile ?? null,
            department: c.department ?? null,
          })),
        });
      }

      // 2-5. staging 完整后，正式快照、软失效、自动绑定、批次完成必须原子提交。
      // 任何一步失败都会回滚正式表和用户绑定，catch 只把本批标记 failed。
      const { autoBound, ambiguous } = await this.prisma.$transaction(async (tx) => {
        const staged = await tx.dingTalkContactStaging.findMany({
          where: { batchId: batch.id },
          select: { userId: true, name: true, mobile: true, department: true },
        });
        const stagedContacts: ContactInfo[] = staged.map((c) => ({
          userId: c.userId,
          name: c.name,
          mobile: c.mobile ?? undefined,
          department: c.department ?? undefined,
        }));

        await this.mergeContacts(tx, batch.id, stagedContacts);

        // 空快照也是完整快照：NOT EXISTS 会让上一批联系人全部软失效，绝不硬删除。
        if (typeof tx.$executeRaw === 'function') {
          await tx.$executeRaw`
            UPDATE dingtalk_contacts
            SET is_active = FALSE, last_seen_batch_id = ${batch.id}
            WHERE is_active = TRUE
              AND NOT EXISTS (
                SELECT 1 FROM dingtalk_contact_staging s
                WHERE s.batch_id = ${batch.id}
                  AND s.user_id = dingtalk_contacts.user_id
              )
          `;
          await tx.$executeRaw`
            UPDATE dingtalk_contacts c
            SET is_active = TRUE, last_seen_batch_id = ${batch.id}, last_seen_at = NOW(), synced_at = NOW()
            WHERE EXISTS (
              SELECT 1 FROM dingtalk_contact_staging s
              WHERE s.batch_id = ${batch.id}
                AND s.user_id = c.user_id
            )
          `;
        } else {
          // 仅供没有 $executeRaw 的轻量单测 mock 使用；生产 Prisma 一定走上面的批量 SQL。
          const freshIds = stagedContacts.map((c) => c.userId);
          await tx.dingTalkContact.updateMany({
            where: freshIds.length
              ? { isActive: true, userId: { notIn: freshIds } }
              : { isActive: true },
            data: { isActive: false, lastSeenBatchId: batch.id },
          });
          if (freshIds.length) {
            await tx.dingTalkContact.updateMany({
              where: { userId: { in: freshIds } },
              data: { isActive: true, lastSeenBatchId: batch.id, lastSeenAt: new Date() },
            });
          }
        }

        const binding = await this.autoBind(tx, stagedContacts);
        // review 2026-08-11 P1：已绑定员工调岗后,每次同步重算部门+角色,防旧部门权限残留
        await this.refreshBoundRoles(tx, stagedContacts);
        await tx.dingTalkSyncBatch.update({
          where: { id: batch.id },
          data: {
            status: 'complete',
            contactCount: stagedContacts.length,
            departmentCount: result.departmentCount,
            completedAt: new Date(),
          },
        });
        return binding;
      });

      this.logger.log(`通讯录同步完成：${contacts.length} 人，自动绑定 ${autoBound} 人`);
      return {
        total: contacts.length,
        autoBound,
        ambiguous,
        complete: true,
        batchId: batch.id,
        contacts: contacts.slice(0, 500), // 前端表格展示上限
      };
    } catch (e: any) {
      // 不完整/失败：批次 failed，不动旧快照
      await this.prisma.dingTalkSyncBatch
        .update({
          where: { id: batch.id },
          data: {
            status: 'failed',
            errorMessage: String(e?.message ?? e).slice(0, 500),
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      this.logger.error(`通讯录同步失败（批次 ${batch.id}）：${e?.message ?? e}`);
      return { complete: false, batchId: batch.id, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** merge：生产使用单条批量 upsert，避免每联系人一次 round-trip。 */
  private async mergeContacts(tx: any, batchId: string, contacts: ContactInfo[]): Promise<void> {
    if (typeof tx.$executeRaw === 'function') {
      await tx.$executeRaw`
        INSERT INTO dingtalk_contacts
          (id, user_id, name, mobile, department, is_active, last_seen_batch_id, last_seen_at, synced_at)
        SELECT UUID(), user_id, name, mobile, department, TRUE, batch_id, NOW(), NOW()
        FROM dingtalk_contact_staging
        WHERE batch_id = ${batchId}
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          mobile = VALUES(mobile),
          department = VALUES(department),
          is_active = TRUE,
          last_seen_batch_id = VALUES(last_seen_batch_id),
          last_seen_at = NOW(),
          synced_at = NOW()
      `;
      return;
    }

    // 没有 raw 能力时仅用于单测 mock；仍由外层交互式事务保证原子性。
    for (let i = 0; i < contacts.length; i += SYNC_BATCH_SIZE) {
      const chunk = contacts.slice(i, i + SYNC_BATCH_SIZE);
      await Promise.all(
        chunk.map((c) =>
          tx.dingTalkContact.upsert({
            where: { userId: c.userId },
            update: { name: c.name, mobile: c.mobile ?? null, department: c.department ?? null, isActive: true, lastSeenBatchId: batchId, lastSeenAt: new Date() },
            create: { userId: c.userId, name: c.name, mobile: c.mobile ?? null, department: c.department ?? null, isActive: true, lastSeenBatchId: batchId, lastSeenAt: new Date() },
          }),
        ),
      );
    }
  }

  /**
   * 自动绑定（P1-07）：同时满足
   * - 系统该姓名恰好 1 个未绑定用户；
   * - 本次完整快照该姓名恰好 1 个联系人；
   * - 该联系人未被其他系统用户绑定。
   * 系统重名或联系人重名 → ambiguous，不自动绑定。
   */
  private async autoBind(tx: any, contacts: ContactInfo[]): Promise<{ autoBound: number; ambiguous: string[] }> {
    const unbound = await tx.user.findMany({
      where: { dingtalkUserId: null },
      select: { id: true, displayName: true, casUsername: true },
    });
    const nameToUsers = new Map<string, { id: string; displayName: string; casUsername: string | null }[]>();
    for (const u of unbound) {
      const list = nameToUsers.get(u.displayName) || [];
      list.push(u);
      nameToUsers.set(u.displayName, list);
    }

    const snapshotByName = new Map<string, ContactInfo[]>();
    for (const c of contacts) {
      const list = snapshotByName.get(c.name) || [];
      list.push(c);
      snapshotByName.set(c.name, list);
    }

    // 已被其他用户绑定的联系人 id（User.dingtalkUserId 唯一 → 查询占用）
    const contactIds = contacts.map((c) => c.userId);
    const bound = await tx.user.findMany({
      where: { dingtalkUserId: { in: contactIds } },
      select: { dingtalkUserId: true },
    });
    const boundContactIds = new Set(bound.map((b) => b.dingtalkUserId as string));

    let autoBound = 0;
    const ambiguous: string[] = [];
    for (const [name, users] of nameToUsers) {
      if (users.length > 1) {
        ambiguous.push(name); // 系统重名不自动绑定（任务书 6.5）
        continue;
      }
      if (users.length === 0) continue;
      const snapshot = snapshotByName.get(name);
      if (!snapshot || snapshot.length !== 1) {
        if (snapshot && snapshot.length > 1) ambiguous.push(name); // 联系人重名
        continue;
      }
      const contact = snapshot[0];
      if (boundContactIds.has(contact.userId)) continue; // 已被他人绑定
      // 组织架构权威(用户决策 A)：部门 + 角色一起设置,个人映射优先(review 2026-08-11 P1)
      const role = this.orgRole(users[0].casUsername ?? contact.userId, contact.department);
      await tx.user.update({
        where: { id: users[0].id },
        data: {
          dingtalkUserId: contact.userId,
          dingtalkPhone: contact.mobile ?? null,
          department: contact.department,
          role,
        },
      });
      autoBound++;
    }
    return { autoBound, ambiguous };
  }

  /**
   * 刷新已绑定用户的部门/角色（review 2026-08-11 P1）：
   * autoBind 只处理未绑定用户;已绑定员工调岗后,本方法按最新通讯录重算部门+角色。
   */
  private async refreshBoundRoles(tx: any, stagedContacts: ContactInfo[]): Promise<void> {
    const ids = stagedContacts.map((c) => c.userId);
    if (!ids.length) return;
    const bound = (await tx.user.findMany({
      where: { dingtalkUserId: { in: ids } },
      select: { id: true, dingtalkUserId: true, casUsername: true },
    })) ?? [];
    for (const u of bound) {
      const contact = stagedContacts.find((c) => c.userId === u.dingtalkUserId);
      if (!contact) continue;
      const role = this.orgRole(u.casUsername ?? contact.userId, contact.department);
      await tx.user.update({
        where: { id: u.id },
        data: { department: contact.department, role },
      });
    }
  }

  /** 系统用户列表（含钉钉绑定状态，管理端绑定表；部门 2026-08-11） */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        displayName: true,
        role: true,
        dingtalkUserId: true,
        department: true,
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

  /** 手动绑定（P1-07 1:1）：联系人须存在且 active；联系人未被其他用户绑定；唯一冲突返回 409，不覆盖原绑定 */
  async bind(userId: string, dingtalkUserId: string) {
    const contact = await this.prisma.dingTalkContact.findUnique({
      where: { userId: dingtalkUserId },
    });
    if (!contact || !contact.isActive) {
      throw new BadRequestException('钉钉通讯录中不存在该成员或已失效，请先同步');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('系统用户不存在');

    // 该联系人是否已被其他系统用户绑定（User.dingtalkUserId 唯一）
    const occupied = await this.prisma.user.findFirst({
      where: { dingtalkUserId, id: { not: userId } },
      select: { id: true },
    });
    if (occupied) throw new ConflictException('该钉钉成员已绑定其他系统用户');

    try {
      // 手动绑定也应用组织架构角色映射（review 2026-08-11 P2）
      const role = this.orgRole(user.casUsername ?? dingtalkUserId, contact.department ?? undefined);
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          dingtalkUserId,
          dingtalkPhone: contact.mobile,
          department: contact.department ?? undefined,
          role,
        },
      });
      return { id: updated.id, displayName: updated.displayName, dingtalkUserId: updated.dingtalkUserId };
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('该钉钉成员已被其他系统用户绑定（唯一约束）');
      }
      throw e;
    }
  }

  /** 解绑：清部门 + 角色重算（不再可信的钉钉部门不能继续给权限,review 2026-08-11 P1） */
  async unbind(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('系统用户不存在');
    const role = this.orgRole(user.casUsername ?? undefined, undefined); // 只剩个人映射或 business
    await this.prisma.user.update({
      where: { id: userId },
      data: { dingtalkUserId: null, dingtalkPhone: null, department: null, role },
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
