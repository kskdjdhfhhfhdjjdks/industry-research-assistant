/**
 * 本地知识库 —— 对应原项目 app/mult_agents/rag/core.py 的 RAGSystem。
 *
 * 原版：Milvus + DashScope embedding，服务端长连接。
 * 本版：Supabase pgvector（免费云数据库）+ 浏览器端向量化。
 * 关键收益是「零基础设施」：不需要部署 Milvus，也不需要额外的 embedding API Key。
 *
 * 检索路径：
 *   文本 → 分片 → 向量化 → 写入 knowledge_chunks
 *   查询 → 向量化 → RPC match_knowledge_chunks（pgvector 余弦距离）→ Top-K
 * 未配置 Supabase 时，自动降级为浏览器本地存储 + 内存中余弦相似度检索。
 */

import { embedQuery, embedTexts, hashEmbed, cosineSimilarity } from './embedding'
import { ensureSession, getDb, readLocal, toVectorLiteral, writeLocal } from './db'
import { asString, truncate } from './utils'
import type { SourceRecord } from './types'

export interface DocumentMeta {
  id: string
  title: string
  chunk_count: number
  created_at: string
  storage: 'supabase' | 'local'
}

export interface KnowledgeHit {
  source_id: string
  doc_id: string
  title: string
  snippet: string
  source_type: 'local'
  score: number
}

interface LocalDocument {
  id: string
  title: string
  created_at: string
  chunks: string[]
}

export function knowledgeMode(): 'supabase' | 'local' {
  return getDb() ? 'supabase' : 'local'
}

// ---------------------------------------------------------------------------
// 文本分片：对齐原项目 RecursiveCharacterTextSplitter 的中文分隔符策略
// ---------------------------------------------------------------------------

