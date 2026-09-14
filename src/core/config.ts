/**
 * 运行时配置层：把「模型供应商 / 检索 / 演示模式」这些可变项收敛到一处，
 * 并存到 localStorage（浏览器版没有服务端配置中心）。
 *
 * 密钥优先级：
 *   1. Netlify 边缘函数里的环境变量（推荐，访客无需自备 key）
 *   2. 访客在设置面板里自填的 key（存在浏览器本地，仅用于直连兜底）
 *   3. 都没有 → 自动进入演示模式（用内置样例数据跑完整条流水线）
 */

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  docs: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    docs: 'https://platform.deepseek.com',
  },
  {
    id: 'qwen',
    label: '通义千问（DashScope 兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    docs: 'https://bailian.console.aliyun.com',
  },
  {
    id: 'moonshot',
    label: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    docs: 'https://platform.moonshot.cn',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com',
  },
  {
    id: 'custom',
    label: '自定义（任意 OpenAI 兼容端点）',
    baseUrl: '',
    model: '',
    docs: '',
  },
]

export interface AppSettings {
  providerId: string
  baseUrl: string
  model: string
  /** 访客自填的 key，仅存本地 */
  apiKey: string
  /** 是否优先走 Netlify 边缘函数代理 */
  useProxy: boolean
  maxIterations: number
  userId: string
  threadId: string
  tenantId: string
  /** 本地检索是否启用语义向量（否则用关键词打分） */
  semanticEmbedding: boolean
}

const STORAGE_KEY = 'deepresearch.settings.v1'

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function defaultSettings(): AppSettings {
  const preset = PROVIDER_PRESETS[0]
  return {
    providerId: preset.id,
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: '',
    useProxy: true,
    maxIterations: 2,
    userId: `user-${randomId('anon')}`,
    threadId: randomId('thread'),
    tenantId: 'public',
    semanticEmbedding: false,
  }
}

export function loadSettings(): AppSettings {
  const base = defaultSettings()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { ...base, ...parsed }
  } catch {
    return base
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* 隐私模式下 localStorage 可能不可用，静默降级 */
  }
}

/** Supabase 只读凭证来自构建期环境变量（公开信息，安全性依赖 RLS） */
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
export const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** 判断字符串是否为合法的 http/https URL */
export function isHttpUrl(value: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 校验一组 Supabase 配置，返回空字符串表示「可用」，「未配置」表示两项都缺失，
 * 其余返回值是具体的问题描述。抽成纯函数是为了可以脱离构建期环境变量直接做回归测试。
 *
 * 最常见的误配是把 Supabase 控制台的 **Database Connection String**
 * （`postgresql://postgres:***@db.xxx.supabase.co:5432/postgres`）
 * 填到了 `VITE_SUPABASE_URL` 的位置。它不是一个 HTTP(S) URL，
 * 会让 `createClient()` 抛 `Invalid supabaseUrl`；而 `knowledgeMode()`
 * 会在首屏渲染时被调用，异常会一路冒泡到渲染函数，结果是**整页白屏**。
 * 所以必须在创建客户端之前就把它拦下来。
 */
export function validateSupabaseConfig(url: string, key: string): string {
  const hasUrl = Boolean(url)
  const hasKey = Boolean(key)
  if (!hasUrl && !hasKey) return '未配置'
  if (!hasUrl) return '缺少 VITE_SUPABASE_URL'
  if (!hasKey) return '缺少 VITE_SUPABASE_ANON_KEY'
  if (!isHttpUrl(url)) {
    return url.toLowerCase().startsWith('postgres')
      ? 'VITE_SUPABASE_URL 填成了数据库连接串，应填 Project URL（https://<project-ref>.supabase.co）'
      : 'VITE_SUPABASE_URL 不是合法的 http/https 地址'
  }
  return ''
}

/** 诊断信息：完全未配置或配置正确时返回空字符串 */
export function supabaseConfigIssue(): string {
  const issue = validateSupabaseConfig(SUPABASE_URL, SUPABASE_ANON_KEY)
  return issue === '未配置' ? '' : issue
}

/**
 * 只有 URL 合法（http/https）且 key 非空时才启用 Supabase。
 * 任一条件不满足都退回浏览器本地存储 —— 功能不丢，只是不落云、不崩页面。
 */
export function isSupabaseEnabled(): boolean {
  return validateSupabaseConfig(SUPABASE_URL, SUPABASE_ANON_KEY) === ''
}

export function applyPreset(settings: AppSettings, providerId: string): AppSettings {
  const preset = PROVIDER_PRESETS.find((item) => item.id === providerId)
  if (!preset) return settings
  return {
    ...settings,
    providerId,
    baseUrl: preset.baseUrl || settings.baseUrl,
    model: preset.model || settings.model,
  }
}
