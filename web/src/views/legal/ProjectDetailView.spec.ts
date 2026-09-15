import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { RequestError, request } from '../../api/client'
import { Role, ROLE_LABEL, type ProjectDetail } from '../../types'
import ProjectDetailView from './ProjectDetailView.vue'

// Run the page's normal loading hooks before SSR, without requiring a DOM or live API.
vi.mock('vue', async importOriginal => {
  const vue = await importOriginal<typeof import('vue')>()
  return { ...vue, onMounted: vue.onServerPrefetch }
})
vi.mock('../../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/client')>(), request: vi.fn(),
}))
vi.mock('../../components/MarkdownContent.vue', () => ({ default: { props: ['text'], template: '<div>{{ text }}</div>' } }))
vi.mock('../../components/DownloadMenu.vue', () => ({ default: { template: '<button>下载</button>' } }))

const member = { id: 'creator', username: 'requester', displayName: '业务申请人', role: Role.BUSINESS }
let project: ProjectDetail

async function renderPage(role: Role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = { id: 'viewer', username: 'xin.yan', displayName: '管理员查看人', avatarUrl: null, role }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/legal/projects/:id', component: ProjectDetailView },
    { path: '/admin/dashboard', component: { template: '<div />' } },
    { path: '/admin/members', component: { template: '<div />' } },
  ] })
  await router.push('/legal/projects/project-id')
  await router.isReady()
  const app = createSSRApp({ render: () => h(ProjectDetailView) })
  app.use(pinia).use(router)
  return renderToString(app)
}

beforeEach(() => {
  vi.clearAllMocks()
  project = {
    id: 'project-id', kind: 'consult', title: '完整工单标题，不应在旧 Demo 顶栏中截断', status: '待处理',
    risk: 'P1', route: 'legalbp', isFailed: false, creator: member, owner: member,
    createdAt: '2026-09-13T04:00:00Z', updatedAt: '2026-09-13T04:00:00Z',
    messages: [
      { id: 'user-msg', role: 'user', text: '申请内容', createdAt: '2026-09-13T04:00:00Z' },
      { id: 'legal-msg', role: 'legal', text: '人工法务回复', createdAt: '2026-09-13T04:02:00Z' },
    ],
    events: [{ id: 'event-id', text: '工单已创建', createdAt: '2026-09-13T04:00:00Z' }],
    history: { beforeMessageId: 'older', beforeEventId: null },
  }
  vi.mocked(request).mockImplementation(async path => {
    if (path === '/projects/project-id') return project as never
    if (path === '/projects/assignees') return [{ id: 'bp', displayName: '李潇潇', role: Role.LEGAL_BP }] as never
    if (path === '/projects/project-id/files') return [
      { id: 'source', kind: 'source', originalName: '原始合同.docx', size: 1024, uploader: member },
      { id: 'final', kind: 'final', originalName: '法务定稿.docx', size: 2048, uploader: { ...member, role: Role.LEGAL_BP } },
    ] as never
    throw new Error(`Unexpected request: ${path}`)
  })
})

describe('工单详情统一布局', () => {
  it.each([Role.ADMIN, Role.LEGAL_LEAD, Role.LEGAL_BP])('%s 显示真实角色与对应管理入口', async role => {
    const html = await renderPage(role)
    expect(html).toContain('legal-workspace-shell')
    expect(html).toContain(ROLE_LABEL[role])
    expect(html.includes('aria-label="成员与职责"')).toBe(role === Role.ADMIN)
    expect(html.includes('aria-label="数据看板"')).toBe(role === Role.ADMIN)
    expect(html.includes('aria-label="法务领导分配工单"')).toBe(role !== Role.LEGAL_BP)
    expect(html).not.toContain('class="aurora"')
    expect(html).not.toContain('sidebar-glass')
  })

  it('保留完整标题、申请人、时间线、历史加载和下载，不将人工回复标为 AI', async () => {
    const html = await renderPage(Role.ADMIN)
    for (const text of [project.title, '业务申请人', '工单已创建', '申请内容', '人工法务回复', '加载更早记录', '下载', '李潇潇', '回传意见']) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('AI 生成 · 仅供参考')
    expect(vi.mocked(request).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('CRM 合同保留三方原文件及法务定稿选择，原文件不能用于回传', async () => {
    Object.assign(project, { kind: 'contract', sourceAppId: 'crm', crmTaskId: 'task', crmDeliveryStatus: 'pending' })
    const html = await renderPage(Role.ADMIN)
    expect(html).toContain('原始合同.docx')
    expect(html).toContain('法务定稿.docx')
    expect(html).toContain('上传定稿')
    expect(html).toMatch(/type="radio"[^>]*value="source"[^>]*disabled/)
    expect(html.match(/<input[^>]*value="final"[^>]*>/)?.[0]).toContain('checked')
  })

  it('已取消工单不显示分配与输入区', async () => {
    project.status = '已取消'
    const html = await renderPage(Role.ADMIN)
    expect(html).not.toContain('aria-label="法务领导分配工单"')
    expect(html).not.toContain('id="project-reply"')
    expect(html).not.toContain('待领导分配')
  })

  it('数字分身处理的工单不显示为等待领导分配', async () => {
    project.route = 'ai'
    const html = await renderPage(Role.ADMIN)
    expect(html).toContain('数字分身处理')
    expect(html).not.toContain('待领导分配')
  })

  it('加载失败保留错误、请求 ID、重试和管理员导航，不显示操作区', async () => {
    vi.mocked(request).mockRejectedValue(new RequestError({ error: '无权执行此操作', code: 'FORBIDDEN', statusCode: 403, requestId: 'request-403' }))
    const html = await renderPage(Role.ADMIN)
    expect(html).toContain('无权执行此操作')
    expect(html).toContain('request-403')
    expect(html).toContain('重试')
    expect(html).toContain('aria-label="成员与职责"')
    expect(html).not.toContain('id="project-reply"')
  })
})
