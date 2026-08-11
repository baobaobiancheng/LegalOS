import { Injectable } from '@nestjs/common';
import { CasAdapter, CasAuthError, CasAuthErrorType, CasUserInfo } from './cas-adapter.interface';

/**
 * Mock CAS 适配器（T2）：本地 CAS_BYPASS 用，不碰真实 CAS。
 * 只允许非生产环境启用（fail-fast 在生产硬拒，见 main.ts / adapter module）。
 * ticket 长度 <8 视为无效，方便测试无效/过期路径。
 */
@Injectable()
export class MockCasAdapter implements CasAdapter {
  async validateTicket(ticket: string): Promise<CasUserInfo> {
    if (!ticket || ticket.length < 8) {
      throw new CasAuthError(CasAuthErrorType.INVALID_TICKET, 'mock ticket 无效');
    }
    return {
      username: 'mock.cas.user',
      name: 'Mock CAS 用户',
      email: 'mock.cas.user@brgroup.com',
      deptName: '研发部',
      projectCode: 'legalos',
      roleCode: 'common',
    };
  }

  /** mock 账号密码登录：空密码视为无效,否则返回固定用户（本地联调） */
  async loginWithPassword(username: string, password: string): Promise<CasUserInfo> {
    if (!username || !password) {
      throw new CasAuthError(CasAuthErrorType.INVALID_CREDENTIALS, 'mock 账号或密码错误');
    }
    return {
      username,
      name: `Mock ${username}`,
      email: `${username}@brgroup.com`,
      deptName: '研发部',
      projectCode: 'legalos',
      roleCode: 'common',
    };
  }
}
