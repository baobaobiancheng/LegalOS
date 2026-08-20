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
      component: () => import('../views/errors/ForbiddenView.vue'),
    },

    // 法务端
    {
      path: '/legal/projects',
      name: 'legal-projects',
      meta: { roles: LEGAL_ROLES, title: '工单管理' },
      component: () => import('../views/legal/ProjectsView.vue'),
    },
    {
      path: '/legal/projects/:id',
      name: 'legal-project-detail',
      meta: { roles: LEGAL_ROLES, title: '工单详情' },
      component: () => import('../views/legal/ProjectDetailView.vue'),
    },
    {
      path: '/legal/research',
      name: 'legal-research',
      meta: { roles: [...LEGAL_ROLES, Role.ADMIN], title: '法律检索' },
      component: () => import('../views/legal/LegalResearchView.vue'),
    },
    {
      path: '/legal/skills',
      name: 'legal-skills',
      meta: { roles: [...LEGAL_ROLES, Role.ADMIN], title: '技能库' },
      component: () => import('../views/legal/SkillsView.vue'),
    },

    // 业务端
    {
      path: '/business/consult',
      name: 'business-consult',
      meta: { roles: [Role.BUSINESS], title: '法律咨询' },
      component: () => import('../views/business/ConsultView.vue'),
    },
    {
      path: '/business/contract',
      name: 'business-contract',
      meta: { roles: [Role.BUSINESS], title: '合同助手' },
      component: () => import('../views/business/ContractView.vue'),
    },
    {
      path: '/business/records',
      name: 'business-records',
      meta: { roles: [Role.BUSINESS], title: '我的记录' },
      component: () => import('../views/business/RecordsView.vue'),
    },
    {
      path: '/business/records/:id',
      name: 'business-record-detail',
      meta: { roles: [Role.BUSINESS], title: '咨询详情' },
      component: () => import('../views/business/RecordDetailView.vue'),
    },

    // 管理端
    {
      path: '/admin/dashboard',
      name: 'admin-dashboard',
      meta: { roles: [Role.ADMIN], title: '数据看板' },
      component: () => import('../views/admin/DashboardView.vue'),
    },
    {
      path: '/admin/members',
      name: 'admin-members',
      meta: { roles: [Role.ADMIN], title: '成员管理' },
      component: () => import('../views/admin/MembersView.vue'),
    },

    { path: '/', redirect: '/login' },
    { path: '/:pathMatch(.*)*', redirect: '/login' },
  ],
})

registerGuards(router)

export default router
