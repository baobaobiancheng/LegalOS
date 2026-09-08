/**
 * 编译产物的真实 HTTP 安全回归，仅允许显式指定本机 *_test 数据库。
 * 先在隔离测试库执行已有迁移，再运行：
 * TEST_DATABASE_URL=mysql://.../legalos_audit_test node scripts/verify-security-smoke.mjs
 * 不读取生产凭证，不调用真实 CAS、CRM、钉钉或 AI，不执行 seed。
 */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 可对独立干净安装目录验证同一套编译产物，不复制或读取原 API 的 .env。
const apiDir = resolve(process.env.SECURITY_SMOKE_API_DIR || join(repository, 'api'));
const require = createRequire(join(apiDir, 'package.json'));
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const JSZip = require('jszip');
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('必须显式提供 TEST_DATABASE_URL');
const database = new URL(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname), '仅允许本机隔离测试库');
assert.match(database.pathname, /^\/[a-zA-Z0-9_]+_test$/, '数据库名称必须以 _test 结尾');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const workspace = await mkdtemp(join(tmpdir(), 'legalos-security-smoke-'));
const storage = join(workspace, 'contracts');
const secret = randomBytes(32).toString('hex');
const password = `Test-only-${randomUUID()}!`;
const prefix = `security-smoke-${randomUUID()}`;
const testNames = [];
let child;

