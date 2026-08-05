import { Injectable, Logger } from '@nestjs/common';
import {
  DingTalkAdapter,
  DingTalkGroup,
  ContactInfo,
} from './adapter.interfaces';

const OAPI_HOST = 'https://oapi.dingtalk.com';
const API_HOST = 'https://api.dingtalk.com';
const TOKEN_TTL_MS = 7200_000; // 钉钉默认 expires_in=7200s
const REFRESH_AHEAD_MS = 5 * 60_000; // 提前 5 分钟刷新（工程评审决策 #3）
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 钉钉企业内部应用适配器（2026-08-05 钉钉拉群模块，/review 2026-08-05 修正链路注释）
 *
 * 链路：
 *   gettoken(AppKey+Secret) → access_token（内存缓存，提前 5 分钟刷新，401 重试 1 次）
 *   → syncContacts: listsub 部门列表 → 逐部门 user/list 分页 → userid 去重
 *   → createGroup: 普通群 v2 /v1.0/im/group/create（内部群，群名 1~20 字符）
 *   → addMember: 普通群 v2 加人（路径待 add-group-members 文档确认）
 *   → sendNotification: /v1.0/robot/groupMessages 机器人发消息
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
      return this.requestWithToken(host, path, body, false);
    }
    // /review 2026-08-05：非 token 错误码一律抛错——否则 syncContacts 拿到 errcode≠0 的响应
    // 当空数据处理，通讯录同步"0 人"假成功、全公司无人绑定
    if (data.errcode != null && data.errcode !== 0) {
      throw new Error(`钉钉接口失败 [${path}]: ${data.errmsg || data.message} (errcode=${data.errcode})`);
    }
    return data as T;
  }

  // ═══════════════════════════════════════════
  // 通讯录同步
  // ═══════════════════════════════════════════

  async syncContacts(): Promise<ContactInfo[]> {
    // 1. 部门列表（spike 2026-08-05 验证：v2 无 department/list，用 listsub 拉一级子部门）
    // 部门树 = 根部门(1) + 一级子部门（几十人规模足够；深层部门后续扩展）
    const deptResult = await this.oapi<any>('/topapi/v2/department/listsub', { dept_id: 1 });
    const depts: Array<{ dept_id: number; name: string }> = deptResult.result || [];
    if (!depts.length) {
      this.logger.warn(`通讯录同步：未获取到部门（errcode=${deptResult.errcode} ${deptResult.errmsg || ''}）`);
    }

    // 2. 逐部门分页拉用户
    const seen = new Set<string>();
    const contacts: ContactInfo[] = [];
    const allDeptIds = [1, ...depts.map((d) => d.dept_id)];
    for (const deptId of allDeptIds) {
      let cursor = 0;
      for (let page = 0; page < 50; page++) {
        // 防失控上限：50 页/部门
        const res = await this.oapi<any>('/topapi/v2/user/list', {
          dept_id: deptId,
          cursor,
          size: 100,
        });
        const list: any[] = res.result?.list || [];
        for (const u of list) {
          if (!u.userid || seen.has(u.userid)) continue; // 跨部门重复按 userid 去重
          seen.add(u.userid);
          contacts.push({ userId: u.userid, name: u.name || '', mobile: u.mobile });
        }
        if (!res.result?.has_more) break;
        cursor = res.result?.next_cursor ?? 0;
      }
    }
    this.logger.log(`通讯录同步完成：${contacts.length} 人`);
    return contacts;
  }

  // ═══════════════════════════════════════════
  // 建群 / 加人 / 发消息
  // ═══════════════════════════════════════════

  /**
   * 建群（普通群 v2 / 创建群会话，2026-06-04 文档确认）：
   * POST /v1.0/im/group/create，内部群（conversationTag=2），群名 1~20 字符。
   * 注意：群主必须在应用可见性内（错误码 permession.checkFailed）。
   */
  async createGroup(
    members: string[],
    projectTitle: string,
    ownerUserId?: string,
  ): Promise<DingTalkGroup> {
    const owner = ownerUserId || members[0];
    const res = await this.v1<any>('/v1.0/im/group/create', {
      name: this.truncateGroupName(projectTitle),
      owner,
      ownerType: 'emp',
      useridlist: members,
      conversationTag: 2,
    });
    const chatId = res.openConversationId || res.chatid;
    if (!chatId) throw new Error('建群失败: 响应缺少 openConversationId');
    return { chatId, title: this.truncateGroupName(projectTitle), members };
  }

  /**
   * 加人（普通群 v2）。SPIKE_TODO：v2 加人接口路径待用户文档确认
   * （add-group-members 页面请求地址），当前按 v1.0 REST 风格实现，联调时验证。
   */
  async addMember(chatId: string, userId: string): Promise<void> {
    await this.v1(`/v1.0/im/group/members/add`, {
      openConversationId: chatId,
      userIds: [userId],
    });
  }

  async sendNotification(chatId: string, message: string): Promise<void> {
    const robotCode = process.env.DINGTALK_ROBOT_CODE;
    if (!robotCode) throw new Error('DINGTALK_ROBOT_CODE 未配置，无法发送群消息');
    await this.v1('/v1.0/robot/groupMessages/send', {
      robotCode,
      openConversationId: chatId,
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: message }),
    });
  }

  /** 群名截断：总长 ≤20 字（钉钉群名限制，工程评审决策 #5）。
      调用方传完整标题（`工单#<id前6位> <标题>`），此处仅截断。 */
  private truncateGroupName(raw: string): string {
    return raw.slice(0, 20);
  }
}
