<template>
  <div class="login-scene">
    <div class="aurora">
      <div class="orb orb-1" />
      <div class="orb orb-2" />
      <div class="orb orb-3" />
    </div>

    <div class="login-shell animate-in">
      <!-- 左栏：品牌展示 -->
      <div class="brand-panel">
        <div class="brand-top">
          <div class="brand-mark">
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            ><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /></svg>
          </div>
          <span class="brand-name">Legal Workbench</span>
        </div>

        <div class="brand-body">
          <h1>企业法务<br>智能协同工作台</h1>
          <p class="brand-sub">
            统一入口 · 三端协作 · AI 原生驱动
          </p>

          <div class="brand-features">
            <div class="bf-item">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              ><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
              <div><strong>AI 即时答复</strong><small>常规咨询 1 分钟内返回</small></div>
            </div>
            <div class="bf-item">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              ><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
              <div><strong>风险智能分级</strong><small>P0/P1/P2 自动路由</small></div>
            </div>
            <div class="bf-item">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,0.9)"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              ><circle
                cx="12"
                cy="8"
                r="4"
              /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
              <div><strong>专家全程兜底</strong><small>高风险事项升级人工</small></div>
            </div>
          </div>
        </div>

        <div class="brand-footer">
          <span>© 2026 Legal Workbench · 法务智能平台</span>
        </div>
      </div>

      <!-- 右栏：登录卡 -->
      <div class="login-panel">
        <div class="login-card glass-card">
          <div class="login-head">
            <h2>欢迎回来</h2>
            <p>登录您的法务工作空间</p>
          </div>

          <form
            class="login-form"
            @submit.prevent="handleLogin"
          >
            <div class="field">
              <label>用户名</label>
              <input
                v-model="form.username"
                class="input-apple"
                placeholder="请输入用户名"
                maxlength="64"
                autocomplete="username"
              >
            </div>
            <div class="field">
              <label>密码</label>
              <input
                v-model="form.password"
                class="input-apple"
                type="password"
                placeholder="请输入密码"
                maxlength="128"
                autocomplete="current-password"
              >
            </div>

            <transition name="fade">
              <div
                v-if="errorMsg"
                class="error-banner"
                role="alert"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                ><circle
                  cx="12"
                  cy="12"
                  r="9"
                /><line
                  x1="12"
                  y1="8"
                  x2="12"
                  y2="12"
                /><line
                  x1="12"
                  y1="16"
                  x2="12.01"
                  y2="16"
                /></svg>
                <span>{{ errorMsg }}</span>
              </div>
            </transition>

            <button
              type="submit"
              class="btn-primary login-btn"
              :disabled="loading"
            >
              <span
                v-if="loading"
                class="spinner"
              />
              {{ loading ? '验证中…' : '登录' }}
            </button>
          </form>

          <p class="footer-note">
            种子账号：admin / legal_bp / business
          </p>
        </div>
      </div>
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

.login-shell {
  position: relative; z-index: 1;
  display: flex; width: min(960px, 92vw); height: min(600px, 86vh);
  border-radius: 28px; overflow: hidden;
  box-shadow: 0 30px 80px rgba(0,0,0,0.12);
}

/* ── 左栏品牌墙 ── */
.brand-panel {
  flex: 1; display: flex; flex-direction: column;
  padding: 40px 44px; color: #fff;
  background: linear-gradient(160deg, #1E3A8A 0%, #1E40AF 45%, #2563EB 100%);
  position: relative;
}
.brand-panel::after {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.10), transparent 55%),
              radial-gradient(circle at 80% 80%, rgba(255,255,255,0.06), transparent 50%);
  pointer-events: none;
}

.brand-top { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1; }
.brand-mark {
  width: 42px; height: 42px; border-radius: 12px;
  background: rgba(255,255,255,0.15);
  border: 1px solid rgba(255,255,255,0.2);
  display: grid; place-items: center;
}
.brand-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }

.brand-body { flex: 1; display: flex; flex-direction: column; justify-content: center; position: relative; z-index: 1; }
.brand-body h1 {
  margin: 0; font-size: 34px; font-weight: 700; line-height: 1.2;
  letter-spacing: -0.02em;
}
.brand-sub {
  margin: 14px 0 36px; font-size: 14px; font-weight: 400;
  color: rgba(255,255,255,0.75);
}

.brand-features { display: flex; flex-direction: column; gap: 20px; }
.bf-item { display: flex; align-items: center; gap: 14px; }
.bf-item strong { display: block; font-size: 14px; font-weight: 600; }
.bf-item small { display: block; margin-top: 2px; font-size: 12px; color: rgba(255,255,255,0.65); }

.brand-footer {
  position: relative; z-index: 1;
  font-size: 11px; color: rgba(255,255,255,0.45);
}

/* ── 右栏登录 ── */
.login-panel {
  width: 420px; display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.7);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}
.login-card {
  width: 100%; height: 100%; border: none; border-radius: 0;
  background: transparent; backdrop-filter: none;
  padding: 48px 44px;
  display: flex; flex-direction: column; justify-content: center;
}
.login-head { text-align: left; margin-bottom: 32px; }
.login-head h2 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: #1d1d1f; }
.login-head p { margin: 6px 0 0; font-size: 14px; color: #86868b; }

.login-form { text-align: left; }
.field { margin-bottom: 20px; }
.field label {
  display: block; margin-bottom: 6px;
  font-size: 13px; font-weight: 590; color: #1d1d1f; letter-spacing: -0.01em;
}
.login-btn { width: 100%; margin-top: 8px; height: 46px; font-size: 16px; }

.error-banner {
  margin-bottom: 16px; padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255,59,48,0.08); color: #C41212;
  font-size: 13px; font-weight: 500; letter-spacing: -0.01em;
  display: flex; align-items: center; gap: 8px;
}

.footer-note {
  margin: 28px 0 0; text-align: center;
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

@media (max-width: 860px) {
  .brand-panel { display: none; }
  .login-panel { width: 100%; }
  .login-shell { height: auto; box-shadow: none; }
}
</style>
