import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ContractTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  /** 可用模板列表（前端展示 + 动态表单 + 导出样式；不暴露 prompt 字段） */
  async list() {
    return this.prisma.contractTemplate.findMany({
      where: { isActive: true },
      select: {
        slug: true,
        name: true,
        category: true,
        description: true,
        style: true,
        elementsSchema: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findBySlug(slug: string) {
    const template = await this.prisma.contractTemplate.findUnique({
      where: { slug },
    });
    if (!template) throw new NotFoundException('合同模板不存在');
    return template;
  }
}
