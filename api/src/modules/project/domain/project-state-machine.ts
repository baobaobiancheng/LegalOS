import { ProjectStatus } from '@prisma/client';

/**
 * P2-01 唯一后端状态机：业务事件驱动的迁移矩阵。
 * 不允许绕过本矩阵直接赋值(PATCH 仅能映射到合法迁移;非法迁移返回 409)。
 *
 * 迁移矩阵：
 *   分析中 → 已回传(AI 成功) / 待处理(AI 失败) / 待复核(风险升级) / 已取消(按权限)
 *   待处理 → 待复核(人工升级) / 已回传(人工完成) / 已取消
 *   待复核 → 已回传(法务正式回传) / 已取消
 *   已回传 / 已取消 → 终态(无迁移;重开需显式授权用例,当前未启用)
 */
const ALLOWED: Record<ProjectStatus, ProjectStatus[]> = {
  分析中: ['已回传', '待处理', '待复核', '已取消'],
  待处理: ['待复核', '已回传', '已取消'],
  待复核: ['已回传', '已取消'],
  已回传: [],
  已取消: [],
};

export class ProjectStateMachine {
  /** 目标状态迁移是否合法;同状态视为合法(幂等 PATCH) */
  canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
    if (from === to) return true;
    return ALLOWED[from]?.includes(to) ?? false;
  }
}
