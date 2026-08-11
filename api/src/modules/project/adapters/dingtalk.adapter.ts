import { Injectable, Logger } from '@nestjs/common';
import {
  DingTalkAdapter,
  DingTalkGroup,
  ContactInfo,
  ContactSyncResult,
  DingTalkSyncIncompleteError,
} from './adapter.interfaces';

const OAPI_HOST = 'https://oapi.dingtalk.com';
const API_HOST = 'https://api.dingtalk.com';
const TOKEN_TTL_MS = 7200_000; // 钉钉默认 expires_in=7200s
const REFRESH_AHEAD_MS = 5 * 60_000; // 提前 5 分钟刷新（工程评审决策 #3）
const REQUEST_TIMEOUT_MS = 10_000;
const SYNC_CONCURRENCY = 3; // 通讯录同步有界并发数（2026-08-06 提速；并发 6 实测触发钉钉 qps 流控 subcode=90018，降至 3 + 流控退避重试）

/**
 * 有界并发：同时最多跑 limit 个异步任务，返回顺序与 items 一致。
 * 2026-08-06 通讯录同步提速：原串行递归约 94 次 API 请求 ≈45s → 有界并发 ≈10s。
 */
function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  ).then(() => results);
}

/**
 * 钉钉企业内部应用适配器（2026-08-05 钉钉拉群模块，/review 2026-08-05 修正链路注释）
 *
 * 链路：
 *   gettoken(AppKey+Secret) → access_token（内存缓存，提前 5 分钟刷新，401 重试 1 次）
 *   → syncContacts: listsub 递归部门树 → 逐部门 user/list 分页 → 过滤机器人/离职 → userid 去重
 *   → createGroup: 创建场景群 /v1.0/im/sceneGroup/create（2026-08-06 切换：
 *     创建普通群v2 有组织 1000 建群配额已满；旧场景群接口停新申请，新应用用此新接口）
 *   → addMember: 场景群加人 /v1.0/im/sceneGroup/member/add（权限同 qyapi_chat_manage）
 *   → sendNotification: /v1.0/robot/groupMessages 机器人发消息（失败 2s 重试 1 次，
 *     兼容场景群模板异步安装时序）
 *
 * token 缓存为进程内存（单实例内部工具；多实例部署需升级 Redis/DB 缓存）
 */
@Injectable()
export class DingTalkAdapterImpl implements DingTalkAdapter {
  private readonly logger = new Logger(DingTalkAdapterImpl.name);
  private token: { value: string; expiresAt: number } | null = null;
  /** 凭证缺失 → 降级为不可用（拉群失败事件），不阻断 API 启动（/review 2026-08-05） */
  private configured = true;

  constructor() {
    if (!process.env.DINGTALK_APP_KEY || !process.env.DINGTALK_APP_SECRET) {
      this.configured = false;
      this.logger.warn('DINGTALK_APP_KEY / DINGTALK_APP_SECRET 未配置——钉钉拉群将降级为失败事件，请检查 api/.env');
    }
  }

  // ═══════════════════════════════════════════
  // token 管理
  // ═══════════════════════════════════════════

