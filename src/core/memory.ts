/**
 * 三层记忆系统 —— 对应原项目的「短期 / 长期语义 / 长期情景」架构。
 *
 * 原版：PostgreSQL（短期会话 + 长期画像）+ Milvus（语义向量检索）。
 * 本版：全部收敛到 Supabase 一张表 + 一次向量检索；未配置时退化为浏览器本地。
 *
 * 记忆是怎么注入 Agent 的？
 * 在整张图开始执行之前，buildMemoryContext() 会把「用户画像 + 相关历史事实 + 本轮会话摘要」
 * 拼成一段 [跨会话记忆] 文本放进 state.memory_context，
 * 之后每个节点通过 withMemoryContext() 把它追加到自己的 prompt 末尾 —— 与原始实现完全一致。
 */

import { embedQuery, cosineSimilarity, hashEmbed } from './embedding'
import { ensureSession, getDb, readLocal, toVectorLiteral, writeLocal } from './db'
import { asString, truncate } from './utils'
import type { ResearchState } from './types'

export type MemoryKind = 'semantic' | 'episodic'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  content: string
  created_at: string
  score?: number
}

export interface ResearchRun {
  query: string
  answer: string
  created_at: string
  iterations: number
  sources: number
}

interface ShortTermTurn {
  role: 'user' | 'assistant'
  content: string
  at: number
}

const SHORT_TERM_MAX_TURNS = 12
const SUMMARY_THRESHOLD = 6

// ---------------------------------------------------------------------------
// 一、短期记忆：按 thread 隔离的最近若干轮
// ---------------------------------------------------------------------------

function shortTermKey(threadId: string): string {
  return `deepresearch.shortterm.${threadId}`
}

function readShortTerm(threadId: string): ShortTermTurn[] {
  try {
    const raw = localStorage.getItem(shortTermKey(threadId))
    return raw ? (JSON.parse(raw) as ShortTermTurn[]) : []
  } catch {
    return []
  }
}

function writeShortTerm(threadId: string, turns: ShortTermTurn[]): void {
  try {
    localStorage.setItem(shortTermKey(threadId), JSON.stringify(turns.slice(-SHORT_TERM_MAX_TURNS * 2)))
  } catch {
    /* 忽略 */
  }
}

/** 超出阈值时做滚动压缩：把较早的对话压成一句摘要，避免 prompt 无限膨胀 */
function summarizeTurns(turns: ShortTermTurn[]): string {
  if (turns.length <= SUMMARY_THRESHOLD) return ''
  const older = turns.slice(0, turns.length - SUMMARY_THRESHOLD)
  const userTopics = older
    .filter((turn) => turn.role === 'user')
    .map((turn) => truncate(turn.content.replace(/\s+/g, ' '), 60))
  if (userTopics.length === 0) return ''
  return `早前会话中用户关注过：${userTopics.slice(-6).join('；')}`
}

// ---------------------------------------------------------------------------
// 二、长期记忆：语义（偏好）+ 情景（历史任务）
// ---------------------------------------------------------------------------

const PREFERENCE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /我(?:的名字)?叫([\u4e00-\u9fffA-Za-z]{2,10})/, label: '用户名' },
  { pattern: /(?:要|请|希望)?(?:用词|语言)?(?:通俗|口语化|平实)(?:一点|一些)?/, label: '偏好通俗表达' },
  { pattern: /(?:要|请|希望)?(?:专业|严谨|学术)(?:一点|一些|风格)?/, label: '偏好专业严谨风格' },
  { pattern: /(?:尽量)?(?:简短|精简|简洁)(?:一点|一些)?/, label: '偏好精简输出' },
  { pattern: /(?:详细|展开|多写|长一点)(?:一点|一些|地)?/, label: '偏好详尽输出' },
  { pattern: /每次(?:都)?(?:要|请)?(?:附上|给出)(?:来源|引用|链接)/, label: '每次输出需要来源引用' },
  { pattern: /(?:表格|表格化)(?:输出|呈现)/, label: '偏好表格化呈现' },
  { pattern: /(?:关注|主要看|重点看)([\u4e00-\u9fffA-Za-z]{2,12})/, label: '关注领域' },
]

export function extractPreferences(query: string): string[] {
  const found: string[] = []
  for (const { pattern, label } of PREFERENCE_PATTERNS) {
    const match = query.match(pattern)
    if (match) {
      const captured = match[1]?.trim()
      found.push(captured ? `${label}：${captured}` : label)
    }
  }
  return [...new Set(found)]
}

export async function saveMemory(input: {
  userId: string
  tenantId: string
  kind: MemoryKind
  content: string
  semantic?: boolean
}): Promise<void> {
  const content = input.content.trim()
  if (!content) return
  const db = getDb()

  if (!db) {
    const items = readLocal<MemoryItem[]>('memories', [])
    if (items.some((item) => item.content === content)) return
    items.unshift({ id: `local-${Date.now()}`, kind: input.kind, content, created_at: new Date().toISOString() })
    writeLocal('memories', items.slice(0, 60))
    return
  }

  const userId = await ensureSession(input.userId)
  const { vector } = await embedQuery(content, { semantic: input.semantic })
  await db.from('memories').insert({
    user_id: userId,
    tenant_id: input.tenantId,
    kind: input.kind,
    content,
    embedding: toVectorLiteral(vector),
  })
}

