<template>
  <main
    ref="pageRoot"
    class="login-page"
  >
    <header class="brand-bar">
      <div class="product-brand">
        <span class="brand-logo-frame">
          <img
            :src="bairongMark"
            alt="百融智能"
          >
        </span>
        <strong>LegalOS</strong>
        <span class="brand-divider" />
        <span class="brand-description">专业法务智能操作系统</span>
      </div>
      <span class="brand-assurance">全球服务覆盖 · 专业可信</span>
    </header>

    <section class="login-layout">
      <div class="story-panel">
        <div class="story-copy">
          <h1>把法律判断，<br>带到每一次业务决策</h1>
          <p>统一身份 · 智能协同 · 专业可信</p>
        </div>

        <DynamicLegalGlobe class="globe-visual" />

        <ul class="sr-only">
          <li
            v-for="capability in capabilities"
            :key="capability"
          >
            {{ capability }}
          </li>
        </ul>

        <div
          class="capability-marquee"
          aria-hidden="true"
        >
          <div class="marquee-track">
            <template
              v-for="group in 2"
              :key="group"
            >
              <span
                v-for="capability in capabilities"
                :key="`${group}-${capability}`"
                class="capability-item"
              >
                {{ capability }}
              </span>
            </template>
          </div>
        </div>
      </div>

      <div class="auth-panel">
        <div class="login-card">
          <div class="login-head">
            <h2>登录 LegalOS</h2>
            <p>使用公司统一账号进入法务工作台</p>
          </div>

          <transition name="fade">
            <div
              v-if="errorMsg"
              class="error-banner"
              role="alert"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                />
                <line
                  x1="12"
                  y1="8"
                  x2="12"
                  y2="12"
                />
                <line
                  x1="12"
                  y1="16"
                  x2="12.01"
                  y2="16"
                />
              </svg>
              <span>{{ errorMsg }}</span>
            </div>
          </transition>

          <form
            class="login-form"
            @submit.prevent="handleLogin"
          >
            <div class="field">
              <label for="login-username">公司账号</label>
              <input
                id="login-username"
                v-model="form.username"
                class="login-input"
                placeholder="请输入公司账号"
                maxlength="128"
                autocomplete="username"
                :disabled="loading"
              >
            </div>

            <div class="field">
              <label for="login-password">密码</label>
              <div class="password-field">
                <input
                  id="login-password"
                  v-model="form.password"
                  class="login-input"
                  :type="showPassword ? 'text' : 'password'"
                  placeholder="请输入密码"
                  maxlength="128"
                  autocomplete="current-password"
                  :disabled="loading"
                >
                <button
                  class="password-toggle"
                  type="button"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  :disabled="loading"
                  @click="showPassword = !showPassword"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                    <circle
                      cx="12"
                      cy="12"
                      r="2.5"
                    />
                    <path
                      v-if="!showPassword"
                      d="M4 4l16 16"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <button
              type="submit"
              class="login-button"
              :disabled="loading"
            >
              <span
                v-if="loading"
                class="spinner"
              />
              {{ loading ? '验证中…' : '登录工作台' }}
            </button>
          </form>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { gsap } from 'gsap'
import { useRoute, useRouter } from 'vue-router'
import DynamicLegalGlobe from '../../components/DynamicLegalGlobe.vue'
import { RequestError } from '../../api/client'
import bairongMark from '../../assets/bairong-intelligence-mark.png'
import { useAuthStore } from '../../stores/auth'
import { HOME_BY_ROLE, type Role } from '../../types'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const pageRoot = ref<HTMLElement | null>(null)
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const showPassword = ref(false)
const errorMsg = ref('')
let animationContext: gsap.Context | null = null

const capabilities = ['法律咨询', '合同审查', '法规检索', '风险分级']

const goHome = (user: { role: Role }) => {
  const redirect = (route.query.redirect as string) || HOME_BY_ROLE[user.role]
  return router.replace(redirect)
}