  private async getAccessToken(force = false): Promise<string> {
    if (!this.configured) {
      throw new Error('钉钉凭证未配置（DINGTALK_APP_KEY / DINGTALK_APP_SECRET）');
    }
    if (!force && this.token && this.token.expiresAt > Date.now() + REFRESH_AHEAD_MS) {
      return this.token.value;
    }
    const url =
      `${OAPI_HOST}/gettoken?appkey=${process.env.DINGTALK_APP_KEY}` +
      `&appsecret=${process.env.DINGTALK_APP_SECRET}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data: any = await res.json();
    if (data.errcode !== 0) {
      throw new Error(`gettoken 失败: ${data.errmsg} (errcode=${data.errcode})`);
    }
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : TOKEN_TTL_MS),
    };
    this.logger.log('access_token 已获取（内存缓存）');
    return data.access_token;
  }

  /** OAPI 统一请求：401/token 过期 → 强制刷新重试 1 次 */
  private async oapi<T = any>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.requestWithToken(OAPI_HOST, path, body);
  }

  /**
   * v1.0 REST 风格请求（api.dingtalk.com，x-acs-dingtalk-access-token 请求头）。
   * 普通群 v2 / 机器人群消息均为此风格（spike 2026-08-05 确认）。
   */
  private async v1<T = any>(path: string, body: Record<string, unknown>, retry401 = true): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${API_HOST}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data: any = await res.json().catch(() => ({}));
    // v1 错误：HTTP 400 + { code, message }；token 失效（401）→ 刷新重试一次
    if (retry401 && (res.status === 401 || data.code === 'unauthorized')) {
      this.logger.warn('v1 access_token 失效，强制刷新后重试');
      await this.getAccessToken(true);
      return this.v1(path, body, false);
    }
    if (!res.ok) {
      throw new Error(`钉钉接口失败 [${res.status}] ${path}: ${data.message || data.code || JSON.stringify(data)}`);
    }
    return data as T;
  }

  private async requestWithToken<T = any>(
    host: string,
    path: string,
    body?: Record<string, unknown>,
    retry401 = true,
    flowRetry = 2,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${host}${path}?access_token=${token}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data: any = await res.json().catch(() => ({}));
    // token 失效（40014 access_token无效 / 401）→ 刷新重试一次
    if (retry401 && (data.errcode === 40014 || data.errcode === 401)) {
      this.logger.warn(`access_token 失效（${data.errcode}），强制刷新后重试`);
      await this.getAccessToken(true);
      return this.requestWithToken(host, path, body, false, flowRetry);
    }
    // 流控（errcode=88 / subcode=90018 qps流控，2026-08-06 并发同步实测触发）
    // → 等 1.5s 退避重试，最多 2 次；避免有界并发突发撞限流后整次同步失败
    if (flowRetry > 0 && this.isFlowLimited(data)) {
      this.logger.warn(`钉钉接口触发流控（${path}），1.5s 后重试（剩余 ${flowRetry} 次）`);
      await new Promise((r) => setTimeout(r, 1500));
      return this.requestWithToken(host, path, body, retry401, flowRetry - 1);
    }
    // /review 2026-08-05：非 token 错误码一律抛错——否则 syncContacts 拿到 errcode≠0 的响应
    // 当空数据处理，通讯录同步"0 人"假成功、全公司无人绑定
    if (data.errcode != null && data.errcode !== 0) {
      throw new Error(`钉钉接口失败 [${path}]: ${data.errmsg || data.message} (errcode=${data.errcode})`);
    }
    return data as T;
  }

  /** 是否 qps 流控（errcode=88 或 subcode=90018 / errmsg 含 qps 流控） */
  private isFlowLimited(data: any): boolean {
    const msg = `${data.errmsg || ''} ${data.submsg || ''} ${data.message || ''}`;
    return data.errcode === 88 || msg.includes('90018') || msg.includes('qps流控');
  }

  // ═══════════════════════════════════════════
  // 通讯录同步
  // ═══════════════════════════════════════════

  /**
   * 显式排除的机器人/功能账号 userid（2026-08-06 数据验证）：
   * 这些账号 active=true 且 disable_status=false（状态规则覆盖不到），
   * 分散在正常部门中（会议账号在重大项目管理部等）。
   */
  private static readonly BLOCKED_USERIDS = new Set([
    '475920968', // 会议账号
    '300573991', // system
    'hr', // 人力资源部
    'shichangbu', // 市场部
    'zongcaiban', // 总裁办
    '023412221736796777140', // 群问答
  ]);

  /** 状态规则：停用/未激活账号一律排除（离职、测试、机器人）。真人 active/disable 均为 false（2026-08-06 全量 1612 人验证）。 */
  private isBlockedContact(u: { userid?: string; active?: boolean; disable_status?: boolean }): boolean {
    return (
      DingTalkAdapterImpl.BLOCKED_USERIDS.has(u.userid ?? '') ||
      u.active === false ||
      u.disable_status === true
    );
  }

  async syncContacts(): Promise<ContactSyncResult> {
    // 两阶段有界并发（2026-08-06 提速：原串行递归约 94 次请求 ≈45s → 并发 6 ≈10s）：
    //   ① BFS + mapLimit 枚举部门树（listsub，seenDepts 防环 + 深度上限 8）
    //   ② mapLimit 逐部门分页拉用户（user/list，userid 去重 + 过滤机器人/离职）
    // 并发内 seen/contacts 变更均为同步语句（循环内无 await 交错），JS 单线程保证安全。
    // P1-07：跟踪深度/分页截断，达到上限即判定不完整并抛 DingTalkSyncIncompleteError，
    // 调用方（MembersService）据此把批次标记 failed，不动旧快照。
    const seen = new Set<string>();
    const contacts: ContactInfo[] = [];
    const deptNames = new Map<number, string>(); // 部门 id → 部门名（2026-08-11 存部门）
    let truncatedDepth = false;
    let truncatedPage = false;
    let pageCount = 0;

    // ① 枚举部门树（BFS，有界并发）
    const visitedDepts = new Set<number>([1]);
    const deptQueue: Array<{ id: number; depth: number }> = [{ id: 1, depth: 0 }];
    while (deptQueue.length) {
      const batch = deptQueue.splice(0, Math.min(SYNC_CONCURRENCY, deptQueue.length));
      const subLists = await mapLimit(batch, SYNC_CONCURRENCY, async ({ id }) => {
        const res = await this.oapi<any>('/topapi/v2/department/listsub', { dept_id: id });
        const list = (res.result || []) as Array<{ dept_id: number; name?: string }>;
        for (const d of list) {
          if (d?.dept_id && d.name) deptNames.set(d.dept_id, d.name);
        }
        return list.map((d) => d.dept_id);
      });
      for (let b = 0; b < batch.length; b++) {
        if (batch[b].depth >= 8) {
          if (subLists[b].length) truncatedDepth = true; // 达到深度上限仍剩子部门 → 不完整
          continue;
        }
        for (const deptId of subLists[b]) {
          if (!visitedDepts.has(deptId)) {
            visitedDepts.add(deptId);
            deptQueue.push({ id: deptId, depth: batch[b].depth + 1 });
          }
        }
      }
    }

    // ② 有界并发逐部门分页拉用户
    const allDepts = [...visitedDepts];
    await mapLimit(allDepts, SYNC_CONCURRENCY, async (deptId) => {
      let cursor = 0;
      for (let page = 0; page < 50; page++) {
        // 防失控上限：50 页/部门
        const res = await this.oapi<any>('/topapi/v2/user/list', {
          dept_id: deptId,
          cursor,
          size: 100,
        });
        pageCount++;
        const list: any[] = res.result?.list || [];
        for (const u of list) {
          if (!u.userid || seen.has(u.userid)) continue; // 跨部门重复按 userid 去重
          if (this.isBlockedContact(u)) continue; // 排除机器人/离职/停用/测试账号
          seen.add(u.userid);
          contacts.push({
            userId: u.userid,
            name: u.name || '',
            mobile: u.mobile,
            department: deptNames.get(deptId), // 该用户所属部门名
          });
        }
        if (!res.result?.has_more) break;
        cursor = res.result?.next_cursor ?? 0;
        if (page === 49) truncatedPage = true; // 达 50 页上限且仍 has_more → 不完整
      }
    });

    if (truncatedDepth || truncatedPage) {
      throw new DingTalkSyncIncompleteError(
        `通讯录同步不完整（深度截断=${truncatedDepth}，分页截断=${truncatedPage}），已放弃本次结果`,
        { departmentCount: visitedDepts.size, pageCount, truncatedDepth, truncatedPage },
      );
    }
    if (contacts.length === 0) {
      throw new DingTalkSyncIncompleteError('通讯录同步结果为空（组织可能为空或过滤后无人），判定异常');
    }

    this.logger.log(`通讯录同步完成：${contacts.length} 人（${visitedDepts.size} 部门，${pageCount} 页）`);
    return {
      contacts,
      complete: true,
      departmentCount: visitedDepts.size,
      pageCount,
      warnings: [],
    };
  }

  // ═══════════════════════════════════════════
  // 建群 / 加人 / 发消息
  // ═══════════════════════════════════════════

  /**
   * 建群（创建场景群 v1.0 REST，2026-08-06）：
   * POST /v1.0/im/sceneGroup/create（注意 /im/ 段——早期测试 /v1.0/sceneGroup/create
   * 报 InvalidVersion 即缺此段），按群模板创建（template_id 来自 .env）。
   * 背景：
   *   - 创建普通群v2（/v1.0/im/group/create）有组织 1000 建群配额，达上限返回
   *     500 system.error / OAPI chat/create 返回 errcode=1002 "too many chat"；
   *   - 旧场景群接口 /topapi/im/chat/scenegroup/create 已停止新应用申请；
   *     本应用为新创建，须用此新接口（文档 create-a-scene-group）。
   * 权限：qyapi_chat_manage（钉钉群基础信息管理权限）。
   * 群名 ≤30 字符（截断到 20）；user_ids 为数组。
   */
  async createGroup(
    members: string[],
    projectTitle: string,
    ownerUserId?: string,
    dedupKey?: string,
  ): Promise<DingTalkGroup> {
    const templateId = process.env.DINGTALK_SCENE_TEMPLATE_ID;
    if (!templateId) {
      throw new Error('DINGTALK_SCENE_TEMPLATE_ID 未配置（场景群群模板 ID，需运维创建并发布群模板）');
    }
    const owner = ownerUserId || members[0];
    const title = this.truncateGroupName(projectTitle);
    const res = await this.v1<any>('/v1.0/im/sceneGroup/create', {
      title,
      template_id: templateId,
      owner_user_id: owner,
      user_ids: members,
      ...(dedupKey ? { uuid: dedupKey } : {}), // 建群去重业务ID：同一工单重试只建一个群（P1-03）
    });
    const chatId =
      res.open_conversation_id || res.openConversationId || res.chat_id || res.chatid;
    if (!chatId) throw new Error('建群失败: 响应缺少 openConversationId');
    return { chatId, title, members };
  }

  /**
   * 加人（转派）。场景群添加群成员（2026-08-06 文档确认）：
   * POST /v1.0/im/sceneGroup/member/add，body snake_case
   * （open_conversation_id + user_ids），权限与建群同为 qyapi_chat_manage。
   */
  async addMember(chatId: string, userId: string): Promise<void> {
    await this.v1('/v1.0/im/sceneGroup/member/add', {
      open_conversation_id: chatId,
      user_ids: [userId],
    });
  }

  async sendNotification(chatId: string, message: string): Promise<void> {
    const robotCode = process.env.DINGTALK_ROBOT_CODE;
    if (!robotCode) throw new Error('DINGTALK_ROBOT_CODE 未配置，无法发送群消息');
    const send = () =>
      this.v1('/v1.0/robot/groupMessages/send', {
        robotCode,
        openConversationId: chatId,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: message }),
      });
    // 场景群模板安装为异步事件：群刚建成时机器人消息可能瞬时失败，
    // 失败后等 2s 重试 1 次（2026-08-06 场景群切换）。
    for (let attempt = 1; ; attempt++) {
      try {
        await send();
        return;
      } catch (e) {
        if (attempt >= 2) throw e;
        this.logger.warn(`群消息发送失败，等待 2s 重试（${chatId}）：${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** 群名截断：总长 ≤20 字（钉钉群名限制，工程评审决策 #5）。
      调用方传完整标题（`工单#<id前6位> <标题>`），此处仅截断。 */
  private truncateGroupName(raw: string): string {
    return raw.slice(0, 20);
  }
}
