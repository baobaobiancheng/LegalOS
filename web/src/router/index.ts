import { createRouter, createWebHistory } from 'vue-router'
import { Role } from '../types'
import { registerGuards } from './guards'

const LEGAL_ROLES = [Role.LEGAL_BP, Role.LEGAL_LEAD]

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      meta: { public: true },
      component: () => import('../views/auth/LoginView.vue'),
    },
    {
      path: '/403',
      name: 'forbidden',
      component: () => import('../views/errors/403View.vue'),
    },

    // 法务端
    {
      path: '/legal/projects',
      name: 'legal-projects',
      meta: { roles: LEGAL_ROLES, title: '工单管理' },
      component: () => import('../views/legal/ProjectsView.vue'),
    },

    // 业务端
    {
      path: '/business/consult',
      name: 'business-consult',
      meta: { roles: [Role.BUSINESS], title: '法律咨询' },
      component: () => import('../views/business/ConsultView.vue'),
    },

    // 管理端
    {
      path: '/admin/dashboard',
      name: 'admin-dashboard',
      meta: { roles: [Role.ADMIN], title: '数据看板' },
      component: () => import('../views/admin/DashboardView.vue'),
    },

    { path: '/', redirect: '/login' },
    { path: '/:pathMatch(.*)*', redirect: '/login' },
  ],
})

registerGuards(router)

export default router
