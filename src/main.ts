import './styles/main.css'

import { createApp } from 'vue'
import App from './App.vue'

const app = createApp(App)

// 渲染期异常统一打印，避免 Vue 默认静默处理导致「白屏但无痕迹」
app.config.errorHandler = (error, _instance, info) => {
  console.error('[DeepResearch] 渲染期异常：', error, `（阶段：${info}）`)
}

app.mount('#app')

/**
 * 最后一层兜底。
 *
 * 曾出现过的一次真实故障：环境变量 VITE_SUPABASE_URL 被误填成数据库连接串，
 * createClient 抛错并冒泡到渲染函数，最终 App 只渲染出一个空注释节点
 * （`<div id="app"><!----></div>`），访客看到的是纯白页面、没有任何提示。
 * 这里在挂载后检查容器是否真的渲染出了元素：注释节点不计入 childElementCount，
 * 所以这种情况会被判定为「渲染失败」并给出可读提示，而不是继续白屏。
 */
const container = document.getElementById('app')
if (container && container.childElementCount === 0) {
  container.innerHTML = [
    '<div style="max-width:560px;margin:16vh auto;padding:28px 32px;font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;line-height:1.7;color:#1f2933;background:#fff;border:1px solid #e4e7eb;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)">',
    '<h2 style="margin:0 0 12px;font-size:18px">界面未能正常加载</h2>',
    '<p style="margin:0 0 12px;color:#52606d">页面脚本已加载，但渲染没有产生任何内容。请按 <kbd>F12</kbd> 打开控制台查看具体报错。</p>',
    '<p style="margin:0;color:#52606d">常见原因是站点环境变量配置有误，例如 <code>VITE_SUPABASE_URL</code> 被填成了数据库连接串（<code>postgresql://…</code>），此处应为 Project URL（<code>https://&lt;project-ref&gt;.supabase.co</code>）。详见项目 README 的「常见问题」章节。</p>',
    '</div>',
  ].join('')
}