async function handleLogin() {
  const username = form.username.trim()
  if (!username || !form.password) {
    errorMsg.value = '请输入公司账号和密码'
    return
  }

  loading.value = true
  errorMsg.value = ''
  try {
    const user = await auth.signIn(username, form.password)
    await goHome(user)
  } catch (error) {
    errorMsg.value = error instanceof RequestError
      ? error.payload.error
      : '登录失败，请稍后再试'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!pageRoot.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  animationContext = gsap.context(() => {
    gsap.from('.brand-bar', {
      autoAlpha: 0,
      y: -18,
      duration: 0.7,
      ease: 'power2.out',
    })
    gsap.from('.story-copy > *', {
      autoAlpha: 0,
      y: 28,
      duration: 0.85,
      stagger: 0.12,
      ease: 'power3.out',
      delay: 0.12,
    })
    gsap.from('.login-card', {
      autoAlpha: 0,
      y: 34,
      scale: 0.97,
      duration: 0.9,
      ease: 'power3.out',
      delay: 0.2,
    })
  }, pageRoot.value)
})

onBeforeUnmount(() => animationContext?.revert())
</script>

<script lang="ts">export default { name: 'LoginView' }</script>

<style scoped>
.login-page {
  --login-text: #111827;
  --login-secondary: #374151;
  --login-tertiary: #6B7280;
  --login-border: #E5E7EB;
  --login-canvas: #F7F8FA;
  min-height: 100vh;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  color: var(--login-text);
  background:
    radial-gradient(circle at 22% 46%, rgba(191, 219, 254, 0.52), transparent 42%),
    var(--login-canvas);
  font-family: Geist, "Noto Sans SC", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
}

.brand-bar {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
  padding: 0 40px;
  border-bottom: 1px solid var(--login-border);
  background: rgba(255, 255, 255, 0.92);
}

.product-brand {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 12px;
}

.brand-logo-frame {
  display: grid;
  width: 34px;
  height: 34px;
  overflow: hidden;
  place-items: center;
  flex: 0 0 auto;
}

.brand-logo-frame img {
  display: block;
  width: 34px;
  height: 34px;
  object-fit: contain;
}

.product-brand strong {
  font-size: 21px;
  font-weight: 720;
  letter-spacing: -0.025em;
}

.brand-divider {
  width: 1px;
  height: 22px;
  margin: 0 6px;
  background: #D1D5DB;
}

.brand-description,
.brand-assurance {
  color: var(--login-secondary);
  font-size: 14px;
}

.login-layout {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(420px, 5fr);
  min-height: calc(100vh - 64px);
}

.story-panel {
  position: relative;
  display: flex;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  padding: clamp(72px, 9vh, 120px) clamp(52px, 7vw, 120px) 0;
}

.story-copy {
  position: relative;
  z-index: 2;
}

.story-copy h1 {
  width: min(760px, 100%);
  margin: 0;
  color: #0F1D3A;
  font-size: clamp(40px, 4.2vw, 68px);
  font-weight: 650;
  letter-spacing: -0.045em;
  line-height: 1.18;
}

.story-copy p {
  margin: 24px 0 0;
  color: #42526E;
  font-size: clamp(16px, 1.35vw, 20px);
  letter-spacing: 0.05em;
}

.globe-visual {
  position: absolute;
  z-index: 1;
  left: -4%;
  bottom: 48px;
}

.capability-marquee {
  position: absolute;
  z-index: 3;
  right: 42px;
  bottom: 0;
  left: 42px;
  height: 72px;
  overflow: hidden;
  border-top: 1px solid rgba(148, 163, 184, 0.36);
  background: rgba(247, 248, 250, 0.64);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.marquee-track {
  display: flex;
  width: max-content;
  height: 100%;
  align-items: center;
  animation: capability-scroll 24s linear infinite;
}

.capability-item {
  display: inline-flex;
  align-items: center;
  color: #334155;
  font-size: 15px;
  white-space: nowrap;
}

.capability-item::after {
  width: 5px;
  height: 5px;
  margin: 0 34px;
  border-radius: 50%;
  background: #2563EB;
  content: "";
}

@keyframes capability-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

.auth-panel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 48px clamp(36px, 4vw, 72px);
  border-left: 1px solid rgba(229, 231, 235, 0.78);
  background: rgba(255, 255, 255, 0.78);
}

