import { Injectable, Logger } from '@nestjs/common';
import { CrmAdapter, CrmContext, CrmReviewResultDelivery } from './adapter.interfaces';

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

  async writeBack(delivery: CrmReviewResultDelivery): Promise<void> {
    // 未显式开启 Mock 时必须失败，避免真实 CRM 未配置却误标“已送达”。
    if (process.env.CRM_MOCK !== 'true' && process.env.NODE_ENV !== 'test') {
      throw new Error('CRM 真实回传适配器未配置（本地演示需显式设置 CRM_MOCK=true）');
    }
    this.logger.log(
      `[CRM Mock] 交付成功 — 任务 ${delivery.crmTaskId}，工单 ${delivery.projectId}，文件 ${delivery.file.originalName}`,
    );
  }
}
