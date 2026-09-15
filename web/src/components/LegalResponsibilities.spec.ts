import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { RequestError, request } from '../api/client'
import LegalResponsibilities from './LegalResponsibilities.vue'

vi.mock('vue', async original => {
  const vue = await original<typeof import('vue')>()
  return { ...vue, onMounted: vue.onServerPrefetch }
})
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), request: vi.fn() }))
const render = () => renderToString(createSSRApp({ render: () => h(LegalResponsibilities) }))
beforeEach(() => vi.clearAllMocks())

describe('职责目录渲染', () => {
  it('从真实状态显示核验结果，不将待应用视为已启用', async () => {
    vi.mocked(request).mockResolvedValue([{
      key: 'p1', name: '测试法务', businessLines: ['测试业务线'], description: '完整职责说明', pendingScopes: ['待核实子部门'],
      scopes: [
        { id: '1', name: '已配置部门', state: 'active', issue: null, issueCode: null },
        { id: '2', name: '未应用部门', state: 'ready', issue: null, issueCode: null },
        { id: '3', name: '缺失组织', state: 'blocked', issue: '请同步通讯录', issueCode: 'DEPARTMENT_NOT_SYNCED' },
        { id: '4', name: '账号缺失', state: 'blocked', issue: '请核验账号', issueCode: 'ACCOUNT_NOT_READY' },
        { id: '5', name: '部门已更名', state: 'blocked', issue: '请核验部门名称', issueCode: 'DEPARTMENT_MISMATCH' },
      ],
    }])
    const html = await render()
    expect(html).toMatch(/已录入职责 <span[^>]*>1 人<\/span>/)
    expect(html).toContain('非全员名册')
    for (const text of ['完整职责说明', '已启用', '待应用', '待同步组织', '待关联账号', '待核验部门', '请同步通讯录', '待核实子部门', '不会改变工单可见权限', '无需重复填写职责']) expect(html).toContain(text)
    expect(html).not.toContain('待完善')
    expect(html).not.toContain('法务专业领域标签')
    expect(vi.mocked(request)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(request)).toHaveBeenCalledWith('/admin/members/bp-responsibilities')
  })
  it('没有部门 ID 时保留原职责与待对应范围，不伪装成已关联组织', async () => {
    vi.mocked(request).mockResolvedValue([{
      key: 'overseas', name: '测试法务', businessLines: ['海外业务'], description: '海外支持职责已提供',
      pendingScopes: ['海外业务相关同事'], scopes: [],
    }])
    const html = await render()
    expect(html).toContain('海外支持职责已提供')
    expect(html).toContain('海外业务相关同事')
    expect(html).toContain('尚未对应到具体钉钉部门或人员')
    expect(html).not.toContain('scope-table')
  })
  it('空目录明确显示空态并禁用应用', async () => {
    vi.mocked(request).mockResolvedValue([])
    const html = await render()
    expect(html).toContain('暂无职责目录')
    expect(html).toMatch(/class="apply-button"[^>]*disabled/)
  })
  it('加载错误保留请求标识，不伪装成空目录', async () => {
    vi.mocked(request).mockRejectedValue(new RequestError({ error: '连接暂不可用', code: 'UNAVAILABLE', statusCode: 503, requestId: 'routing-rid' }))
    const html = await render()
    expect(html).toContain('连接暂不可用')
    expect(html).toContain('routing-rid')
    expect(html).not.toContain('暂无职责目录')
  })
})
