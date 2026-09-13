import { test, expect, type Page } from '@playwright/test';
import { LEGAL_RESPONSIBILITIES } from '../../api/src/modules/members/legal-responsibility.catalog';

const admin = { id: 'routing-admin', username: 'xin.yan', displayName: '颜欣', role: 'admin' };
async function authenticate(page: Page, role = 'admin') {
  await page.route('**/api/auth/refresh', route => route.fulfill({ json: { accessToken: 'fictional-routing-token' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { ...admin, role } }));
}

test('职责目录支持搜索、详情切换和应用确认，不请求旧专业标签', async ({ page }) => {
  await authenticate(page);
  const requested: string[] = [];
  let applyCount = 0;
  await page.route('**/api/admin/members/**', route => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
    if (path.endsWith('/users')) return route.fulfill({ json: [admin] });
    if (path.endsWith('/failures')) return route.fulfill({ json: { noGroup: 0 } });
    if (path.endsWith('/last-sync')) return route.fulfill({ json: null });
    if (path.endsWith('/apply')) { applyCount++; return route.fulfill({ json: { applied: 1, blocked: 10 } }); }
    if (path.endsWith('/bp-responsibilities')) return route.fulfill({ json: LEGAL_RESPONSIBILITIES.map(person => ({
      ...person, scopes: person.scopes.map((scope, i) => ({ ...scope,
        state: applyCount && i === 0 ? 'active' : 'blocked',
        issue: applyCount && i === 0 ? null : '请同步钉钉通讯录并核对部门 ID/名称',
      })),
    })) });
    return route.fulfill({ status: 404, json: { error: 'Unexpected request' } });
  });
  await page.goto('/admin/members');
  await page.getByRole('button', { name: '分配与路由', exact: true }).click();
  const detail = page.getByRole('article', { name: '法务职责详情' });
  await expect(detail.getByRole('heading', { name: '彭宇欣', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /李潇潇.*启用/ }).click();
  await expect(detail.getByText('BaaS BG', { exact: true })).toBeVisible();
  await expect(detail.getByText('生态合作部', { exact: true }).last()).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索法务职责' }).fill('不存在的人员');
  await expect(page.getByText('未找到匹配的职责')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索法务职责' }).fill('华西南');
  await expect(detail.getByRole('heading', { name: '陈东', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索法务职责' }).fill('');
  await page.getByRole('button', { name: '核验并应用规则' }).click();
  expect(applyCount).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(applyCount).toBe(0);
  await page.getByRole('button', { name: '核验并应用规则' }).click();
  await page.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已应用 1 条');
  expect(applyCount).toBe(1);
  expect(requested.some(path => path.includes('bp-domains'))).toBe(false);
  await expect(page.getByText('法务专业领域标签')).toHaveCount(0);
  await page.getByRole('button', { name: /彭宇欣.*启用/ }).click();
  await expect(detail.getByRole('heading', { name: '彭宇欣', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/routing-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail.getByRole('heading', { name: '彭宇欣', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/routing-mobile.png', fullPage: true });
});

test('咨询默认自动识别，键盘仍可手动指定 AI 搜法', async ({ page }) => {
  await authenticate(page, 'business');
  await page.route('**/api/skills**', route => route.fulfill({ json: [] }));
  await page.goto('/business/consult');
  await expect(page.getByRole('button', { name: '自动识别' })).toBeVisible();
  await page.getByRole('button', { name: '自动识别' }).click();
  await page.getByRole('menuitemradio', { name: /^AI 搜法 检索/ }).click();
  await expect(page.getByRole('button', { name: 'AI 搜法' })).toBeVisible();
  await page.getByRole('button', { name: 'AI 搜法' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '自动识别' })).toBeVisible();
  let receivedCapability: string | undefined;
  await page.route('**/api/projects', route => route.fulfill({ json: { id: 'intent-test', route: 'llm' } }));
  await page.route('**/api/projects/intent-test/messages', route => {
    receivedCapability = route.request().postDataJSON().capability;
    return route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'message_start', runId: 'r1', messageId: 'r1', capability: 'law_search' },
      { type: 'text_delta', runId: 'r1', seq: 1, delta: '能力请求验证完成' },
      { type: 'message_end', runId: 'r1', messageId: 'r1', seq: 2, finalText: '能力请求验证完成' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.getByRole('textbox').fill('请检索相关法规，这是界面测试');
  await page.getByRole('button', { name: '开始咨询', exact: true }).click();
  await expect(page.getByText('能力请求验证完成')).toBeVisible();
  expect(receivedCapability).toBe('auto');
});
