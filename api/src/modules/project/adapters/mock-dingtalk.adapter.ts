import { Injectable, Logger } from '@nestjs/common';
import { DingTalkAdapter, DingTalkGroup, ContactInfo } from './adapter.interfaces';

/**
 * 钉钉 Mock 适配器（无凭证本地开发 / fallback）。
 * 事件文案区分模拟/真实由调用方按 DINGTALK_MOCK 处理（工程评审决策 #17）。
 */
@Injectable()
export class MockDingTalkAdapter implements DingTalkAdapter {
  private readonly logger = new Logger(MockDingTalkAdapter.name);

  async createGroup(members: string[], projectTitle: string, ownerUserId?: string): Promise<DingTalkGroup> {
    const chatId = `DING-MOCK-${Date.now()}`;
    this.logger.log(`[DingTalk Mock] 拉群成功 — ${chatId}，标题："${projectTitle}"，群主：${ownerUserId || members[0]}，成员：${members.join(', ')}`);
    return { chatId, title: projectTitle, members };
  }

  async addMember(chatId: string, userId: string): Promise<void> {
    this.logger.log(`[DingTalk Mock] 加人成功 — ${chatId} + ${userId}`);
  }

  async sendNotification(chatId: string, message: string): Promise<void> {
    this.logger.log(`[DingTalk Mock] 通知已发送 — ${chatId}：${message}`);
  }

  async syncContacts(): Promise<ContactInfo[]> {
    this.logger.log('[DingTalk Mock] 通讯录同步（返回空快照）');
    return [];
  }
}