try {
  const passwordHash = await bcrypt.hash(password, 10);
  const makeUser = (role, suffix) => prisma.user.create({ data: {
    username: `${prefix}-${suffix}`, displayName: `测试用户 ${suffix}`, passwordHash, role,
  } });
  const business = await makeUser('business', 'business');
  const bp = await makeUser('legal_bp', 'bp');
  const other = await makeUser('business', 'other');
  const otherBp = await makeUser('legal_bp', 'other-bp');
  const project = await prisma.project.create({ data: {
    kind: 'contract', title: `${prefix}-待认领`, creatorId: other.id, ownerId: other.id,
    legalBpId: null, route: 'legalbp', risk: 'P1', status: '待复核',
    result: 'PRIVATE_RESULT_SENTINEL', crmCustomer: 'PRIVATE_CUSTOMER_SENTINEL',
    crmReference: 'PRIVATE_CRM_SENTINEL', extra: { sensitive: 'PRIVATE_EXTRA_SENTINEL' },
  } });
  const ownedProject = await prisma.project.create({ data: {
    kind: 'contract', title: `${prefix}-已分配`, creatorId: business.id, ownerId: bp.id,
    legalBpId: bp.id, route: 'legalbp', risk: 'P1', status: '待复核',
  } });
  const unclaimedAiProject = await prisma.project.create({ data: {
    kind: 'consult', title: `${prefix}-数字分身`, creatorId: other.id, ownerId: other.id,
    legalBpId: null, route: 'llm', risk: 'P1', status: '待复核',
    result: 'PRIVATE_AI_RESULT_SENTINEL',
  } });
  const ownerOnlyProject = await prisma.project.create({ data: {
    kind: 'contract', title: `${prefix}-归属负责人`, creatorId: business.id, ownerId: bp.id,
    legalBpId: otherBp.id, route: 'legalbp', risk: 'P1', status: '待复核',
  } });
  const file = await prisma.contractFile.create({ data: {
    projectId: ownedProject.id, kind: 'final', originalName: '安全测试.txt',
    storedName: 'security-fixture.txt', mimeType: 'text/plain', size: 7, uploadedBy: bp.id,
  } });
  await mkdir(join(storage, ownedProject.id), { recursive: true, mode: 0o700 });
  await writeFile(join(storage, ownedProject.id, file.storedName), 'fixture', { mode: 0o600 });

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolveClose, rejectClose) => reservation.close((error) => error ? rejectClose(error) : resolveClose()));
  const base = `http://127.0.0.1:${port}/api`;
  child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: apiDir,
    env: {
      ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', PORT: String(port),
      JWT_SECRET: secret, CAS_BYPASS: 'true', CAS_ENFORCED: 'false', CAS_HOST: '',
      CRM_A1_ENABLED: 'false', CRM_MOCK: 'false', DINGTALK_MOCK: 'true',
      AI_EXECUTION_ENABLED: 'false', CONTRACT_STORAGE_DIR: storage,
      DSH_HOME: join(workspace, 'dsh'), CODEX_WORKSPACE: join(workspace, 'codex'),
      AUDIT_HMAC_SECRET: secret, AUDIT_FINGERPRINT_SALT: secret,
      WEB_ORIGIN: `http://127.0.0.1:${port}`, OUTBOX_POLL_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 日志可能包含供应商诊断，测试只输出断言名称，不复印日志正文。
  child.stdout.resume();
  child.stderr.resume();
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`测试 API 启动失败，exit=${child.exitCode}`);
    try {
      const response = await fetch(`${base}/auth/me`, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      if (response.status === 401) { ready = true; break; }
    } catch { /* 仅等待本测试进程启动。 */ }
    await delay(100);
  }
  assert.ok(ready, '编译后 API 应成功启动');
  const check = async (name, run) => { await run(); testNames.push(name); console.log(`PASS ${name}`); };
  const call = (path, token, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    signal: AbortSignal.timeout(5000),
  });
  const login = async (username) => {
    const response = await call('/auth/login', null, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(typeof body.accessToken, 'string');
    assert.equal('passwordHash' in body, false);
    return body.accessToken;
  };
  const bpToken = await login(bp.username);
  const businessToken = await login(business.username);

  await check('未认证请求被拒绝，响应含 requestId', async () => {
    const response = await call('/projects');
    assert.equal(response.status, 401);
    assert.ok(response.headers.get('x-request-id'));
    assert.equal((await response.json()).statusCode, 401);
  });
  await check('未认领工单没有泄露完整结果/CRM/extra', async () => {
    const response = await call(`/projects?query=${encodeURIComponent(prefix)}`, bpToken);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.items.some((item) => item.id === project.id));
    assert.ok(body.items.some((item) => item.id === ownerOnlyProject.id), '负责人可见范围与详情权限一致');
    assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
    const detail = await call(`/projects/${project.id}`, bpToken);
    assert.equal(detail.status, 403, '可见认领摘要不等于可读工单详情');
    await detail.arrayBuffer();
  });
  await check('脱敏摘要与数字分身分组、计数保持一致', async () => {
    const response = await call(`/projects?group=${encodeURIComponent('数字分身处理')}`, bpToken);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.items.some((item) => item.id === unclaimedAiProject.id));
    assert.deepEqual(body.groups['数字分身处理'].map((item) => item.id), body.items.map((item) => item.id));
    assert.ok(body.groupCounts['数字分身处理'] >= body.items.length);
    assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
  });
  await check('非法分页参数返回 400 而非数据库异常', async () => {
    for (const query of ['size=1000000', 'page=-1', 'page=NaN', 'size=1.5', 'status=invalid']) {
      const response = await call(`/projects?${query}`, bpToken);
      assert.equal(response.status, 400, query);
      const body = await response.text();
      assert.doesNotMatch(body, /Prisma|SELECT|passwordHash|stack/);
    }
  });
  await check('业务用户无法读取他人工单或管理列表', async () => {
    const response = await call(`/projects/${project.id}`, businessToken);
    assert.equal(response.status, 403);
    await response.arrayBuffer();
    const admin = await call('/admin/members/users', businessToken);
    assert.equal(admin.status, 403);
    await admin.arrayBuffer();
  });
  await check('过期 JWT 被拒绝', async () => {
    const expired = jwt.sign({ sub: bp.id, type: 'access', authMethod: 'password' }, secret, { expiresIn: -1 });
    const response = await call('/auth/me', expired);
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  });
  await check('下载必须认证，Bearer 下载返回原文件', async () => {
    const path = `/projects/${ownedProject.id}/files/${file.id}`;
    const anonymous = await call(path);
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();
    const response = await call(path, bpToken);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(await response.text(), 'fixture');
  });
  const upload = (name, content) => {
    const form = new FormData();
    form.set('kind', 'revised');
    form.set('file', new Blob([content]), name);
    return call(`/projects/${ownedProject.id}/files`, bpToken, { method: 'POST', body: form });
  };
  await check('真实 multipart 与编译 Worker 解析 TXT/MD/DOCX/PDF 并持久化正文', async () => {
    const archive = new JSZip();
    archive.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    archive.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Worker contract fixture</w:t></w:r></w:p></w:body></w:document>');
    const fixtures = [
      ['worker.txt', 'Worker text fixture', 'Worker text fixture'],
      ['worker.md', '# Worker markdown fixture', 'Worker markdown fixture'],
      ['worker.pdf', textPdf('Worker PDF fixture'), 'Worker PDF fixture'],
      ['worker.docx', await archive.generateAsync({ type: 'nodebuffer' }), 'Worker contract fixture'],
    ];
    for (const [name, content, expected] of fixtures) {
      const response = await upload(name, content);
      assert.equal(response.status, 201, `${name}: ${await response.clone().text()}`);
      const result = await response.json();
      assert.equal(result.textExtracted, true, name);
      const document = await prisma.contractDocument.findFirstOrThrow({ where: { sourceFileId: result.fileId } });
      assert.ok(document.content.includes(expected), name);
    }
  });
  await check('非法文件返回 422，不残留 staging 或文件记录', async () => {
    const before = await prisma.contractFile.count({ where: { projectId: ownedProject.id } });
    for (const [name, content] of [
      ['invalid.txt', Buffer.from([0xc3, 0x28])],
      ['fake.pdf', 'not a PDF'],
      ['broken.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01])],
    ]) {
      const response = await upload(name, content);
      assert.equal(response.status, 422, name);
      assert.doesNotMatch(await response.text(), /stack|Prisma|node_modules/);
    }
    assert.equal(await prisma.contractFile.count({ where: { projectId: ownedProject.id } }), before);
    assert.deepEqual(await readdir(join(storage, '.staging')), []);
  });
  await check('停用用户的已有 JWT 立即失效', async () => {
    await prisma.user.update({ where: { id: bp.id }, data: { isActive: false } });
    const response = await call('/auth/me', bpToken);
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  });
  await check('CRM 未配置/关闭时不能接收入站任务', async () => {
    const response = await call('/crm/v1/contract-tasks', null, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE_|passwordHash|stack/);
  });
  console.log(`Security smoke: ${testNames.length} passed; only isolated test data used.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try { await exited; } finally { clearTimeout(deadline); }
  }
  await prisma.$disconnect();
  // 仅删除 mkdtemp 创建的测试目录，绝不指向调用方的数据目录。
  await rm(workspace, { recursive: true, force: true });
}

/** 独立生成仅含虚构文本的单页 PDF，不依赖真实合同或外部下载。 */
function textPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
