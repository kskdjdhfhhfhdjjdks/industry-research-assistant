/**
 * 组件渲染冒烟测试驱动：用 Vite 的 SSR 构建把整棵组件树渲染一次。
 * 目的是在没有浏览器的前提下，捕获模板表达式错误与 ref 解包错误。
 */

import { build } from 'vite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  root,
  logLevel: 'warn',
  build: {
    ssr: 'scripts/ssr-check.ts',
    outDir: 'scripts/.ssr',
    emptyOutDir: true,
    minify: false,
  },
})

const result = spawnSync(process.execPath, ['scripts/.ssr/ssr-check.js'], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
