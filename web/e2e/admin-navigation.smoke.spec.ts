import { expect, test } from '@playwright/test';

test('管理员跨成员、看板、工单和工具页面保持同一套侧栏', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path.endsWith('/auth/refresh')) return route.fulfill({ json: { accessToken: 'fixture-token' } });
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { id: 'admin', role: 'admin', displayName: '管理员' } });
    if (path.endsWith('/admin/dashboard')) return route.fulfill({ json: {
      period: { days: 30, from: '2026-08-16', to: '2026-09-15' }, summary: { createdToday: 0, pending: 0, highRisk: 0, aiHandlingRate: 0 },
      trend: [], attention: { highRisk: 0, stale: 0, evidenceFailures: 0 }, workload: [], activities: [],
    } });
    if (path.endsWith('/projects')) return route.fulfill({ json: { items: [], groups: {}, groupCounts: {}, statusCounts: {}, total: 0, page: 1, size: 10 } });
    if (path.endsWith('/last-sync')) return route.fulfill({ json: null });
    if (path.endsWith('/failures')) return route.fulfill({ json: { noGroup: 0 } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/admin/members');
  const sidebar = page.locator('aside');
  const names = ['数据看板', '工单管理', '成员与职责', '法规与类案检索', '技能库'];
  for (const [name, path] of [
    ['成员与职责', '/admin/members'], ['数据看板', '/admin/dashboard'], ['工单管理', '/legal/projects'],
    ['法规与类案检索', '/legal/research'], ['技能库', '/legal/skills'], ['成员与职责', '/admin/members'],
  ]) {
    await sidebar.getByRole('button', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(sidebar.locator('nav button')).toHaveText(names);
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(sidebar.locator('[aria-current="page"]')).toHaveAttribute('aria-label', name);
    await expect(sidebar.getByRole('button', { name: '退出登录' })).toBeVisible();
    expect(await sidebar.evaluate(el => el.getBoundingClientRect().width)).toBe(254);
    await expect(page.locator('main')).toHaveCount(1);
  }
  await page.screenshot({ path: 'test-results/admin-navigation-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar.getByRole('button', { name: '数据看板', exact: true })).toBeInViewport();
  await sidebar.getByRole('button', { name: '数据看板', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
});

test('普通法务不出现管理员菜单且不能通过地址访问管理页', async ({ page }) => {
  await page.route('**/api/auth/refresh', route => route.fulfill({ json: { accessToken: 'fixture-token' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 'bp', role: 'legal_bp', displayName: '法务' } }));
  await page.route('**/api/projects?**', route => route.fulfill({ json: { items: [], groups: {}, groupCounts: {}, statusCounts: {}, total: 0, page: 1, size: 10 } }));
  await page.goto('/legal/projects');
  await expect(page.locator('aside nav button')).toHaveText(['工单管理', '法规与类案检索', '技能库']);
  await page.goto('/admin/members');
  await expect(page).toHaveURL(/\/403$/);
});
