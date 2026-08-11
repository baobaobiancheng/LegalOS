/**
 * CAS 适配器（T2，2026-08-10 CAS 统一登录）：
 * - 真实现按源码确认协议：GET {CAS_HOST}/validate?ticket=，返回 CasAuthResult（无 service 参数）
 * - 真实响应字段名混用：deptName/projectCode 为 camelCase，user_id/role_code 等为 snake_case
 * - mock 供测试与本地 CAS_BYPASS（生产禁止）
 */
export interface CasUserInfo {
  /** 员工 CAS 账号（身份键，落 User.casUsername） */
  username: string;
  /** 真实姓名 */
  name: string;
  email?: string;
  deptName?: string;
  projectCode?: string;
  /** CAS 访问级角色（不信任为领域角色，设计 P2） */
  roleCode?: string;
}

export enum CasAuthErrorType {
  /** ticket 无效/过期/被消费 */
  INVALID_TICKET = 'INVALID_TICKET',
  /** 账号或密码错误 / 未开通项目权限（方式一 /api/login 返回非 200 或无 ticket） */
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  /** CAS 不可达/超时/非 JSON */
  CAS_UNAVAILABLE = 'CAS_UNAVAILABLE',
}

export class CasAuthError extends Error {
  constructor(
    readonly type: CasAuthErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'CasAuthError';
  }
}

export interface CasAdapter {
  /** 校验 ticket 换取用户信息；失败抛 CasAuthError（调用方据此映射 401/503） */
  validateTicket(ticket: string): Promise<CasUserInfo>;
  /**
   * 登录页账号密码登录（方式一）：POST /api/login 换 ticket → validate 换用户信息。
   * 失败抛 CasAuthError：账号密码错/无权限 → INVALID_CREDENTIALS；CAS 不可达 → CAS_UNAVAILABLE
   */
  loginWithPassword(username: string, password: string): Promise<CasUserInfo>;
}

export const CAS_ADAPTER = 'CAS_ADAPTER';
