import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DingTalkAdapterImpl } from '../src/modules/project/adapters/dingtalk.adapter';

/**
 * 真实钉钉适配器单测（/review 2026-08-05 补齐，mock global.fetch）：
 * - token 缓存命中 / 提前 5 分钟刷新 / 401 重试 1 次
 * - OAPI 非 token 错误码一律抛错（防通讯录同步"0 人"假成功）
 * - syncContacts 分页翻页 + 跨部门 userid 去重
 * - 群名 20 字截断
 * - 凭证缺失降级（不抛构造错误）
 */

const mockFetch = (handler: (url: string, init?: any) => Promise<any>) => {
  global.fetch = vi.fn().mockImplementation(handler) as any;
};

describe('DingTalkAdapterImpl', () => {
  const OLD_KEY = process.env.DINGTALK_APP_KEY;
  const OLD_SECRET = process.env.DINGTALK_APP_SECRET;
  const OLD_TEMPLATE = process.env.DINGTALK_SCENE_TEMPLATE_ID;

  beforeEach(() => {
    process.env.DINGTALK_APP_KEY = 'appkey';
    process.env.DINGTALK_APP_SECRET = 'secret';
    process.env.DINGTALK_ROBOT_CODE = 'robot1';
    process.env.DINGTALK_SCENE_TEMPLATE_ID = 'tmpl-1';
  });

  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.DINGTALK_APP_KEY;
    else process.env.DINGTALK_APP_KEY = OLD_KEY;
    if (OLD_SECRET === undefined) delete process.env.DINGTALK_APP_SECRET;
    else process.env.DINGTALK_APP_SECRET = OLD_SECRET;
    if (OLD_TEMPLATE === undefined) delete process.env.DINGTALK_SCENE_TEMPLATE_ID;
    else process.env.DINGTALK_SCENE_TEMPLATE_ID = OLD_TEMPLATE;
    vi.restoreAllMocks();
  });

  it('gettoken 成功 + 缓存命中（不重复请求）', async () => {
    let tokenCalls = 0;
    mockFetch(async (url: string) => {
      if (url.includes('/gettoken')) {
        tokenCalls++;
        return { json: async () => ({ errcode: 0, access_token: 'TOKEN-1', expires_in: 7200 }) };
      }
      return { json: async () => ({ errcode: 0 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    const t1 = await (adapter as any).getAccessToken();
    const t2 = await (adapter as any).getAccessToken();
    expect(t1).toBe('TOKEN-1');
    expect(t2).toBe('TOKEN-1');
    expect(tokenCalls).toBe(1); // 第二次命中缓存
  });

  it('401 后强制刷新重试 1 次（token 失效恢复）', async () => {
    let tokenCalls = 0;
    let failOnce = true;
    mockFetch(async (url: string) => {
      if (url.includes('/gettoken')) {
        tokenCalls++;
        return { json: async () => ({ errcode: 0, access_token: 'TOKEN-NEW', expires_in: 7200 }) };
      }
      if (failOnce) {
        failOnce = false;
        return { json: async () => ({ errcode: 40014, errmsg: 'access_token无效' }) };
      }
      return { json: async () => ({ errcode: 0 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    await (adapter as any).oapi('/topapi/v2/user/list', { dept_id: 1 });
    expect(tokenCalls).toBe(2); // 初始 + 401 后强制刷新
  });

  it('OAPI 非 token 错误码一律抛错（防假成功）', async () => {
    mockFetch(async () => ({ json: async () => ({ errcode: 50004, errmsg: '部门不在授权范围内' }) }));
    const adapter = new DingTalkAdapterImpl();
    await expect((adapter as any).oapi('/topapi/v2/user/list', { dept_id: 1 })).rejects.toThrow(
      'errcode=50004',
    );
  });

  it('syncContacts：递归深入子部门树（不再止于一级）', async () => {
    // 部门树：1 → [11] → [33] → [];每个部门 user/list 返回 1 人
    mockFetch(async (url: string, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      if (url.includes('/department/listsub')) {
        const dept = body.dept_id;
        if (dept === 1) return { json: async () => ({ errcode: 0, result: [{ dept_id: 11 }] }) };
        if (dept === 11) return { json: async () => ({ errcode: 0, result: [{ dept_id: 33 }] }) };
        return { json: async () => ({ errcode: 0, result: [] }) };
      }
      if (url.includes('/user/list')) {
        return {
          json: async () => ({
            errcode: 0,
            result: { has_more: false, list: [{ userid: `U-${body.dept_id}`, name: `N-${body.dept_id}` }] },
          }),
        };
      }
      return { json: async () => ({ errcode: 0 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    const contacts = await adapter.syncContacts();
    // 根(1) + 11 + 33 三个部门都被遍历到
    expect(contacts.map((c) => c.userId).sort()).toEqual(['U-1', 'U-11', 'U-33']);
  });

  it('syncContacts：过滤机器人/离职/停用/测试账号，保留在岗真人', async () => {
    mockFetch(async (url: string, init?: any) => {
      if (url.includes('/department/listsub')) {
        return { json: async () => ({ errcode: 0, result: [] }) };
      }
      if (url.includes('/user/list')) {
        return {
          json: async () => ({
            errcode: 0,
            result: {
              has_more: false,
              list: [
                { userid: 'zhang.fang', name: '赵俊芳', active: true, disable_status: false }, // 真人 → 保留
                { userid: 'hr', name: '人力资源部', active: true, disable_status: false }, // BLOCKED_USERIDS → 剔除
                { userid: 'U-disabled', name: '已离职', active: true, disable_status: true }, // 离职 → 剔除
                { userid: 'U-inactive', name: '未激活', active: false, disable_status: false }, // 停用 → 剔除
              ],
            },
          }),
        };
      }
      return { json: async () => ({ errcode: 0 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    const contacts = await adapter.syncContacts();
    expect(contacts.map((c) => c.userId)).toEqual(['zhang.fang']);
  });

  it('syncContacts：跨部门重复 userid 去重 + 分页翻页', async () => {
    const calls: any[] = [];
    mockFetch(async (url: string, init?: any) => {
      const body = JSON.parse(init?.body || '{}');
      if (url.includes('/department/listsub')) {
        return { json: async () => ({ errcode: 0, result: [{ dept_id: 11 }, { dept_id: 22 }] }) };
      }
      if (url.includes('/user/list')) {
        calls.push(body);
        if (body.cursor === 0) {
          return {
            json: async () => ({
              errcode: 0,
              result: {
                has_more: true,
                next_cursor: 100,
                list: [
                  { userid: 'U-1', name: '张三', mobile: '138' },
                  { userid: 'U-2', name: '李四' },
                ],
              },
            }),
          };
        }
        return {
          json: async () => ({
            errcode: 0,
            result: {
              has_more: false,
              list: [{ userid: 'U-1', name: '张三', mobile: '138' }], // 与第一页重复 → 去重
            },
          }),
        };
      }
      return { json: async () => ({ errcode: 0 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    const contacts = await adapter.syncContacts();
    // 3 个部门（1, 11, 22）× 2 页 = 6 次 user/list 调用，U-1 重复出现仅保留一次
    expect(contacts.map((c) => c.userId).sort()).toEqual(['U-1', 'U-2']);
    expect(calls.length).toBe(6); // 部门 1/11/22 × 分页 2 页
  });

  it('群名 20 字截断（钉钉限制 ≤30，按 20 截断）', async () => {
    mockFetch(async (url: string) => {
      if (url.includes('/gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'T', expires_in: 7200 }) };
      }
      if (url.includes('/v1.0/im/sceneGroup/create')) {
        return { json: async () => ({ open_conversation_id: 'cid-1' }), ok: true };
      }
      return { json: async () => ({ errcode: 0 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    const longTitle = `工单#abc123 ${'超长合同标题'.repeat(10)}`;
    const group = await adapter.createGroup(['U-1'], longTitle, 'U-1');
    expect(group.title.length).toBeLessThanOrEqual(20);
  });

  it('建群：DINGTALK_SCENE_TEMPLATE_ID 未配置时报明确错误', async () => {
    delete process.env.DINGTALK_SCENE_TEMPLATE_ID;
    const adapter = new DingTalkAdapterImpl();
    await expect(adapter.createGroup(['U-1'], '群', 'U-1')).rejects.toThrow(
      'DINGTALK_SCENE_TEMPLATE_ID 未配置',
    );
  });

  it('凭证缺失：构造不抛错，调用时降级为明确错误', async () => {
    delete process.env.DINGTALK_APP_KEY;
    const adapter = new DingTalkAdapterImpl();
    await expect((adapter as any).getAccessToken()).rejects.toThrow('钉钉凭证未配置');
  });

  it('建群请求体：创建场景群 v1.0 REST template_id + owner_user_id + user_ids(数组)', async () => {
    let captured: any = null;
    mockFetch(async (url: string, init?: any) => {
      if (url.includes('/v1.0/im/sceneGroup/create')) {
        captured = { url, body: JSON.parse(init.body), headers: init.headers };
        return { json: async () => ({ open_conversation_id: 'cid-1' }), ok: true };
      }
      return { json: async () => ({ errcode: 0, access_token: 'T', expires_in: 7200 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    const group = await adapter.createGroup(['U-1', 'U-2'], '工单群', 'U-1');
    expect(captured.url).toContain('/v1.0/im/sceneGroup/create');
    expect(captured.body).toMatchObject({
      template_id: 'tmpl-1',
      owner_user_id: 'U-1',
      user_ids: ['U-1', 'U-2'],
      title: '工单群',
    });
    expect(captured.headers['x-acs-dingtalk-access-token']).toBeTruthy();
    expect(group.chatId).toBe('cid-1');
  });

  it('加人请求体：场景群 member/add snake_case（open_conversation_id + user_ids）', async () => {
    let captured: any = null;
    mockFetch(async (url: string, init?: any) => {
      if (url.includes('/v1.0/im/sceneGroup/member/add')) {
        captured = JSON.parse(init.body);
        return { json: async () => ({ success: true }), ok: true };
      }
      return { json: async () => ({ errcode: 0, access_token: 'T', expires_in: 7200 }) };
    });
    const adapter = new DingTalkAdapterImpl();
    await adapter.addMember('cid-1', 'U-new');
    expect(captured).toMatchObject({
      open_conversation_id: 'cid-1',
      user_ids: ['U-new'],
    });
  });

  it('v1 接口 HTTP 非 2xx：抛错含 message', async () => {
    mockFetch(async (url: string) => {
      if (url.includes('/gettoken')) {
        return { json: async () => ({ errcode: 0, access_token: 'T', expires_in: 7200 }) };
      }
      return {
        json: async () => ({ code: 'permession.checkFailed', message: '群主不在应用可见性内' }),
        ok: false,
        status: 400,
      };
    });
    const adapter = new DingTalkAdapterImpl();
    await expect(adapter.addMember('cid-1', 'U-1')).rejects.toThrow('群主不在应用可见性内');
  });
});
