import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type WritableContractDocumentType = 'draft' | 'revised' | 'final';

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
    attempts = 0,
  ): Promise<any> {
    const count = await tx.contractDocument.count({ where: { projectId: data.projectId } });
    const version = count + 1;
    try {
      return await tx.contractDocument.create({ data: { ...data, version } });
    } catch (error: any) {
      if (error?.code === 'P2002' && attempts < 5) {
        return this.create(tx, data, attempts + 1);
      }
      throw error;
    }
  }
}
