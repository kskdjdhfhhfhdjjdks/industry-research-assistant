/**
 * 冒烟测试驱动：用 esbuild 把 TS 测试入口打成单文件后在 Node 里执行。
 * 这样做的好处是不需要额外引入 vitest / ts-node 之类的测试框架。
 */

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'scripts/.smoke.mjs')

await build({
  absWorkingDir: root,
  entryPoints: ['scripts/smoke.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile,
  logLevel: 'warning',
  define: {
    // Node 环境没有 import.meta.env（Vite 才会注入），这里用空对象代替，
    // 使 Supabase 相关配置走「未启用」分支。
    'import.meta.env': '{}',
  },
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
