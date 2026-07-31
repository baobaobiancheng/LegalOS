<template>
  <div class="login-scene">
    <div class="aurora">
      <div class="orb orb-1" />
      <div class="orb orb-2" />
      <div class="orb orb-3" />
    </div>

    <div class="login-card glass-card animate-in">
      <div class="login-icon">⚖</div>
      <h1>法务 AI 平台</h1>
      <p class="subtitle">Legal Workbench · 统一入口</p>

      <form @submit.prevent="handleLogin" class="login-form">
        <div class="field">
          <label>用户名</label>
          <input v-model="form.username" class="input-apple" placeholder="请输入用户名" maxlength="64" autocomplete="username" />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="form.password" class="input-apple" type="password" placeholder="请输入密码" maxlength="128" autocomplete="current-password" />
        </div>

        <transition name="fade">
          <div v-if="errorMsg" class="error-banner">
            <span>{{ errorMsg }}</span>
          </div>
        </transition>

        <button type="submit" class="btn-primary login-btn" :disabled="loading">
          <span v-if="loading" class="spinner" />
          {{ loading ? '验证中…' : '登录' }}
        </button>
      </form>

      <p class="footer-note">种子用户 · 内网部署</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { RequestError } from '../../api/client'
import { HOME_BY_ROLE, type Role } from '../../types'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const form = reactive({ username: '', password: '' })
const loading = ref(false)
const errorMsg = ref('')

const validate = () => {
  if (!form.username.trim()) { errorMsg.value = '请输入用户名'; return false }
  if (!form.password.trim()) { errorMsg.value = '请输入密码'; return false }
  return true
}

async function handleLogin() {
  if (!validate()) return
  loading.value = true
  errorMsg.value = ''
  try {
    const user = await auth.login(form.username, form.password)
    const redirect = (route.query.redirect as string) || HOME_BY_ROLE[user.role as Role]
    await router.replace(redirect)
  } catch (error) {
    if (error instanceof RequestError) errorMsg.value = error.payload.error
    else errorMsg.value = '登录失败，请稍后再试'
  } finally {
    loading.value = false
  }
}
</script>

<script lang="ts">export default { name: 'LoginView' }</script>

<style scoped>
.login-scene {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  position: relative; overflow: hidden;
  background: #F5F5F7;
}

.login-card {
  position: relative; z-index: 1;
  width: 420px; padding: 48px 40px 36px;
  text-align: center;
}

.login-icon {
  width: 56px; height: 56px; margin: 0 auto 20px;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(0,113,227,0.12), rgba(162,210,255,0.18));
  display: grid; place-items: center; font-size: 28px;
}

h1 {
  margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em;
  color: #1d1d1f;
}
.subtitle {
  margin: 6px 0 32px; font-size: 14px; font-weight: 400;
  color: #86868b; letter-spacing: -0.01em;
}

.login-form { text-align: left; }

.field { margin-bottom: 20px; }
.field label {
  display: block; margin-bottom: 6px;
  font-size: 13px; font-weight: 590; color: #1d1d1f; letter-spacing: -0.01em;
}

.login-btn {
  width: 100%; margin-top: 8px; height: 46px; font-size: 16px;
}

.error-banner {
  margin-bottom: 16px; padding: 11px 14px;
  border-radius: 14px;
  background: rgba(255,59,48,0.08); color: #FF3B30;
  font-size: 13px; font-weight: 500; letter-spacing: -0.01em;
}

.footer-note {
  margin: 24px 0 0;
  font-size: 11px; color: #aeaeb2; letter-spacing: 0.01em;
}

.spinner {
  width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff; border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.fade-enter-active { transition: opacity 0.35s ease; }
.fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
