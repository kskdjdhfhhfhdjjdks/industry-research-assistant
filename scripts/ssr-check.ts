/**
 * 组件渲染冒烟测试：用服务端渲染把整棵组件树跑一遍，
 * 用于捕获模板表达式错误、ref 解包错误、空状态下的运行时异常。
 * 不依赖浏览器（onMounted 中的网络请求在 SSR 下不会执行）。
 */

const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage

const { createSSRApp } = await import('vue')
const { renderToString } = await import('vue/server-renderer')
const { default: App } = await import('../src/App.vue')

const html = await renderToString(createSSRApp(App))

const required = ['DeepResearch', 'Agent 流水线', '意图路由', '证据裁判', '行业深度分析工作台', '本地知识库', '运行统计']
const missing = required.filter((token) => !html.includes(token))

process.stdout.write(`渲染输出长度：${html.length}\n`)
process.stdout.write(`关键内容检查：${missing.length === 0 ? 'PASS' : `FAIL 缺少 ${missing.join(', ')}`}\n`)
process.stdout.write(`节点标签渲染数：${(html.match(/pipeline-item/g) ?? []).length}\n`)

if (missing.length > 0 || html.length < 2000) {
  process.exitCode = 1
}
