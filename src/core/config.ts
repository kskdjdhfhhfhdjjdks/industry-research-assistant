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

export function isSupabaseEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
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
