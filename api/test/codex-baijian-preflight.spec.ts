import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { validateManagedRequirements } from '../scripts/preflight-codex-baijian';

describe('Codex 百鉴受管策略预检', () => {
  const templatePath = join(process.cwd(), '..', 'deploy', 'codex', 'requirements.toml.example');

  it('仓库受管策略模板通过硬化契约', () => {
    expect(validateManagedRequirements(readFileSync(templatePath, 'utf8'))).toEqual([]);
  });

  it('拒绝放宽权限档案、全局关闭合同读取能力或写入 Secret', () => {
    const unsafe = readFileSync(templatePath, 'utf8')
      .replace('extends = ":read-only"', 'extends = ":workspace"')
      .replace('multi_agent = false', 'shell_tool = false\nmulti_agent = false')
      .concat('\nBAIJIAN_MCP_APP_SECRET = "do-not-store"\n');
    expect(validateManagedRequirements(unsafe)).toEqual(expect.arrayContaining([
      expect.stringContaining('extends'),
      expect.stringContaining('shell_tool'),
      expect.stringContaining('Secret'),
    ]));
  });
});
