<template>
  <div class="error-scene">
    <div class="aurora"><div class="orb orb-1" /><div class="orb orb-2" /></div>
    <div class="error-card glass-card animate-in">
      <div class="error-icon">🔒</div>
      <h1 class="text-h1">403</h1>
      <p class="text-body">当前角色无权访问该资源</p>
      <button class="btn-primary" @click="router.replace(home)" style="margin-top:20px">返回首页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { HOME_BY_ROLE, type Role } from '../../types'
const router = useRouter()
const home = HOME_BY_ROLE[useAuthStore().currentRole as Role] || '/login'
</script>

<script lang="ts">export default { name: 'ForbiddenView' }</script>

<style scoped>
.error-scene {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  position: relative; overflow: hidden; background: #F5F5F7;
}
.error-card {
  position: relative; z-index: 1;
  width: 400px; padding: 52px 40px; text-align: center;
}
.error-icon {
  width: 64px; height: 64px; margin: 0 auto 20px;
  border-radius: 20px; background: linear-gradient(135deg, rgba(255,149,0,0.12), rgba(255,204,0,0.10));
  display: grid; place-items: center; font-size: 30px;
}
</style>
