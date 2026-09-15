import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import * as crypto from 'node:crypto';
import { applyOrgRole, selectOrgDepartment } from '../../common/org/org-role';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DINGTALK_ADAPTER,
  DingTalkAdapter,
  ContactInfo,
} from '../project/adapters/adapter.interfaces';
import { AuditService } from '../../common/audit/audit.service';
import { AuditActor, AuditRequestContext } from '../../common/audit/audit.types';

/** P1-08：通讯录 staging 批大小（createMany 每批条数） */
/** 本地应急/测试账号：不参与组织同步，法务人员只保留 CAS 身份。 */
const SEED_USERNAMES = new Set(['admin', 'business']);
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
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** 组织架构角色（admin 不降级；个人映射 > 钉钉部门映射 > business，共用解析器） */
  private orgRole(existingRole: Role, identity: string | undefined, dept: string | undefined): Role {
    return applyOrgRole(existingRole, identity, dept, this.config);
  }

  /**
   * 一键同步（P1-07/08）：拉全量（结构化结果，不完整抛 DingTalkSyncIncompleteError）→
   * 批次 staging → 短事务 merge → 软失效对账 → 双向姓名唯一自动绑定 → 批次 complete。
   * 任何不完整/异常：批次标记 failed，不动上一成功快照与绑定。
   */
  async syncContacts(actor?: AuditActor, request?: AuditRequestContext) {
    const batch = await this.prisma.dingTalkSyncBatch.create({ data: {} });
    try {
      const result = await this.dingtalk.syncContacts();
      const contacts = result.contacts.map((contact) => ({
        ...contact,
        // 多部门成员优先展示/使用命中 CAS_DEPT_MAP 的部门，兼任部门不再覆盖法务角色。
        department: selectOrgDepartment(
          contact.departments?.length ? contact.departments : contact.department,
          this.config,
        ),
      }));
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
            avatarUrl: c.avatarUrl ?? null,
            department: c.department ?? null,
            departmentIds: c.departmentIds ?? [],
          })),
        });
      }

      // 2-5. staging 完整后，正式快照、软失效、自动绑定、批次完成必须原子提交。
      // 任何一步失败都会回滚正式表和用户绑定，catch 只把本批标记 failed。
      const commitResult = await this.prisma.$transaction(async (tx) => {
        // 所有实例在同一张批次表的最早行上取行锁；锁随事务提交释放，不依赖进程内互斥。
        // 后启动的成功批次已经提交时，旧批次不得再覆盖新快照。
        await tx.$queryRawUnsafe(
          'SELECT id FROM dingtalk_sync_batches ORDER BY started_at ASC, id ASC LIMIT 1 FOR UPDATE',
        );
        const latestComplete = await tx.dingTalkSyncBatch.findFirst({
          where: { status: 'complete' },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, startedAt: true },
        });
        const latestIsNewer = latestComplete
          && latestComplete.id !== batch.id
          && (
            latestComplete.startedAt > batch.startedAt
            || (
              latestComplete.startedAt.getTime() === batch.startedAt.getTime()
              && latestComplete.id > batch.id
            )
          );
        if (latestIsNewer) {
          await tx.dingTalkSyncBatch.update({
            where: { id: batch.id },
            data: {
              status: 'failed',
              errorMessage: '同步结果已被更新批次取代',
              completedAt: new Date(),
            },
          });
          return { autoBound: 0, ambiguous: [] as string[], superseded: true };
        }
        const staged = await tx.dingTalkContactStaging.findMany({
          where: { batchId: batch.id },
          select: { userId: true, name: true, mobile: true, avatarUrl: true, department: true, departmentIds: true },
        });
        const stagedContacts: ContactInfo[] = staged.map((c) => ({
          userId: c.userId,
          name: c.name,
          mobile: c.mobile ?? undefined,
          avatarUrl: c.avatarUrl ?? undefined,
          department: c.department ?? undefined,
          departmentIds: Array.isArray(c.departmentIds) ? c.departmentIds.filter((id): id is string => typeof id === 'string') : [],
        }));

        await this.mergeContacts(tx, batch.id);
        if (result.departments) {
          await tx.dingTalkDepartment.updateMany({ data: { isActive: false } });
          if (result.departments.length) await tx.$executeRaw(Prisma.sql`
            INSERT INTO dingtalk_departments (id, parent_id, name, is_active)
            VALUES ${Prisma.join(result.departments.map(department => Prisma.sql`
              (${department.id}, ${department.parentId}, ${department.name}, TRUE)
            `))}
            ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), is_active = TRUE
          `);
        }

        // 空快照也是完整快照：NOT EXISTS 会让上一批联系人全部软失效，绝不硬删除。
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

        const binding = await this.autoBind(tx, stagedContacts, actor, request, batch.id);
        // review 2026-08-11 P1：已绑定员工调岗后,每次同步重算部门+角色,防旧部门权限残留
        const refreshed = await this.refreshBoundRoles(tx, stagedContacts, actor, request, batch.id);
        await tx.dingTalkSyncBatch.update({
          where: { id: batch.id },
          data: {
            status: 'complete',
            contactCount: stagedContacts.length,
            autoBoundCount: binding.autoBound,
            departmentCount: result.departmentCount,
            completedAt: new Date(),
          },
        });
        if (this.audit) {
          await this.audit.record({
            actor,
            action: 'member.directory.sync',
            resourceType: 'dingtalk_sync_batch',
            resourceId: batch.id,
            source: 'dingtalk',
            outcome: 'success',
            request,
            metadata: {
              contactCount: stagedContacts.length,
              autoBoundCount: binding.autoBound,
              refreshedMemberCount: refreshed,
              departmentCount: result.departmentCount,
            },
            retentionClass: 'admin',
          }, tx);
        }
        return { ...binding, superseded: false };
      }, { timeout: 30_000 });

      if (commitResult.superseded) {
        await this.prisma.dingTalkContactStaging
          .deleteMany({ where: { batchId: batch.id } })
          .catch(() => undefined);
        return { complete: false, batchId: batch.id, error: '同步结果已被更新批次取代' };
      }
      const { autoBound, ambiguous } = commitResult;

      // 只清理已终态的旧批次；不得删除其他仍在 staging 的并发同步。
      // 清理是提交后的维护动作，失败不得把已成功批次改写为 failed。
      await this.prisma.dingTalkContactStaging.deleteMany({
        where: {
          batchId: { not: batch.id },
          batch: { status: { in: ['complete', 'failed'] } },
        },
      }).catch(() => this.logger.warn(`通讯录旧 staging 清理失败（当前批次 ${batch.id}）`));

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
      // 失败批次 staging 无消费方,清理防膨胀（review 2026-08-11）
      await this.prisma.dingTalkContactStaging
        .deleteMany({ where: { batchId: batch.id } })
        .catch(() => undefined);
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'member.directory.sync',
          resourceType: 'dingtalk_sync_batch',
          resourceId: batch.id,
          source: 'dingtalk',
          outcome: 'failed',
          reasonCode: 'DINGTALK_SYNC_FAILED',
          request,
          retentionClass: 'admin',
        }).catch((auditError) => this.logger.error(`通讯录同步失败审计写入失败：${auditError}`));
      }
      this.logger.error(`通讯录同步失败（批次 ${batch.id}）：${e?.message ?? e}`);
      return { complete: false, batchId: batch.id, error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** merge：生产使用单条批量 upsert，避免每联系人一次 round-trip。 */
  private async mergeContacts(tx: Prisma.TransactionClient, batchId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO dingtalk_contacts
        (id, user_id, name, mobile, avatar_url, department, department_ids, is_active, last_seen_batch_id, last_seen_at, synced_at)
      SELECT UUID(), user_id, name, mobile, avatar_url, department, department_ids, TRUE, batch_id, NOW(), NOW()
      FROM dingtalk_contact_staging
      WHERE batch_id = ${batchId}
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        mobile = VALUES(mobile),
        avatar_url = VALUES(avatar_url),
        department = VALUES(department),
        department_ids = VALUES(department_ids),
        is_active = TRUE,
        last_seen_batch_id = VALUES(last_seen_batch_id),
        last_seen_at = NOW(),
        synced_at = NOW()
    `;
  }

  /**
   * 自动绑定（P1-07）：同时满足
   * - 系统该姓名恰好 1 个未绑定用户；
   * - 本次完整快照该姓名恰好 1 个联系人；
   * - 该联系人未被其他系统用户绑定。
   * 系统重名或联系人重名 → ambiguous，不自动绑定。
   */
  private async autoBind(
    tx: any,
    contacts: ContactInfo[],
    actor?: AuditActor,
    request?: AuditRequestContext,
    batchId?: string,
  ): Promise<{ autoBound: number; ambiguous: string[] }> {
    const unbound = await tx.user.findMany({
      where: { dingtalkUserId: null },
      select: { id: true, username: true, displayName: true, casUsername: true, role: true, department: true },
    });
    const nameToUsers = new Map<string, {
      id: string;
      username: string;
      displayName: string;
      casUsername: string | null;
      role: Role;
      department: string | null;
    }[]>();
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
      if (SEED_USERNAMES.has(users[0].username)) continue; // 种子测试账号不自动绑定/改角色
      // 组织架构权威(用户决策 A)：部门 + 角色一起设置,admin 不降级(review 2026-08-11)
      const role = this.orgRole(users[0].role, users[0].casUsername ?? contact.userId, contact.department);
      await tx.user.update({
        where: { id: users[0].id },
        data: {
          dingtalkUserId: contact.userId,
          dingtalkPhone: contact.mobile ?? null,
          avatarUrl: contact.avatarUrl ?? null,
          department: contact.department ?? null,
          role,
        },
      });
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'member.bind',
          resourceType: 'member',
          resourceId: users[0].id,
          source: 'dingtalk',
          outcome: 'success',
          request,
          before: {
            id: users[0].id,
            role: users[0].role,
            department: users[0].department ?? null,
            dingtalkBound: false,
          },
          after: {
            id: users[0].id,
            role,
            department: contact.department ?? null,
            dingtalkBound: true,
          },
          changes: {
            dingtalkBound: { from: false, to: true },
            department: { from: users[0].department ?? null, to: contact.department ?? null },
            role: { from: users[0].role, to: role },
          },
          metadata: {
            automatic: true,
            batchId: batchId ?? null,
            dingtalkIdentityHash: this.audit.fingerprint(contact.userId),
          },
          retentionClass: 'admin',
        }, tx);
      }
      autoBound++;
    }
    return { autoBound, ambiguous };
  }

  /**
   * 刷新已绑定用户的部门/角色（review 2026-08-11 P1）：
   * autoBind 只处理未绑定用户;已绑定员工调岗后,本方法按最新通讯录重算部门+角色;
   * 联系人已移出通讯录(软失效)的用户,同步时回收部门 + 重算角色,防旧权限残留。
   */
  private async refreshBoundRoles(
    tx: any,
    stagedContacts: ContactInfo[],
    actor?: AuditActor,
    request?: AuditRequestContext,
    batchId?: string,
  ): Promise<number> {
    const stagedById = new Map(stagedContacts.map((c) => [c.userId, c]));
    const bound = (await tx.user.findMany({
      where: { dingtalkUserId: { not: null } },
      select: { id: true, username: true, dingtalkUserId: true, casUsername: true, role: true, avatarUrl: true, department: true },
    })) ?? [];
    let refreshed = 0;
    for (const u of bound) {
      if (SEED_USERNAMES.has(u.username)) continue; // 种子测试账号不重算角色
      const contact = u.dingtalkUserId ? stagedById.get(u.dingtalkUserId) : undefined;
      if (contact) {
        // 在岗/调岗：刷新部门 + 角色（admin 不降级）
        const role = this.orgRole(u.role, u.casUsername ?? contact.userId, contact.department);
        const department = contact.department ?? null;
        const avatarUrl = contact.avatarUrl ?? null;
        const profileChanged = u.department !== department || u.role !== role;
        if (profileChanged || u.avatarUrl !== avatarUrl) {
          await tx.user.update({ where: { id: u.id }, data: { department, role, avatarUrl } });
          if (profileChanged) {
            await this.recordDirectoryProfileChange(tx, u, role, department, actor, request, batchId);
          }
          refreshed++;
        }
      } else {
        // 联系人已不在本批通讯录(软失效)：回收部门 + 重算角色(仅剩个人映射或 business),admin 不降级
        const role = this.orgRole(u.role, u.casUsername ?? undefined, undefined);
        const profileChanged = u.department !== null || u.role !== role;
        if (profileChanged || u.avatarUrl !== null) {
          await tx.user.update({ where: { id: u.id }, data: { department: null, role, avatarUrl: null } });
          if (profileChanged) {
            await this.recordDirectoryProfileChange(tx, u, role, null, actor, request, batchId);
          }
          refreshed++;
        }
      }
    }
    return refreshed;
  }

  private async recordDirectoryProfileChange(
    tx: any,
    user: any,
    role: Role,
    department: string | null,
    actor?: AuditActor,
    request?: AuditRequestContext,
    batchId?: string,
  ) {
    if (!this.audit) return;
    await this.audit.record({
      actor,
      action: 'member.directory_profile.change',
      resourceType: 'member',
      resourceId: user.id,
      source: 'dingtalk',
      outcome: 'success',
      request,
      before: { id: user.id, role: user.role, department: user.department ?? null, dingtalkBound: true },
      after: { id: user.id, role, department, dingtalkBound: true },
      changes: {
        department: { from: user.department ?? null, to: department },
        role: { from: user.role, to: role },
      },
      metadata: { automatic: true, batchId: batchId ?? null },
      retentionClass: 'admin',
    }, tx);
  }

  /**
   * 最近一次成功同步统计（2026-08-11）：切页/刷新后前端从持久化的批次恢复统计卡，
   * 不再只依赖内存里的同步返回值。
   */
  async lastSync() {
    const batch = await this.prisma.dingTalkSyncBatch.findFirst({
      where: { status: 'complete' },
      orderBy: { startedAt: 'desc' },
      select: {
        contactCount: true,
        autoBoundCount: true,
        departmentCount: true,
        completedAt: true,
      },
    });
    if (!batch) return null;
    return {
      total: batch.contactCount,
      autoBound: batch.autoBoundCount,
      departmentCount: batch.departmentCount,
      completedAt: batch.completedAt,
    };
  }

  /** 系统用户列表（含钉钉绑定状态，管理端绑定表；部门 2026-08-11） */
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        casUsername: true,
        dingtalkUserId: true,
        avatarUrl: true,
        department: true,
        loginAudits: { select: { id: true }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      items: users.map(({ loginAudits, ...user }) => ({
        ...user,
        loginStatus: user.casUsername && loginAudits.length === 0 ? 'pending' : 'active',
      })),
    };
  }

  /** 通讯录快照列表（手动绑定/预开通搜索源，只返回在岗且尚未被占用的联系人） */
  async listContacts(keyword?: string) {
    const occupied = await this.prisma.user.findMany({
      where: { dingtalkUserId: { not: null } },
      select: { dingtalkUserId: true },
    });
    const occupiedIds = occupied
      .map((item) => item.dingtalkUserId)
      .filter((item): item is string => Boolean(item));
    return this.prisma.dingTalkContact.findMany({
      where: {
        isActive: true,
        ...(occupiedIds.length ? { userId: { notIn: occupiedIds } } : {}),
        ...(keyword ? { OR: [{ name: { contains: keyword } }, { mobile: { contains: keyword } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
  }

  /**
   * 管理员预开通：CAS 账号是登录身份键，钉钉联系人提供可信姓名、部门和通讯身份。
   * 两个身份在同一事务内占用，避免并发重复开通；首次 CAS 登录会命中 casUsername 并仅更新资料、签发会话。
   */
  async provision(
    rawCasUsername: string,
    dingtalkUserId: string,
    actor?: AuditActor,
    request?: AuditRequestContext,
  ) {
    const casUsername = rawCasUsername.trim().toLowerCase();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const contact = await tx.dingTalkContact.findUnique({ where: { userId: dingtalkUserId } });
        if (!contact || !contact.isActive) {
          throw new BadRequestException('钉钉通讯录中不存在该成员或已失效，请先同步');
        }

        const [existingIdentity, occupiedContact] = await Promise.all([
          tx.user.findFirst({
            where: { OR: [{ casUsername }, { username: casUsername }] },
            select: { id: true },
          }),
          tx.user.findFirst({
            where: { dingtalkUserId },
            select: { id: true },
          }),
        ]);
        if (existingIdentity) throw new ConflictException('该 CAS 账号已存在，请在系统用户列表中绑定钉钉身份');
        if (occupiedContact) throw new ConflictException('该钉钉成员已绑定其他系统用户');

        const role = this.orgRole(Role.business, casUsername, contact.department ?? undefined);
        const created = await tx.user.create({
          data: {
            username: casUsername,
            casUsername,
            displayName: contact.name,
            passwordHash: crypto.randomBytes(32).toString('hex'),
            dingtalkUserId,
            dingtalkPhone: contact.mobile ?? null,
            avatarUrl: contact.avatarUrl ?? null,
            department: contact.department ?? null,
            role,
          },
        });
        if (this.audit) {
          await this.audit.record({
            actor,
            action: 'member.provision',
            resourceType: 'member',
            resourceId: created.id,
            source: 'web',
            outcome: 'success',
            request,
            before: null,
            after: { ...memberAuditSnapshot(created), casBound: true, loginStatus: 'pending' },
            changes: {
              provisioned: { from: false, to: true },
              role: { from: null, to: role },
              department: { from: null, to: contact.department ?? null },
              dingtalkBound: { from: false, to: true },
            },
            metadata: {
              casIdentityHash: this.audit.fingerprint(casUsername),
              dingtalkIdentityHash: this.audit.fingerprint(dingtalkUserId),
            },
            retentionClass: 'admin',
          }, tx);
        }
        return {
          id: created.id,
          displayName: created.displayName,
          role: created.role,
          department: created.department,
          dingtalkUserId: created.dingtalkUserId,
          avatarUrl: created.avatarUrl,
          casUsername: created.casUsername,
          loginStatus: 'pending' as const,
        };
      });
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException('CAS 账号或钉钉身份已被占用');
      throw error;
    }
  }

  /** 手动绑定（P1-07 1:1）：联系人须存在且 active；联系人未被其他用户绑定；唯一冲突返回 409，不覆盖原绑定 */
  async bind(
    userId: string,
    dingtalkUserId: string,
    actor?: AuditActor,
    request?: AuditRequestContext,
  ) {
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
      // 手动绑定也应用组织架构角色映射（review 2026-08-11 P2,admin 不降级）;
      // 种子测试账号角色固定,不参与组织映射（review 2026-08-11）
      const role = SEED_USERNAMES.has(user.username)
        ? user.role
        : this.orgRole(user.role, user.casUsername ?? dingtalkUserId, contact.department ?? undefined);
      const updated = await this.prisma.$transaction(async (tx) => {
        const result = await tx.user.update({
          where: { id: userId },
          data: {
            dingtalkUserId,
            dingtalkPhone: contact.mobile,
            avatarUrl: contact.avatarUrl ?? null,
            department: contact.department ?? null,
            role,
          },
        });
        if (this.audit) {
          await this.audit.record({
            actor,
            action: 'member.bind',
            resourceType: 'member',
            resourceId: userId,
            source: 'web',
            outcome: 'success',
            request,
            before: memberAuditSnapshot(user),
            after: memberAuditSnapshot(result),
            changes: {
              dingtalkBound: { from: Boolean(user.dingtalkUserId), to: true },
              department: { from: user.department ?? null, to: result.department ?? null },
              role: { from: user.role, to: result.role },
            },
            metadata: { dingtalkIdentityHash: this.audit.fingerprint(dingtalkUserId) },
            retentionClass: 'admin',
          }, tx);
        }
        return result;
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
  async unbind(userId: string, actor?: AuditActor, request?: AuditRequestContext) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('系统用户不存在');
    // admin 不降级;其余只剩个人映射或 business;种子测试账号角色固定（review 2026-08-11）
    const role = SEED_USERNAMES.has(user.username)
      ? user.role
      : this.orgRole(user.role, user.casUsername ?? undefined, undefined);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { dingtalkUserId: null, dingtalkPhone: null, avatarUrl: null, department: null, role },
      });
      if (this.audit) {
        await this.audit.record({
          actor,
          action: 'member.unbind',
          resourceType: 'member',
          resourceId: userId,
          source: 'web',
          outcome: 'success',
          request,
          before: memberAuditSnapshot(user),
          after: memberAuditSnapshot(updated),
          changes: {
            dingtalkBound: { from: Boolean(user.dingtalkUserId), to: false },
            department: { from: user.department ?? null, to: null },
            role: { from: user.role, to: updated.role },
          },
          retentionClass: 'admin',
        }, tx);
      }
    });
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

function memberAuditSnapshot(user: any) {
  return {
    id: user.id,
    role: user.role,
    department: user.department ?? null,
    dingtalkBound: Boolean(user.dingtalkUserId),
  };
}
