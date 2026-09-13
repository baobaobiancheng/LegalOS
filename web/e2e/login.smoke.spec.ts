import { test, expect } from '@playwright/test';

test('登录页作为公开入口可渲染并包含真实登录控件', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: '登录 LegalOS' })).toBeVisible();
  await expect(page.getByPlaceholder('请输入公司账号')).toBeVisible();
  await expect(page.getByPlaceholder('请输入密码')).toBeVisible();
  await expect(page.getByRole('button', { name: '登录工作台' })).toBeVisible();
  await expect(page.getByText('本地开发环境自动识别测试账号')).toHaveCount(0);
});

test('密码框只保留自定义显示控件，并支持点击和键盘切换', async ({ page }) => {
  await page.goto('/login');
  const password = page.getByPlaceholder('请输入密码');
  const toggle = page.locator('.password-field button');
  await password.fill('fictional-password-123');

  await expect(toggle).toHaveCount(1);
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await expect(toggle).toHaveAccessibleName('显示密码');

  // 原生按钮属于浏览器内部 UI，DOM 数量断言无法覆盖，另校验实际加载的屏蔽规则。
  const nativeRevealHidden = await page.evaluate(() =>
    [...document.styleSheets].some((sheet) =>
      [...sheet.cssRules].some((rule) =>
        rule instanceof CSSStyleRule
        && rule.selectorText.includes('#login-password')
        && rule.selectorText.includes('::-ms-reveal')
        && rule.style.display === 'none',
      ),
    ),
  );
  expect(nativeRevealHidden).toBe(true);

  await toggle.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveAccessibleName('隐藏密码');
  await expect(password).toHaveValue('fictional-password-123');

  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(toggle).toHaveAccessibleName('显示密码');
  await expect(password).toHaveValue('fictional-password-123');
  await expect(page).toHaveURL(/\/login$/);
});
