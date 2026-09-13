import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type WritableContractDocumentType = 'draft' | 'revised' | 'final' | 'source';

/**
 * ContractDocument 的共享事务写入器。
 * 合同生成和文件上传都会产生文档版本，该能力不属于文件系统。
 */
@Injectable()
export class ContractDocumentWriter {
  async create(
    tx: Prisma.TransactionClient,
    data: {
      projectId: string;
      documentType: WritableContractDocumentType;
      content: string;
      sourceFileId?: string | null;
      createdBy?: string | null;
    },
  ): Promise<any> {
    // 父行锁序列化同项目写入；版本使用当前读，不复用 REPEATABLE READ 的旧快照。
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${data.projectId} FOR UPDATE`;
    const latest = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM contract_documents WHERE project_id = ${data.projectId}
      ORDER BY version DESC LIMIT 1 FOR UPDATE
    `;
    const version = (latest[0]?.version ?? 0) + 1;
    return tx.contractDocument.create({ data: { ...data, version } });
  }
}
