import type { Router } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { HOME_BY_ROLE, type Role } from '../types'

/**
 * 路由守卫（设计文档「路由守卫流程」）
 *   无 user → fetchMe（内含 refresh 兜底）→ 成功按 role 跳转 / 失败去 /login
 *   有 user → 校验 role 是否有权访问目标路由 → 无权则 403
 */
export function registerGuards(router: Router) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore()

    // CAS 回调：/login?ticket=xxx —— 先兑换 ticket,不能被旧会话 fetchMe 跳走（codex #7）
    const hasCasTicket =
      to.name === 'login' && typeof to.query.ticket === 'string' && Boolean(to.query.ticket)
    if (hasCasTicket) return true

    if (!auth.resolved) await auth.fetchMe()

    if (to.meta.public) {
      // 已登录用户访问登录页时直接回到自己的首页
      return auth.isLoggedIn && to.name === 'login'
        ? HOME_BY_ROLE[auth.currentRole as Role]
        : true
    }

    if (!auth.isLoggedIn) {
      return { name: 'login', query: { redirect: to.fullPath } }
    }

    const allowed = to.meta.roles as Role[] | undefined
    if (allowed?.length && !allowed.includes(auth.currentRole as Role)) {
      return { name: 'forbidden' }
    }

    return true
  })
}
