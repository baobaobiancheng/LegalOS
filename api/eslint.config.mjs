// P1-12 最小 ESLint 配置（flat config，eslint 9 + typescript-eslint v8）
// 使用 recommended 基线；`any` 在适配器/迁移等边界允许（避免大规模噪音）。
// 保持规则开启，不整体关闭；新增错误需先修复再合入。
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', '*.config.*'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
