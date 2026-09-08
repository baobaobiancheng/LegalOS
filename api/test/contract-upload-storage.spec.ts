import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';
import { EventEmitter } from 'node:events';
import { ContractFileService } from '../src/modules/contract/contract-file.service';
import { ProjectAccessPolicy } from '../src/modules/project/domain/project-access.policy';
import { ContractDocumentWriter } from '../src/modules/contract/application/contract-document.writer';
import {
  ContractFileProcessor,
  DOCX_MAX_ENTRIES,
} from '../src/modules/contract/application/contract-file.processor';

describe('ContractFileService.uploadFile staging 与文件签名', () => {
  let root: string;
  let prisma: any;
  let service: ContractFileService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legalos-upload-'));
    process.env.CONTRACT_STORAGE_DIR = root;
    prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({
        id: 'project-1', creatorId: 'business-1', ownerId: 'bp-1', legalBpId: 'bp-1', status: '待复核',
      }) },
      contractFile: { create: vi.fn().mockResolvedValue({ id: 'file-1' }) },
      projectMessage: { create: vi.fn() },
      projectEvent: { create: vi.fn() },
      contractDocument: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    };
    service = new ContractFileService(
      prisma as any,
      new ProjectAccessPolicy() as any,
      new ContractDocumentWriter(),
      new ContractFileProcessor(),
    );
  });

  afterEach(() => {
    delete process.env.CONTRACT_STORAGE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('拒绝伪装成 PDF 的内容，并清理 staging 文件', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'fake.pdf');
    mkdirForTest(staging);
    writeFileSync(path, '这不是 PDF');

    await expect(service.uploadFile(
      'project-1',
      file(path, 'fake.pdf', '.pdf'),
      'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ error: '文件内容与扩展名不匹配' }),
    });

    expect(readExists(path)).toBe(false);
    expect(prisma.contractFile.create).not.toHaveBeenCalled();
  });

  it('首次查库故障也会清理 staging，不留下原文件', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'db-unavailable.txt');
    mkdirForTest(staging);
    writeFileSync(path, '合同原文');
    prisma.project.findUnique.mockRejectedValue(new Error('database unavailable'));

    await expect(service.uploadFile(
      'project-1', file(path, 'db-unavailable.txt', '.txt'), 'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toThrow('database unavailable');

    expect(readExists(path)).toBe(false);
  });

  it('TXT 签名与正文解析通过后，原子写入文件元数据和可审查文档', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'notes.txt');
    mkdirForTest(staging);
    writeFileSync(path, '合同备注');

    const result = await service.uploadFile(
      'project-1',
      file(path, 'notes.txt', '.txt'),
      'final',
      { id: 'business-1', role: 'business' },
    );

    expect(readExists(path)).toBe(false);
    expect(readFileSync(join(root, 'project-1', 'notes.txt'), 'utf8')).toBe('合同备注');
    expect(statSync(join(root, 'project-1')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'project-1', 'notes.txt')).mode & 0o777).toBe(0o600);
    expect(prisma.contractFile.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ projectId: 'project-1', storedName: 'notes.txt' }),
    }));
    expect(prisma.contractDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '合同备注', sourceFileId: 'file-1' }),
    }));
    expect(result).toMatchObject({ textExtracted: true, extractedChars: 4 });
  });

  it('Markdown 正文会写入 ContractDocument', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'contract.md');
    mkdirForTest(staging);
    writeFileSync(path, '# 合同\n\n付款条款');

    await service.uploadFile(
      'project-1',
      file(path, 'contract.md', '.md'),
      'revised',
      { id: 'business-1', role: 'business' },
    );

    expect(prisma.contractDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: '# 合同\n\n付款条款', documentType: 'revised' }),
    }));
  });

  it('事件与文件元数据同交易，交易失败时删除已移动的正式文件', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'rollback.txt');
    mkdirForTest(staging);
    writeFileSync(path, '合同原文');
    prisma.projectEvent.create.mockRejectedValue(new Error('event insert failed'));

    await expect(service.uploadFile(
      'project-1', file(path, 'rollback.txt', '.txt'), 'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toMatchObject({ status: 500 });

    expect(prisma.projectEvent.create).toHaveBeenCalled();
    expect(readExists(path)).toBe(false);
    expect(readExists(join(root, 'project-1', 'rollback.txt'))).toBe(false);
  });

  it('PDF 文字会抽取并写入 ContractDocument', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'contract.pdf');
    mkdirForTest(staging);
    writeFileSync(path, minimalTextPdf('Payment terms'));

    const result = await service.uploadFile(
      'project-1',
      file(path, 'contract.pdf', '.pdf'),
      'final',
      { id: 'business-1', role: 'business' },
    );

    expect(prisma.contractDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: expect.stringContaining('Payment terms') }),
    }));
    expect(result.textExtracted).toBe(true);
  });

  it('损坏 DOCX 解析失败时返回 422 并清理 staging，不落库', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'broken.docx');
    mkdirForTest(staging);
    writeFileSync(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));

    await expect(service.uploadFile(
      'project-1',
      file(path, 'broken.docx', '.docx'),
      'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toMatchObject({ status: 422 });

    expect(readExists(path)).toBe(false);
    expect(prisma.contractFile.create).not.toHaveBeenCalled();
  });

  it('DOCX 内部文件数超过安全上限时在正文解析前拒绝并清理 staging', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'archive-bomb.docx');
    mkdirForTest(staging);
    const archive = new JSZip();
    for (let index = 0; index <= DOCX_MAX_ENTRIES; index += 1) {
      archive.file(`word/item-${index}.xml`, '<x/>');
    }
    writeFileSync(path, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

    await expect(service.uploadFile(
      'project-1',
      file(path, 'archive-bomb.docx', '.docx'),
      'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ error: expect.stringContaining('内部文件数') }),
    });

    expect(readExists(path)).toBe(false);
    expect(prisma.contractFile.create).not.toHaveBeenCalled();
  });

  it.each(['STORE', 'DEFLATE'] as const)('有效 DOCX（%s）经流式解压限额检查后可正常提取', async (compression) => {
    const staging = join(root, '.staging');
    const path = join(staging, `valid-${compression}.docx`);
    mkdirForTest(staging);
    writeFileSync(path, await minimalDocx('合同付款条款', compression));

    const result = await service.uploadFile(
      'project-1',
      file(path, `valid-${compression}.docx`, '.docx'),
      'final',
      { id: 'business-1', role: 'business' },
    );

    expect(result).toMatchObject({ textExtracted: true });
    expect(prisma.contractDocument.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: expect.stringContaining('合同付款条款') }),
    }));
  });

  it('非 UTF-8 文本拒绝上传，避免静默替换字符损坏合同内容', async () => {
    const staging = join(root, '.staging');
    const path = join(staging, 'invalid.txt');
    mkdirForTest(staging);
    writeFileSync(path, Buffer.from([0xc3, 0x28]));

    await expect(service.uploadFile(
      'project-1',
      file(path, 'invalid.txt', '.txt'),
      'final',
      { id: 'business-1', role: 'business' },
    )).rejects.toMatchObject({ status: 422 });

    expect(prisma.contractFile.create).not.toHaveBeenCalled();
  });
});

