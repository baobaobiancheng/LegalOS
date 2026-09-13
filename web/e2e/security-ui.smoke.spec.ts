import { test, expect, type Page } from '@playwright/test';

const user = { id: 'test-bp', username: 'test-bp', displayName: '测试法务', role: 'legal_bp' };
const token = 'fictional-ui-test-token';
const now = '2026-09-08T00:00:00.000Z';

async function authenticate(page: Page) {
  await page.route('**/api/auth/refresh', (route) => route.fulfill({ json: { accessToken: token } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: user }));
}

test('历史分页失败保留最新记录，重试成功追加旧记录', async ({ page }) => {
  await authenticate(page);
  let fail = true;
  const projectId = 'history-test';
  const project = {
    id: projectId, title: '历史分页测试', kind: 'consult', route: 'legalbp', status: '待复核', risk: 'P1',
    creatorId: user.id, ownerId: user.id, legalBpId: user.id, creator: user, owner: user,
    messages: [{ id: 'new', role: 'user', text: '最新问题保留', createdAt: now }], events: [],
    history: { beforeMessageId: 'new', beforeEventId: null }, createdAt: now, updatedAt: now,
  };
  await page.route(`**/api/projects/${projectId}*`, (route) => {
    const before = new URL(route.request().url()).searchParams.get('beforeMessageId');
    if (!before) return route.fulfill({ json: project });
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '临时不可用' } }); }
    return route.fulfill({ json: {
      ...project, messages: [{ id: 'old', role: 'user', text: '更早问题已加载', createdAt: '2026-09-01' }],
      history: { beforeMessageId: null, beforeEventId: null },
    } });
  });
  await page.goto(`/legal/projects/${projectId}`);
  await expect(page.getByText('最新问题保留', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载更早记录' }).click();
  await expect(page.getByRole('alert')).toContainText('当前记录已保留');
  await expect(page.getByText('最新问题保留', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加载更早记录' }).click();
  await expect(page.getByText('更早问题已加载', { exact: true })).toBeVisible();
  await expect(page.getByText('最新问题保留', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载更早记录' })).toHaveCount(0);
});

test('未认领摘要没有用户详情时，列表仍正常渲染', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await authenticate(page);
  const summary = {
    id: 'unclaimed-test', title: '最小权限摘要测试', kind: 'consult', route: 'legalbp',
    risk: 'P1', status: '待复核', legalBpId: null, createdAt: now, updatedAt: now,
  };
  await page.route('**/api/projects?*', (route) => route.fulfill({ json: {
    items: [summary], groups: { 待处理: [summary] },
    groupCounts: { 待处理: 1, 合同协作: 0, 已回传: 0, 数字分身处理: 0 },
    statusCounts: {}, total: 1, page: 1, size: 10,
  } }));
  await page.goto('/legal/projects');
  await expect(page.getByRole('table', { name: '工单列表' })).toBeVisible();
  await expect(page.getByText('最小权限摘要测试', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('合同附件通过 Bearer 获取并下载，不使用未认证新窗口', async ({ page }) => {
  await authenticate(page);
  const projectId = 'download-project-test';
  const project = {
    id: projectId, title: '附件认证回归测试', kind: 'contract', route: 'legalbp',
    status: '待复核', risk: 'P1', creatorId: user.id, ownerId: user.id, legalBpId: user.id,
    creator: user, owner: user, legalBp: user, messages: [], events: [],
    createdAt: now, updatedAt: now,
  };
  await page.route(`**/api/projects/${projectId}`, (route) => route.fulfill({ json: project }));
  await page.route(`**/api/projects/${projectId}/files`, (route) => route.fulfill({ json: [{
    id: 'file-test', projectId, kind: 'final', originalName: '下载回归.txt',
    size: 7, mimeType: 'text/plain', uploader: user, uploadedBy: user.id, createdAt: now,
  }] }));
  let authorization: string | undefined;
  await page.route(`**/api/projects/${projectId}/files/file-test`, async (route) => {
    authorization = route.request().headers().authorization;
    await route.fulfill({ status: authorization === `Bearer ${token}` ? 200 : 401,
      contentType: 'text/plain', body: 'fixture' });
  });
  await page.goto(`/legal/projects/${projectId}`);
  await expect(page.getByText('下载回归.txt', { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByText('下载回归.txt', { exact: true }).click();
  const download = await downloaded;
  expect(authorization).toBe(`Bearer ${token}`);
  expect(download.suggestedFilename()).toBe('下载回归.txt');
  expect(page.context().pages()).toHaveLength(1);
});
