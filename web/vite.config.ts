import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // 本地联调可 VITE_API_TARGET 指向别的后端端口；默认 3000
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:3000'
  return {
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  }
})