describe('ContractFileProcessor worker 生命周期', () => {
  it('exit(0) 未发 message 也会失败，且确认 terminate 后才把并发 slot 交给下一任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legalos-worker-'));
    const path = join(root, 'input.txt');
    writeFileSync(path, '合同正文');
    let releaseTerminate!: () => void;
    const firstTerminated = new Promise<void>((resolve) => { releaseTerminate = resolve; });
    let created = 0;
    let firstWorker: EventEmitter | undefined;
    class FakeProcessor extends ContractFileProcessor {
      protected shouldUseWorker() { return true; }
      protected createWorker() {
        created += 1;
        const worker: any = new EventEmitter();
        if (created === 1) firstWorker = worker;
        worker.terminate = vi.fn(() => created === 1 ? firstTerminated.then(() => 1) : Promise.resolve(1));
        queueMicrotask(() => {
          if (created === 1) worker.emit('exit', 0);
          else worker.emit('message', { ok: true, result: { ext: '.txt', text: '合同正文' } });
        });
        return worker;
      }
    }
    const previous = process.env.CONTRACT_FILE_PARSE_CONCURRENCY;
    process.env.CONTRACT_FILE_PARSE_CONCURRENCY = '1';
    const processor = new FakeProcessor();
    const first = processor.validateAndExtract(path, 'input.txt');
    const second = processor.validateAndExtract(path, 'input.txt');
    await new Promise((resolve) => setImmediate(resolve));
    expect(created).toBe(1);
    // terminate 尚未完成时的 worker error 必须仍有 listener，不能变成未捕获异常。
    firstWorker!.emit('error', new Error('error during terminate'));
    releaseTerminate();
    await expect(first).rejects.toThrow('未返回结果');
    await expect(second).resolves.toMatchObject({ text: '合同正文' });
    if (previous === undefined) delete process.env.CONTRACT_FILE_PARSE_CONCURRENCY;
    else process.env.CONTRACT_FILE_PARSE_CONCURRENCY = previous;
    rmSync(root, { recursive: true, force: true });
  });
});

function mkdirForTest(path: string) {
  mkdirSync(path, { recursive: true });
}

function minimalTextPdf(text: string): Buffer {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${text}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function minimalDocx(text: string, compression: 'STORE' | 'DEFLATE'): Promise<Buffer> {
  const archive = new JSZip();
  archive.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  archive.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  archive.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return archive.generateAsync({ type: 'nodebuffer', compression });
}

function readExists(path: string) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function file(path: string, originalname: string, ext: string): Express.Multer.File {
  return {
    path,
    filename: originalname,
    originalname,
    mimetype: ext === '.txt' ? 'text/plain' : 'application/octet-stream',
    size: 16,
    destination: join(path, '..'),
    fieldname: 'file',
    encoding: '7bit',
    stream: undefined as any,
    buffer: undefined as any,
  };
}
