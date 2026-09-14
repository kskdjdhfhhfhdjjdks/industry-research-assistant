/**
 * 数据访问层 —— Supabase 客户端 + 匿名会话 + 本地兜底存储。
 *
 * 关于安全：Supabase 的 anon key 是设计上就要暴露给浏览器的（它只是「匿名角色标识」），
 * 真正的权限控制在数据库的 RLS 行级策略里。简历项目里这是标准做法，
 * 比把密钥塞进前端代码、或者干脆裸奔要专业得多。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseEnabled } from './config'

let client: SupabaseClient | null = null
let sessionUserId: string | null = null
let sessionError = ''

export function getDb(): SupabaseClient | null {
  if (!isSupabaseEnabled()) return null
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  }
  return client
}

export function dbStatus(): { enabled: boolean; userId: string; error: string } {
  return { enabled: isSupabaseEnabled(), userId: sessionUserId ?? '', error: sessionError }
}

/**
 * 确保有一个可用身份：
 * 1. 优先用 Supabase 匿名登录（会拿到真实的 auth.uid，RLS 可以真正隔离数据）
 * 2. 若站点未开启 Anonymous Sign-In，则退回本地生成的匿名 ID
 */
export async function ensureSession(fallbackUserId: string): Promise<string> {
  if (sessionUserId) return sessionUserId
  const db = getDb()
  if (!db) {
    sessionUserId = fallbackUserId
    return sessionUserId
  }
  try {
    const { data } = await db.auth.getSession()
    if (data.session?.user?.id) {
      sessionUserId = data.session.user.id
      return sessionUserId
    }
    const { data: signIn, error } = await db.auth.signInAnonymously()
    if (error) throw error
    sessionUserId = signIn.user?.id ?? fallbackUserId
    return sessionUserId
  } catch (error) {
    sessionError = error instanceof Error ? error.message : '匿名登录失败'
    sessionUserId = fallbackUserId
    return sessionUserId
  }
}

/** pgvector 列接受 '[1,2,3]' 形式的文本，统一序列化避免格式歧义 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value.toFixed(5))).join(',')}]`
}

// ---------------------------------------------------------------------------
// 本地兜底存储：Supabase 未配置时，知识库与记忆退化为浏览器本地
// ---------------------------------------------------------------------------

const LOCAL_KEYS = {
  documents: 'deepresearch.kb.documents.v1',
  memories: 'deepresearch.memory.v1',
  runs: 'deepresearch.runs.v1',
} as const

export function readLocal<T>(key: keyof typeof LOCAL_KEYS, fallback: T): T {
  try {
    const raw = localStorage.getItem(LOCAL_KEYS[key])
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeLocal(key: keyof typeof LOCAL_KEYS, value: unknown): void {
  try {
    localStorage.setItem(LOCAL_KEYS[key], JSON.stringify(value))
  } catch {
    /* 容量超限或隐私模式：静默降级 */
  }
}

export const LOCAL_STORAGE_KEYS = LOCAL_KEYS