export async function saveRun(input: {
  userId: string
  tenantId: string
  threadId: string
  query: string
  answer: string
  iterations: number
  sources: number
}): Promise<void> {
  const db = getDb()
  const summary = truncate(input.answer.replace(/[#*`>\-]/g, ' ').replace(/\s+/g, ' ').trim(), 400)

  if (!db) {
    const runs = readLocal<ResearchRun[]>('runs', [])
    runs.unshift({
      query: input.query,
      answer: summary,
      created_at: new Date().toISOString(),
      iterations: input.iterations,
      sources: input.sources,
    })
    writeLocal('runs', runs.slice(0, 20))
    return
  }

  const userId = await ensureSession(input.userId)
  await db.from('research_runs').insert({
    user_id: userId,
    tenant_id: input.tenantId,
    thread_id: input.threadId,
    query: input.query,
    answer: summary,
    iterations: input.iterations,
    source_count: input.sources,
  })
  await saveMemory({
    userId: input.userId,
    tenantId: input.tenantId,
    kind: 'episodic',
    content: `用户曾研究过：${input.query}`,
  })
}

export async function listRecentRuns(userId: string, limit = 6): Promise<ResearchRun[]> {
  const db = getDb()
  if (!db) return readLocal<ResearchRun[]>('runs', []).slice(0, limit)
  const sessionUserId = await ensureSession(userId)
  const { data, error } = await db
    .from('research_runs')
    .select('query,answer,created_at,iterations,source_count')
    .eq('user_id', sessionUserId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return ((data ?? []) as { query: string; answer: string; created_at: string; iterations: number; source_count: number }[]).map(
    (row) => ({
      query: row.query,
      answer: row.answer,
      created_at: row.created_at,
      iterations: row.iterations,
      sources: row.source_count,
    }),
  )
}

async function searchMemories(
  query: string,
  userId: string,
  semantic: boolean,
  limit = 6,
): Promise<MemoryItem[]> {
  const db = getDb()
  if (!db) {
    const items = readLocal<MemoryItem[]>('memories', [])
    const queryVector = hashEmbed(query)
    return items
      .map((item) => ({ ...item, score: cosineSimilarity(queryVector, hashEmbed(item.content)) }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
  }
  const sessionUserId = await ensureSession(userId)
  const { vector } = await embedQuery(query, { semantic })
  const { data, error } = await db.rpc('match_memories', {
    query_embedding: toVectorLiteral(vector),
    match_user_id: sessionUserId,
    match_count: limit,
    match_threshold: 0.05,
  })
  if (error) return []
  return ((data ?? []) as { id: string; kind: string; content: string; created_at: string; similarity: number }[]).map(
    (row) => ({
      id: String(row.id),
      kind: (row.kind === 'episodic' ? 'episodic' : 'semantic') as MemoryKind,
      content: row.content,
      created_at: row.created_at,
      score: Number(row.similarity ?? 0),
    }),
  )
}

// ---------------------------------------------------------------------------
// 三、上下文装配
// ---------------------------------------------------------------------------

export async function buildMemoryContext(input: {
  userId: string
  threadId: string
  query: string
  semantic?: boolean
}): Promise<{ text: string; semantic: MemoryItem[]; episodic: MemoryItem[]; summary: string }> {
  const turns = readShortTerm(input.threadId)
  const summary = summarizeTurns(turns)
  const recentUserTurns = turns
    .filter((turn) => turn.role === 'user')
    .slice(-3)
    .map((turn) => `- 用户曾问：${truncate(turn.content.replace(/\s+/g, ' '), 80)}`)

  let memories: MemoryItem[] = []
  try {
    memories = await searchMemories(input.query, input.userId, input.semantic ?? false)
  } catch {
    memories = []
  }
  const semantic = memories.filter((item) => item.kind === 'semantic').slice(0, 4)
  const episodic = memories.filter((item) => item.kind === 'episodic').slice(0, 3)

  const blocks: string[] = []
  if (semantic.length > 0) {
    blocks.push(`用户画像与偏好：\n${semantic.map((item) => `- ${item.content}`).join('\n')}`)
  }
  if (episodic.length > 0) {
    blocks.push(`相关历史任务：\n${episodic.map((item) => `- ${item.content}`).join('\n')}`)
  }
  if (recentUserTurns.length > 0) {
    blocks.push(`本会话近期上下文：\n${recentUserTurns.join('\n')}`)
  }
  if (summary) blocks.push(`更早会话摘要：${summary}`)

  return { text: blocks.join('\n\n'), semantic, episodic, summary }
}

export function appendTurn(threadId: string, role: 'user' | 'assistant', content: string): void {
  const turns = readShortTerm(threadId)
  turns.push({ role, content: truncate(content, 1500), at: Date.now() })
  writeShortTerm(threadId, turns)
}

/** 与节点层共享的记忆注入包装（对应 nodes.py with_memory_context） */
export function withMemoryContext(state: ResearchState, prompt: string): string {
  const context = asString(state.memory_context, '').trim()
  if (!context) return prompt
  return `${prompt}\n\n[跨会话记忆]\n${context}`
}

export function clearThreadMemory(threadId: string): void {
  try {
    localStorage.removeItem(shortTermKey(threadId))
  } catch {
    /* 忽略 */
  }
}
