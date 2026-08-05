import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      // /review 2026-08-05：扩展到全部业务模块（原仅 skill，钉钉/成员/风险分类被排除在统计外）
      include: ['src/modules/**', 'src/common/**'],
    },
  },
});