.login-card {
  width: min(100%, 520px);
  min-height: 600px;
  padding: clamp(44px, 5vw, 72px);
  border: 1px solid var(--login-border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
}

.login-head {
  margin: 72px 0 48px;
}

.login-head h2 {
  margin: 0;
  font-size: clamp(30px, 2.35vw, 40px);
  font-weight: 680;
  letter-spacing: -0.035em;
}

.login-head p {
  margin: 12px 0 0;
  color: var(--login-tertiary);
  font-size: 15px;
}

.field {
  margin-bottom: 24px;
}

.field label {
  display: block;
  margin-bottom: 8px;
  color: var(--login-secondary);
  font-size: 13px;
  font-weight: 600;
}

.password-field {
  position: relative;
}

.login-input {
  width: 100%;
  height: 48px;
  padding: 0 14px;
  border: 1px solid #D6DAE1;
  border-radius: 6px;
  outline: none;
  background: #FFFFFF;
  color: var(--login-text);
  font: inherit;
  font-size: 14px;
  transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
}

.password-field .login-input {
  padding-right: 46px;
}

/* Edge 自带密码显示按钮；此输入框已提供统一的可见性切换控件。 */
#login-password::-ms-reveal {
  display: none;
}

.login-input::placeholder {
  color: #9CA3AF;
}

.login-input:hover:not(:disabled) {
  border-color: #BFD0EB;
}

.login-input:focus {
  border-color: #2563EB;
  box-shadow: 0 0 0 3px #EFF6FF;
}

.login-input:disabled {
  background: #F3F4F6;
  color: #9CA3AF;
  cursor: not-allowed;
}

.password-toggle {
  position: absolute;
  top: 50%;
  right: 10px;
  display: grid;
  width: 32px;
  height: 32px;
  padding: 0;
  transform: translateY(-50%);
  border: 0;
  border-radius: 6px;
  place-items: center;
  background: transparent;
  color: #6B7280;
}

.password-toggle:hover:not(:disabled) {
  background: #F3F4F6;
  color: #2563EB;
}

.login-button {
  display: inline-flex;
  width: 100%;
  height: 48px;
  margin-top: 8px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  background: #2563EB;
  color: #FFFFFF;
  font: inherit;
  font-size: 15px;
  font-weight: 650;
  transition: background 180ms ease, transform 180ms ease;
}

.login-button:hover:not(:disabled) {
  background: #1D4ED8;
  transform: translateY(-1px);
}

.login-button:active:not(:disabled) {
  transform: translateY(0);
}

.login-button:disabled {
  background: #9CA3AF;
  cursor: not-allowed;
}

.error-banner {
  display: flex;
  margin: -24px 0 24px;
  padding: 12px 14px;
  align-items: center;
  gap: 8px;
  border: 1px solid #FDA29B;
  border-radius: 8px;
  background: #FEF3F2;
  color: #B42318;
  font-size: 13px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.36);
  border-top-color: #FFFFFF;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.fade-enter-active { transition: opacity 220ms ease; }
.fade-leave-active { transition: opacity 160ms ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }

@media (max-width: 1080px) {
  .login-layout {
    grid-template-columns: minmax(0, 6fr) minmax(420px, 6fr);
  }

  .story-panel {
    padding-right: 48px;
    padding-left: 48px;
  }

  .story-copy h1 {
    font-size: clamp(38px, 4.7vw, 54px);
  }
}

@media (max-width: 860px) {
  .brand-bar {
    padding: 0 24px;
  }

  .brand-description,
  .brand-assurance,
  .brand-divider,
  .story-panel {
    display: none;
  }

  .login-layout {
    display: block;
    min-height: calc(100vh - 64px);
  }

  .auth-panel {
    min-height: calc(100vh - 64px);
    padding: 24px;
    border-left: 0;
    background:
      radial-gradient(circle at 20% 10%, rgba(191, 219, 254, 0.5), transparent 40%),
      #F7F8FA;
  }

  .login-card {
    min-height: auto;
    padding: 40px 28px 48px;
  }

  .login-head {
    margin: 12px 0 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .marquee-track {
    animation-play-state: paused;
  }
}
</style>
