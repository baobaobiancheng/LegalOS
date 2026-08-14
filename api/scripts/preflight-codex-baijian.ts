import { execFileSync } from 'child_process';
import { readFileSync, statSync } from 'fs';

export const EXPECTED_CODEX_VERSION = '0.146.0';

export function validateManagedRequirementsFile(requirementsPath: string): {
  failures: string[];
  mode: number;
} {
  const stat = statSync(requirementsPath);
  const mode = stat.mode & 0o777;
  const failures = validateManagedRequirements(readFileSync(requirementsPath, 'utf8'));
  if (mode & 0o022) failures.push(`受管策略可被 group/other 写入：mode=${mode.toString(8)}`);
  if (requirementsPath === '/etc/codex/requirements.toml' && stat.uid !== 0) {
    failures.push(`受管策略不属于 root：uid=${stat.uid}`);
  }
  return { failures, mode };
}

export function validateManagedRequirements(content: string): string[] {
  const failures: string[] = [];
  requireExactArray(content, 'allowed_approval_policies', ['never'], failures);
  requireExactArray(content, 'allowed_web_search_modes', ['disabled'], failures);
  requireExactString(content, 'default_permissions', 'legalos_ai', failures);
  requireBoolean(content, 'allow_login_shell', false, failures);
  requireBoolean(content, 'allow_managed_hooks_only', true, failures);
  requireBoolean(content, 'allow_appshots', false, failures);
  requireBoolean(content, 'allow_remote_control', false, failures);

  const allowedProfiles = tableBody(content, 'allowed_permission_profiles');
  if (!allowedProfiles) failures.push('缺少 [allowed_permission_profiles]');
  else requireBoolean(allowedProfiles, 'legalos_ai', true, failures, '[allowed_permission_profiles]');

  const permissionProfile = tableBody(content, 'permissions.legalos_ai');
  if (!permissionProfile) failures.push('缺少 [permissions.legalos_ai]');
  else requireExactString(permissionProfile, 'extends', ':read-only', failures, '[permissions.legalos_ai]');

  const profileFilesystem = tableBody(content, 'permissions.legalos_ai.filesystem');
  if (!profileFilesystem) failures.push('缺少 [permissions.legalos_ai.filesystem]');
  else {
    requireExactString(profileFilesystem, ':root', 'deny', failures, '[permissions.legalos_ai.filesystem]');
    requireExactString(profileFilesystem, ':minimal', 'read', failures, '[permissions.legalos_ai.filesystem]');
    requireExactString(profileFilesystem, ':tmpdir', 'deny', failures, '[permissions.legalos_ai.filesystem]');
    requireExactString(profileFilesystem, ':slash_tmp', 'deny', failures, '[permissions.legalos_ai.filesystem]');
  }

  const workspaceRoots = tableBody(content, 'permissions.legalos_ai.filesystem.":workspace_roots"');
  if (!workspaceRoots) failures.push('缺少 [permissions.legalos_ai.filesystem.":workspace_roots"]');
  else requireExactString(workspaceRoots, '.', 'read', failures, '[permissions.legalos_ai.filesystem.":workspace_roots"]');

  const profileNetwork = tableBody(content, 'permissions.legalos_ai.network');
  if (!profileNetwork) failures.push('缺少 [permissions.legalos_ai.network]');
  else requireBoolean(profileNetwork, 'enabled', false, failures, '[permissions.legalos_ai.network]');

  const features = tableBody(content, 'feature_requirements');
  if (!features) failures.push('缺少 [feature_requirements]');
  else {
    requireBoolean(features, 'multi_agent', false, failures, '[feature_requirements]');
    requireBoolean(features, 'memories', false, failures, '[feature_requirements]');
    if (/^shell_tool\s*=\s*false\s*$/m.test(features)) {
      failures.push('[feature_requirements].shell_tool 不得全局关闭，否则现有合同起草无法读取工作区模板');
    }
  }

  const baijian = tableBody(content, 'mcp_servers.baijian');
  if (!baijian) failures.push('缺少 [mcp_servers.baijian]');
  else if (!/^identity\s*=\s*\{\s*url\s*=\s*"https:\/\/mcpgateway\.100credit\.cn\/mcp"\s*\}\s*$/m.test(baijian)) {
    failures.push('百鉴 MCP identity 未锁定到预期 HTTPS URL');
  }

  if (/X-App-Secret\s*=|CODEX_API_KEY\s*=|BAIJIAN_MCP_APP_SECRET\s*=/i.test(content)) {
    failures.push('受管策略疑似包含 Secret，凭证必须只通过环境变量注入');
  }
  return failures;
}

function main(): void {
  const requiredSecrets = ['CODEX_API_KEY', 'BAIJIAN_MCP_APP_KEY', 'BAIJIAN_MCP_APP_SECRET'];
  const missingSecrets = requiredSecrets.filter((name) => !process.env[name]);
  const requirementsPath = process.env.CODEX_MANAGED_REQUIREMENTS_PATH
    ?? '/etc/codex/requirements.toml';
  const expectedVersion = process.env.CODEX_EXPECTED_VERSION ?? EXPECTED_CODEX_VERSION;
  const codexPath = process.env.CODEX_PATH ?? 'codex';

  const rawVersion = execFileSync(codexPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const actualVersion = rawVersion.match(/codex-cli\s+([^\s]+)/)?.[1] ?? rawVersion;
  const { failures, mode } = validateManagedRequirementsFile(requirementsPath);

  if (actualVersion !== expectedVersion) failures.push(`Codex CLI 版本为 ${actualVersion}，预期 ${expectedVersion}`);
  if (missingSecrets.length) failures.push(`缺少环境变量：${missingSecrets.join(', ')}`);
  if (failures.length) throw new Error(failures.join('；'));

  console.log(JSON.stringify({
    gate: 'codex-baijian-preflight',
    status: 'passed',
    codexVersion: actualVersion,
    requirementsPath,
    requirementsMode: mode.toString(8),
    secrets: Object.fromEntries(requiredSecrets.map((name) => [name, 'present'])),
  }, null, 2));
}

function requireExactArray(content: string, key: string, values: string[], failures: string[]): void {
  const expected = values.map((value) => `"${value}"`).join(', ');
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*\\[\\s*${values
    .map((value) => `"${escapeRegExp(value)}"`)
    .join('\\s*,\\s*')}\\s*\\]\\s*$`, 'm');
  if (!pattern.test(content)) failures.push(`${key} 必须精确为 [${expected}]`);
}

function requireExactString(
  content: string,
  key: string,
  expected: string,
  failures: string[],
  scope = '顶层',
): void {
  const pattern = new RegExp(`^"?${escapeRegExp(key)}"?\\s*=\\s*"${escapeRegExp(expected)}"\\s*$`, 'm');
  if (!pattern.test(content)) failures.push(`${scope}.${key} 必须精确为 "${expected}"`);
}

function requireBoolean(
  content: string,
  key: string,
  expected: boolean,
  failures: string[],
  scope = '顶层',
): void {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*${expected}\\s*$`, 'm');
  if (!pattern.test(content)) failures.push(`${scope}.${key} 必须为 ${expected}`);
}

function tableBody(content: string, name: string): string | null {
  const match = new RegExp(
    `^\\[${escapeRegExp(name)}\\]\\s*$([\\s\\S]*?)(?=^\\[[^\\]]+\\]\\s*$|(?![\\s\\S]))`,
    'm',
  ).exec(content);
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ code: 'PREFLIGHT_FAILED', message: (error as Error).message }));
    process.exitCode = 1;
  }
}
