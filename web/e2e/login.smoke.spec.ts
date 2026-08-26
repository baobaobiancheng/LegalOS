import { test, expect } from '@playwright/test';

test('登录页作为公开入口可渲染并包含真实登录控件', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: '登录 LegalOS' })).toBeVisible();
  await expect(page.getByPlaceholder('请输入公司账号')).toBeVisible();
  await expect(page.getByPlaceholder('请输入密码')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录工作台' })).toBeVisible();
  await expect(page.getByText('本地开发环境自动识别测试账号')).toHaveCount(0);
});
