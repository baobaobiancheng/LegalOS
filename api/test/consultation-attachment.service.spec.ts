import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationAttachmentService } from '../src/common/services/consultation-attachment.service';
import { DocumentExtractionService } from '../src/common/services/document-extraction.service';

/**
 * 咨询附件（2026-08-12 review：DOCX 正文从未交给模型）：
 * - 上传：扩展名/大小/Word 签名/空正文校验；正文提取；返回 metadata
 * - 使用校验：归属、状态、过期
 * - 绑定到工单；getTexts 拼文件名前缀
 */

function makeFile(over: any = {}): Express.Multer.File {
  return {
    originalname: 'doc.docx', // ASCII 名（decodeFilename 对 ASCII 无损）
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 1000,
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
    ...over,
  } as Express.Multer.File;
}

describe('ConsultationAttachmentService', () => {
  let prisma: any;
  let extractor: any;
  let service: ConsultationAttachmentService;

  beforeEach(() => {
    prisma = {
      consultationAttachment: {
        create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    extractor = { extract: vi.fn() };
    service = new ConsultationAttachmentService(prisma as any, extractor as any);
    extractor.extract.mockResolvedValue({ text: '正文内容，这是从 docx 提取的法律答复。' });
    prisma.consultationAttachment.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'att-1', ...data }),
    );
  });

  it('中文文件名 UTF-8 还原（multer Latin-1 解释 bug）', async () => {
    // 浏览器以 UTF-8 发送「合同 附件.docx」，multer 按 latin1 解释 → 乱码；服务端需还原
    const mangled = Buffer.from('合同 附件.docx', 'utf8').toString('latin1');
    const meta = await service.upload(makeFile({ originalname: mangled }), 'u-1');
    expect(meta.name).toBe('合同 附件.docx');
    expect(prisma.consultationAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileName: '合同 附件.docx' }) }),
    );
  });

  it('上传成功：提取 + 落库 + 返回 metadata（不含正文）', async () => {
    const meta = await service.upload(makeFile(), 'u-1');

    expect(extractor.extract).toHaveBeenCalled();
    expect(prisma.consultationAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ creatorId: 'u-1', status: 'ready', extractedChars: expect.any(Number) }),
      }),
    );
    expect(meta).toMatchObject({ id: 'att-1', name: 'doc.docx', status: 'ready', extractedChars: expect.any(Number) });
    expect(meta).not.toHaveProperty('extractedText'); // 正文不回传前端
  });

  it('不支持扩展名拒绝', async () => {
    await expect(service.upload(makeFile({ originalname: '合同.pdf' }), 'u-1')).rejects.toMatchObject({
      response: { statusCode: 400 },
    });
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it('超过 10MB 拒绝', async () => {
    await expect(service.upload(makeFile({ size: 11 * 1024 * 1024 }), 'u-1')).rejects.toMatchObject({
      response: { statusCode: 413 },
    });
  });

  it('DOCX 签名校验失败拒绝（伪造扩展名）', async () => {
    await expect(
      service.upload(makeFile({ buffer: Buffer.from('not-a-zip-just-text') }), 'u-1'),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('支持旧版 DOC，并校验 OLE 文件签名', async () => {
    const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const docName = Buffer.from('合同.doc', 'utf8').toString('latin1');
    const meta = await service.upload(makeFile({
      originalname: docName,
      mimetype: 'application/msword',
      buffer: signature,
    }), 'u-1');

    expect(extractor.extract).toHaveBeenCalledWith(signature, '合同.doc');
    expect(meta).toMatchObject({ name: '合同.doc', status: 'ready' });

    await expect(service.upload(makeFile({
      originalname: '伪造.doc',
      mimetype: 'application/msword',
      buffer: Buffer.from('not-an-ole-document'),
    }), 'u-1')).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('空正文拒绝', async () => {
    extractor.extract.mockResolvedValue({ text: '' });
    await expect(service.upload(makeFile(), 'u-1')).rejects.toMatchObject({
      response: { statusCode: 400 },
    });
  });

  it('正文超长截断并给出 warning', async () => {
    extractor.extract.mockResolvedValue({
      text: 'x'.repeat(60_000),
      warning: '已提取旧版 Word 正文，图片、批注及修订痕迹未包含',
    });
    const meta = await service.upload(makeFile(), 'u-1');
    expect(meta.extractedChars).toBeLessThanOrEqual(50_000);
    expect(meta.warning).toContain('图片、批注及修订痕迹未包含');
    expect(meta.warning).toContain('截断');
  });

  it('使用校验：非本人附件 → Forbidden', async () => {
    prisma.consultationAttachment.findMany.mockResolvedValue([{ id: 'att-1', creatorId: 'u-other', status: 'ready', expiresAt: new Date(Date.now() + 1000) }]);
    await expect(service.validateForUser(['att-1'], 'u-1')).rejects.toMatchObject({ response: { statusCode: 403 } });
  });

  it('使用校验：未就绪/已过期 → BadRequest', async () => {
    prisma.consultationAttachment.findMany.mockResolvedValue([{ id: 'att-1', creatorId: 'u-1', status: 'failed', expiresAt: new Date(Date.now() + 1000) }]);
    await expect(service.validateForUser(['att-1'], 'u-1')).rejects.toMatchObject({ response: { statusCode: 400 } });
    prisma.consultationAttachment.findMany.mockResolvedValue([{ id: 'att-1', creatorId: 'u-1', status: 'ready', expiresAt: new Date(Date.now() - 1000) }]);
    await expect(service.validateForUser(['att-1'], 'u-1')).rejects.toMatchObject({ response: { statusCode: 400 } });
  });

  it('绑定到工单（仅未绑定的）', async () => {
    prisma.consultationAttachment.updateMany.mockResolvedValue({ count: 1 });
    await service.bind(['att-1'], 'p-1');
    expect(prisma.consultationAttachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: null, id: { in: ['att-1'] } }) }),
    );
  });

  it('getTexts：带文件名前缀拼正文', async () => {
    prisma.consultationAttachment.findMany.mockResolvedValue([
      { id: 'att-1', fileName: '答复.docx', extractedText: '法律答复正文' },
    ]);
    const texts = await service.getTexts(['att-1']);
    expect(texts[0]).toContain('【附件 答复.docx】');
    expect(texts[0]).toContain('法律答复正文');
  });
});

describe('DocumentExtractionService', () => {
  it('明显伪造或不完整的旧版 DOC 在进入解析器前被拒绝', async () => {
    const service = new DocumentExtractionService();
    const signatureOnly = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

    await expect(service.extract(signatureOnly, '材料.DOC')).rejects.toThrow('DOC 文件头不完整');
  });
});