export function chunkText(text: string, chunkSize = 500, overlap = 60): string[] {
  const normalized = (text ?? '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  const paragraphs = normalized.split(/\n{2,}/)
  const units: string[] = []
  for (const paragraph of paragraphs) {
    const sentences = paragraph.split(/(?<=[。！？；!?;;])|\n/)
    for (const sentence of sentences) {
      const piece = sentence.trim()
      if (piece) units.push(piece)
    }
  }

  const chunks: string[] = []
  let buffer = ''
  for (const unit of units) {
    if (buffer && buffer.length + unit.length > chunkSize) {
      chunks.push(buffer)
      buffer = buffer.slice(Math.max(0, buffer.length - overlap)) + unit
    } else {
      buffer += unit
    }
    // 单句超长时硬切
    while (buffer.length > chunkSize * 1.6) {
      chunks.push(buffer.slice(0, chunkSize))
      buffer = buffer.slice(chunkSize - overlap)
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim())
  return chunks.filter((chunk) => chunk.length > 20)
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export async function ingestDocument(input: {
  title: string
  content: string
  userId: string
  semantic?: boolean
}): Promise<{ chunks: number; storage: 'supabase' | 'local'; backend: string; documentId: string }> {
  const title = asString(input.title, '').trim() || '未命名文档'
  const chunks = chunkText(input.content)
  if (chunks.length === 0) throw new Error('文档内容为空或过短，无法建立索引')

  const { vectors, backend } = await embedTexts(chunks, { semantic: input.semantic })
  const db = getDb()

  if (!db) {
    const documents = readLocal<LocalDocument[]>('documents', [])
    const documentId = `local-${Date.now()}`
    documents.unshift({
      id: documentId,
      title,
      created_at: new Date().toISOString(),
      chunks,
    })
    // 本地模式只持久化原文，向量在检索时按需重算，避免撑爆 localStorage
    writeLocal('documents', documents.slice(0, 40))
    return { chunks: chunks.length, storage: 'local', backend, documentId }
  }

  const userId = await ensureSession(input.userId)
  const { data: doc, error: docError } = await db
    .from('documents')
    .insert({ user_id: userId, title, source_type: 'upload', chunk_count: chunks.length })
    .select('id')
    .single()
  if (docError) throw new Error(`写入文档失败：${docError.message}`)

  const documentId = asString((doc as { id?: string })?.id, '')
  const rows = chunks.map((content, index) => ({
    document_id: documentId,
    user_id: userId,
    document_title: title,
    chunk_index: index,
    content,
    embedding: toVectorLiteral(vectors[index] ?? hashEmbed(content)),
  }))

  // 分批插入，避免单次请求体过大
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50)
    const { error } = await db.from('knowledge_chunks').insert(batch)
    if (error) throw new Error(`写入知识分片失败：${error.message}`)
  }

  return { chunks: chunks.length, storage: 'supabase', backend, documentId }
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

export async function searchKnowledge(
  query: string,
  options: { userId: string; limit?: number; semantic?: boolean } = { userId: 'public' },
): Promise<KnowledgeHit[]> {
  const limit = options.limit ?? 5

  if (knowledgeMode() === 'local') {
    return searchLocal(query, limit)
  }

  const db = getDb()
  if (!db) return searchLocal(query, limit)

  const userId = await ensureSession(options.userId)
  const { vector } = await embedQuery(query, { semantic: options.semantic })
  const { data, error } = await db.rpc('match_knowledge_chunks', {
    query_embedding: toVectorLiteral(vector),
    match_user_id: userId,
    match_count: limit,
    match_threshold: 0.05,
  })

  if (error) {
    // 云端检索失败时不阻断主流程，退回本地
    return searchLocal(query, limit)
  }

  const rows = (data ?? []) as {
    id: number | string
    document_id: string
    document_title: string
    chunk_index: number
    content: string
    similarity: number
  }[]

  return rows.map((row, index) => ({
    source_id: `LOC-cloud-${index + 1}`,
    doc_id: `${row.document_title}#${row.chunk_index}`,
    title: row.document_title,
    snippet: truncate(row.content, 800),
    source_type: 'local' as const,
    score: Number(row.similarity ?? 0),
  }))
}

function searchLocal(query: string, limit: number): KnowledgeHit[] {
  const documents = readLocal<LocalDocument[]>('documents', [])
  if (documents.length === 0) return []
  const queryVector = hashEmbed(query)
  const scored: KnowledgeHit[] = []
  for (const document of documents) {
    document.chunks.forEach((content, index) => {
      const score = cosineSimilarity(queryVector, hashEmbed(content))
      if (score <= 0.02) return
      scored.push({
        source_id: `LOC-local-${scored.length + 1}`,
        doc_id: `${document.title}#${index}`,
        title: document.title,
        snippet: truncate(content, 800),
        source_type: 'local',
        score,
      })
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export async function listDocuments(userId: string): Promise<DocumentMeta[]> {
  const db = getDb()
  if (!db) {
    return readLocal<LocalDocument[]>('documents', []).map((document) => ({
      id: document.id,
      title: document.title,
      chunk_count: document.chunks.length,
      created_at: document.created_at,
      storage: 'local' as const,
    }))
  }
  const sessionUserId = await ensureSession(userId)
  const { data, error } = await db
    .from('documents')
    .select('id,title,chunk_count,created_at')
    .eq('user_id', sessionUserId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return []
  return ((data ?? []) as Omit<DocumentMeta, 'storage'>[]).map((row) => ({ ...row, storage: 'supabase' as const }))
}

export async function deleteDocument(id: string, userId: string): Promise<void> {
  const db = getDb()
  if (!db || id.startsWith('local-')) {
    const documents = readLocal<LocalDocument[]>('documents', []).filter((document) => document.id !== id)
    writeLocal('documents', documents)
    return
  }
  const sessionUserId = await ensureSession(userId)
  await db.from('knowledge_chunks').delete().eq('document_id', id).eq('user_id', sessionUserId)
  await db.from('documents').delete().eq('id', id).eq('user_id', sessionUserId)
}

/** 转成检索层统一的记录结构 */
export function toSourceRecords(hits: KnowledgeHit[]): SourceRecord[] {
  return hits.map((hit) => ({
    source_id: hit.source_id,
    title: hit.title,
    snippet: hit.snippet,
    source_type: 'local' as const,
    doc_id: hit.doc_id,
  }))
}
