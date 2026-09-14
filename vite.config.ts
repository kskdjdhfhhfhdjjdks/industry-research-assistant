import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 说明：
// - 本地开发推荐用 `npm run dev`（netlify dev），它会同时启动 Vite 与 Edge Functions。
// - 如果只用 `npm run dev:vite`，/api/* 请求会 404，因为没有边缘函数运行时。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})
