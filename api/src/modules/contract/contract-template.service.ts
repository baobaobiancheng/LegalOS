import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    if (!template || !template.isActive) throw new NotFoundException('合同模板不存在或已停用');
    return template;
  }

  /** slug 来自启用的数据库模板，文件只允许位于部署方管理的模板目录。 */
  async readApprovedText(slug: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(slug)) {
      throw new ServiceUnavailableException('审定模板标识无效');
    }
    const root = process.env.CONTRACT_TEMPLATE_STORAGE_DIR
      || join(process.cwd(), 'storage', 'contract-templates');
    let content: string;
    try {
      content = await readFile(join(root, slug, `${slug}.md`), 'utf8');
    } catch {
      throw new ServiceUnavailableException('审定模板正文不可用，请联系管理员部署模板');
    }
    if (!content.trim() || content.length > 100_000) {
      throw new ServiceUnavailableException('审定模板正文为空或超出长度限制');
    }
    return content;
  }
}
