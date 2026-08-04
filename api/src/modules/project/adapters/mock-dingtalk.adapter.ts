import { Injectable, Logger } from '@nestjs/common';
import { DingTalkAdapter, DingTalkGroup } from './adapter.interfaces';

@Injectable()
export class MockDingTalkAdapter implements DingTalkAdapter {
  private readonly logger = new Logger(MockDingTalkAdapter.name);

  async createGroup(members: string[], projectTitle: string): Promise<DingTalkGroup> {
    const chatId = `DING-MOCK-${Date.now()}`;
    this.logger.log(`[DingTalk Mock] 拉群成功 — ${chatId}，标题："${projectTitle}"，成员：${members.join(', ')}`);
    return { chatId, title: projectTitle, members };
  }

  async sendNotification(chatId: string, message: string): Promise<void> {
    this.logger.log(`[DingTalk Mock] 通知已发送 — ${chatId}：${message}`);
  }
}
