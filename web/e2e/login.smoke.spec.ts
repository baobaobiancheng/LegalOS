import { test, expect } from '@playwright/test';

test('登录页作为公开入口可渲染并包含真实登录控件', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByPlaceholder('请输入用户名')).toBeVisible();
  await expect(page.getByPlaceholder('请输入密码')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
});
