import { defineConfig } from 'vitest/config';

/** 集成测试独立 include，避免 shell glob 在不同 Runner 中被当成字面量。 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.spec.ts'],
  },
});
