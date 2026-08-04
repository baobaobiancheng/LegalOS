import { Injectable, Logger } from '@nestjs/common';
import { CrmAdapter, CrmContext } from './adapter.interfaces';

@Injectable()
export class MockCrmAdapter implements CrmAdapter {
  private readonly logger = new Logger(MockCrmAdapter.name);

  async getContext(_customerId: string, _params?: Record<string, string>): Promise<CrmContext> {
    return {
      customer: '演示客户 · 华北IU',
      reference: `CRM-DEMO-${Date.now()}`,
      opportunity: 'OPP-2026-0042',
      businessType: '合同审批',
    };
  }

  async writeBack(projectId: string, result: string): Promise<void> {
    this.logger.log(`[CRM Mock] 回写成功 — 工单 ${projectId}，结果：${result.slice(0, 50)}...`);
  }
}
