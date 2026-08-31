import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CrmA1AuthService,
  buildCrmA1SignatureMessage,
  isCrmA1SecretStrong,
} from '../src/modules/crm-integration/crm-a1-auth.service';
import { CrmA1Headers, CrmMultipartEnvelope } from '../src/modules/crm-integration/crm-a1.types';

describe('CRM A1 验签与 nonce', () => {
  const now = 1_725_000_000;
  const secret = 'crm-secret-for-tests-at-least-32-bytes';

  it('按 v1 契约组装签名串并校验实际 payload/manifest 指纹', () => {
    const headers = baseHeaders();
    headers.signature = createHmac('sha256', secret)
      .update(buildCrmA1SignatureMessage(headers))
      .digest('hex');
    const service = authService({}, config());

    expect(() => service.verifySignature(headers)).not.toThrow();
    expect(() => service.verifyContentDigests(headers, envelope())).not.toThrow();
    expect(() => service.verifyContentDigests(headers, envelope({ payloadSha256: 'c'.repeat(64) })))
      .toThrow(expect.objectContaining({ status: 401 }));
  });

  it('拒绝少于 32 字节的 HMAC 密钥', () => {
    expect(isCrmA1SecretStrong('short-secret')).toBe(false);
    expect(isCrmA1SecretStrong('x'.repeat(32))).toBe(true);
    expect(() => authService({}, config({ CRM_A1_SECRET: 'short-secret' })).verifySignature(baseHeaders()))
      .toThrow(expect.objectContaining({ status: 503 }));
  });

  it('不信任 X-Forwarded-For，只接受 socket 源 IP 白名单', () => {
    const service = authService({}, config({ CRM_A1_ALLOWED_IPS: '10.0.0.8' }));
    const request = requestLike({
      socketIp: '10.0.0.9',
      headers: { 'x-forwarded-for': '10.0.0.8' },
    });
    expect(() => service.validatePrelude(request, now)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('拒绝 query、超时时间戳与缺失幂等键', () => {
    const service = authService({}, config());
    expect(() => service.validatePrelude(requestLike({ originalUrl: '/api/crm/v1/contract-tasks?a=1' }), now))
      .toThrow(expect.objectContaining({ status: 400, response: expect.objectContaining({ code: 'UNSUPPORTED_QUERY' }) }));
    expect(() => service.validatePrelude(requestLike({ headers: { 'x-timestamp': String(now - 301) } }), now))
      .toThrow(expect.objectContaining({ status: 401, response: expect.objectContaining({ code: 'EXPIRED_TIMESTAMP' }) }));
    expect(() => service.validatePrelude(requestLike({ headers: { 'x-idempotency-key': '' } }), now))
      .toThrow(expect.objectContaining({ status: 400, response: expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }) }));
  });

  it('接受常见 Base64 nonce 和 CRM 自定义业务任务 ID', () => {
    const service = authService({}, config());
    const request = requestLike({
      headers: {
        'x-nonce': 'xYz+/=_:123',
        'x-idempotency-key': '审批任务/华东区 #10086',
      },
    });

    expect(service.validatePrelude(request, now)).toMatchObject({
      nonce: 'xYz+/=_:123',
      idempotencyKey: '审批任务/华东区 #10086',
    });
  });

  it('只在数据库唯一约束成功时占用 nonce，并将 P2002 映射为重放', async () => {
    const prisma = {
      crmInboundNonce: {
        deleteMany: vi.fn(),
        create: vi.fn().mockRejectedValue({ code: 'P2002' }),
      },
    };
    const service = authService(prisma, config());
    await expect(service.claimNonce(baseHeaders())).rejects.toMatchObject({
      status: 401,
      response: expect.objectContaining({ code: 'REPLAYED_NONCE' }),
    });
    expect(prisma.crmInboundNonce.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
  });

  it('时间窗左边界接收的 nonce 仍从接收时刻保留完整 300 秒', async () => {
    const acceptedAt = new Date(now * 1000 + 900);
    const headers = baseHeaders();
    headers.timestamp = now - 300;
    const prisma = {
      crmInboundNonce: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    const service = authService(prisma, config());

    await service.claimNonce(headers, acceptedAt);

    const expiresAt = prisma.crmInboundNonce.create.mock.calls[0][0].data.expiresAt as Date;
    expect(expiresAt.getTime()).toBe(acceptedAt.getTime() + 300_000);
  });

  it('过期 nonce 清理每进程最多每分钟执行一次', async () => {
    const prisma = {
      crmInboundNonce: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    const service = authService(prisma, config());
    const first = baseHeaders();
    const second = { ...baseHeaders(), nonce: 'nonce-second' };

    await service.claimNonce(first, new Date(now * 1000));
    await service.claimNonce(second, new Date(now * 1000 + 30_000));

    expect(prisma.crmInboundNonce.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.crmInboundNonce.create).toHaveBeenCalledTimes(2);
  });

  function baseHeaders(): CrmA1Headers {
    return {
      appId: 'crm-legal-01',
      timestamp: now,
      nonce: 'nonce-12345678',
      idempotencyKey: 'task-10086',
      payloadSha256: 'a'.repeat(64),
      fileManifestSha256: 'b'.repeat(64),
      signature: '0'.repeat(64),
    };
  }

  function envelope(overrides: Partial<CrmMultipartEnvelope> = {}): CrmMultipartEnvelope {
    return {
      payloadText: '{}',
      payloadSha256: 'a'.repeat(64),
      fileManifest: [],
      fileManifestSha256: 'b'.repeat(64),
      files: [],
      stagingDir: '/tmp/not-used',
      ...overrides,
    };
  }

  function config(overrides: Record<string, string> = {}) {
    const values: Record<string, string> = {
      CRM_A1_ENABLED: 'true',
      CRM_A1_APP_ID: 'crm-legal-01',
      CRM_A1_SECRET: secret,
      CRM_A1_ALLOWED_IPS: '127.0.0.1',
      ...overrides,
    };
    return { get: (key: string, fallback?: string) => values[key] ?? fallback };
  }

  function authService(prisma: any, configValue: any) {
    return new CrmA1AuthService(prisma, configValue);
  }

  function requestLike(options: {
    headers?: Record<string, string>;
    originalUrl?: string;
    socketIp?: string;
  } = {}): any {
    const headers: Record<string, string> = {
      'content-type': 'multipart/form-data; boundary=test',
      'x-app-id': 'crm-legal-01',
      'x-timestamp': String(now),
      'x-nonce': 'nonce-12345678',
      'x-idempotency-key': 'task-10086',
      'x-payload-sha256': 'a'.repeat(64),
      'x-file-manifest-sha256': 'b'.repeat(64),
      'x-signature': 'c'.repeat(64),
      ...options.headers,
    };
    return {
      headers,
      originalUrl: options.originalUrl ?? '/api/crm/v1/contract-tasks',
      socket: { remoteAddress: options.socketIp ?? '127.0.0.1' },
    };
  }
});
