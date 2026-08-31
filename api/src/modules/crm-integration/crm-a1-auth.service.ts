import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { crmA1Error } from './crm-a1.errors';
import { CRM_A1_PATH, CrmA1Headers, CrmMultipartEnvelope } from './crm-a1.types';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const VISIBLE_ASCII = /^[\x21-\x7e]{1,128}$/;
const BUSINESS_ID = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const TIMESTAMP_WINDOW_SECONDS = 300;
const NONCE_CLEANUP_INTERVAL_MS = 60_000;

@Injectable()
export class CrmA1AuthService {
  private nextNonceCleanupAt = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  validatePrelude(request: Request, nowSeconds = Math.floor(Date.now() / 1000)): CrmA1Headers {
    if (String(this.config.get('CRM_A1_ENABLED', 'false')).toLowerCase() !== 'true') {
      throw crmA1Error(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'CRM A1 入站服务未启用');
    }
    if (request.originalUrl.includes('?')) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'UNSUPPORTED_QUERY', 'A1 一期不允许 query 参数');
    }
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !/^multipart\/form-data\s*;/i.test(contentType)) {
      throw crmA1Error(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必须是 multipart/form-data');
    }
    const contentLength = request.headers['content-length'];
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength)
      && Number(contentLength) > 100 * 1024 * 1024) {
      throw crmA1Error(HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE', '请求总大小超过 100MB');
    }

    const appId = this.header(request, 'x-app-id');
    const configuredAppId = String(this.config.get('CRM_A1_APP_ID', ''));
    if (!appId || !configuredAppId || appId !== configuredAppId) {
      throw crmA1Error(HttpStatus.FORBIDDEN, 'FORBIDDEN_APP', 'AppId 无权调用 A1');
    }
    this.assertAllowedIp(request);

    const timestampText = this.header(request, 'x-timestamp');
    if (!timestampText || !/^\d{10}$/.test(timestampText)) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'X-Timestamp 必须是 Unix Epoch 秒');
    }
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TIMESTAMP_WINDOW_SECONDS) {
      throw crmA1Error(HttpStatus.UNAUTHORIZED, 'EXPIRED_TIMESTAMP', 'X-Timestamp 已超出 ±300 秒时间窗口');
    }

    const nonce = this.header(request, 'x-nonce');
    if (!nonce || !VISIBLE_ASCII.test(nonce)) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'X-Nonce 缺失或格式非法');
    }
    const idempotencyKey = this.header(request, 'x-idempotency-key');
    if (!idempotencyKey) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 X-Idempotency-Key');
    }
    if (!BUSINESS_ID.test(idempotencyKey)) {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'X-Idempotency-Key 格式非法');
    }

    const payloadSha256 = this.header(request, 'x-payload-sha256');
    const fileManifestSha256 = this.header(request, 'x-file-manifest-sha256');
    const signature = this.header(request, 'x-signature');
    if (!payloadSha256 || !fileManifestSha256 || !signature
      || !SHA256_HEX.test(payloadSha256)
      || !SHA256_HEX.test(fileManifestSha256)
      || !SHA256_HEX.test(signature)) {
      throw crmA1Error(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', '签名头缺失或格式非法');
    }
    return {
      appId,
      timestamp,
      nonce,
      idempotencyKey,
      payloadSha256,
      fileManifestSha256,
      signature,
    };
  }

  /** 只使用已签名请求头验证调用方，必须在读取大文件请求体前执行。 */
  verifySignature(headers: CrmA1Headers): void {
    const secret = String(this.config.get('CRM_A1_SECRET', ''));
    if (!isCrmA1SecretStrong(secret)) {
      throw crmA1Error(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'CRM A1 验签配置不完整');
    }
    const message = buildCrmA1SignatureMessage(headers);
    const expected = createHmac('sha256', secret).update(message, 'utf8').digest('hex');
    const signatureMatches = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(headers.signature, 'hex'));
    if (!signatureMatches) {
      throw crmA1Error(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', '请求签名校验失败');
    }
  }

  /** 请求体解析后再核对实际 payload/文件清单摘要，防止头部摘要与上传内容脱节。 */
  verifyContentDigests(headers: CrmA1Headers, envelope: CrmMultipartEnvelope): void {
    const contentMatches = headers.payloadSha256 === envelope.payloadSha256
      && headers.fileManifestSha256 === envelope.fileManifestSha256;
    if (!contentMatches) {
      throw crmA1Error(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', '请求签名校验失败');
    }
  }

  async claimNonce(headers: CrmA1Headers, now = new Date()): Promise<void> {
    // 过期记录低频顺带清理，请求热路径的核心操作只是唯一键 insert。
    // 先推进时间门，避免同一进程并发请求重复触发 deleteMany。
    if (now.getTime() >= this.nextNonceCleanupAt) {
      this.nextNonceCleanupAt = now.getTime() + NONCE_CLEANUP_INTERVAL_MS;
      await this.prisma.crmInboundNonce.deleteMany({ where: { expiresAt: { lt: now } } });
    }
    // 请求在时间窗左边界被接收时，timestamp + window 可能已经早于当前毫秒时间。
    // nonce 至少从成功接收起再保留一个完整窗口；未来时间戳则保留到其签名窗口结束。
    const expiresAt = new Date(Math.max(
      now.getTime() + TIMESTAMP_WINDOW_SECONDS * 1000,
      (headers.timestamp + TIMESTAMP_WINDOW_SECONDS) * 1000,
    ));
    try {
      await this.prisma.crmInboundNonce.create({
        data: {
          appId: headers.appId,
          nonce: headers.nonce,
          requestTimestamp: new Date(headers.timestamp * 1000),
          expiresAt,
        },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw crmA1Error(HttpStatus.UNAUTHORIZED, 'REPLAYED_NONCE', 'X-Nonce 已使用');
      }
      throw error;
    }
  }

  private assertAllowedIp(request: Request): void {
    const allowed = String(this.config.get('CRM_A1_ALLOWED_IPS', ''))
      .split(',')
      .map((value) => normalizeIp(value.trim()))
      .filter(Boolean);
    if (!allowed.length) return;
    const remoteIp = normalizeIp(request.socket.remoteAddress ?? '');
    if (!remoteIp || !allowed.includes(remoteIp)) {
      throw crmA1Error(HttpStatus.FORBIDDEN, 'FORBIDDEN_APP', '请求来源 IP 不在白名单');
    }
  }

  private header(request: Request, name: string): string | null {
    const value = request.headers[name];
    return typeof value === 'string' ? value.trim() : null;
  }
}

export function buildCrmA1SignatureMessage(headers: CrmA1Headers): string {
  return [
    'v1',
    'POST',
    CRM_A1_PATH,
    headers.appId,
    String(headers.timestamp),
    headers.nonce,
    headers.idempotencyKey,
    headers.payloadSha256,
    headers.fileManifestSha256,
  ].join('\n');
}

export function isCrmA1SecretStrong(secret: string): boolean {
  return Buffer.byteLength(secret, 'utf8') >= 32;
}

function normalizeIp(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}
