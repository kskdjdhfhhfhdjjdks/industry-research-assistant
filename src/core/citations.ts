/**
 * 引用溯源与幻觉防控 —— 迁移自原项目 nodes.py 的引用校验与参考列表渲染逻辑。
 *
 * 设计要点（这也是面试里最能讲的一段）：
 * 幻觉引用不能靠模型自觉，必须用代码兜住。所以流程是——
 *   1. 来源编号在「检索阶段」就由代码生成，贯穿到 source_index；
 *   2. Writer 的 prompt 里给出「合法引用白名单」；
 *   3. 写完用正则扫描正文，非法编号直接从正文中剔除，而不是留给读者去发现；
 *   4. 参考列表只列出正文中真实出现过的编号，并按「网络在前、本地在后」排序，
 *      本地来源按 locator 去重（同一份文档的多个分片只展示一次）。
 */

import type { ResearchState, SourceIndexEntry } from './types'
import { asString } from './utils'

const CITATION_PATTERN = /\[([A-Z]+\d+_\d+-\d+)\]/g

export function extractCitationIds(content: string): string[] {
  const found = (content ?? '').match(CITATION_PATTERN) ?? []
  const ids = found.map((item) => item.slice(1, -1))
  return [...new Set(ids)]
}

/** 剔除正文中的非法引用编号，并返回实际使用到的合法编号 */
export function validateAndFixCitations(
  content: string,
  validSourceIds: Set<string>,
): { content: string; usedIds: string[] } {
  const fixed = (content ?? '').replace(CITATION_PATTERN, (match, id: string) =>
    validSourceIds.has(id) ? match : '',
  )
  const usedIds = extractCitationIds(fixed).filter((id) => validSourceIds.has(id))
  return { content: fixed, usedIds }
}

export interface SourceLookupEntry {
  source_id: string
  source_type: string
  label: string
  locator: string
}

export function buildSourceLookup(state: ResearchState): Record<string, SourceLookupEntry> {
  const lookup: Record<string, SourceLookupEntry> = {}

  const put = (sourceId: string, sourceType: string, label: string, locator: string) => {
    const id = sourceId.trim()
    if (!id) return
    const existing = lookup[id]
    if (!existing) {
      lookup[id] = {
        source_id: id,
        source_type: sourceType || 'source',
        label: label || id,
        locator: locator || '',
      }
      return
    }
    if (!existing.locator && locator) existing.locator = locator
    if (!existing.label && label) existing.label = label
    if ((existing.source_type === 'source' || !existing.source_type) && sourceType) existing.source_type = sourceType
  }

  for (const source of state.source_index ?? []) {
    put(asString(source.source_id), asString(source.source_type, 'source'), asString(source.label), asString(source.locator))
  }
  for (const evidence of state.evidence_pool ?? []) {
    put(
      asString(evidence.source_id),
      asString(evidence.source_type, 'source'),
      asString(evidence.title || evidence.source_label),
      asString(evidence.url || evidence.doc_id),
    )
  }
  for (const evidence of state.web_evidence ?? []) {
    put(asString(evidence.source_id), 'web', asString(evidence.title), asString(evidence.url))
  }
  for (const evidence of state.local_evidence ?? []) {
    put(asString(evidence.source_id), 'local', asString(evidence.title || evidence.doc_id), asString(evidence.doc_id))
  }

  for (const [id, entry] of Object.entries(lookup)) {
    if (id.startsWith('LOC')) entry.source_type = 'local'
    else if (id.startsWith('WEB')) entry.source_type = 'web'
  }
  return lookup
}

export function renderReferenceList(state: ResearchState): string {
  const lookup = buildSourceLookup(state)
  const draft = state.draft || state.final || ''

  let citedIds: string[] = []
  if (draft) {
    for (const id of extractCitationIds(draft)) {
      if (lookup[id] && !citedIds.includes(id)) citedIds.push(id)
    }
  }
  if (citedIds.length === 0) {
    for (const finding of state.findings ?? []) {
      for (const raw of finding.source_ids ?? []) {
        const id = asString(raw).trim()
        if (id && !citedIds.includes(id) && lookup[id]) citedIds.push(id)
      }
    }
  }
  if (citedIds.length === 0) citedIds = Object.keys(lookup)

  const seenLocators = new Set<string>()
  const webIds: string[] = []
  const localIds: string[] = []
  for (const id of citedIds) {
    const source = lookup[id]
    if (!source) continue
    if (source.source_type === 'local') {
      const dedupeKey = source.locator || id
      if (seenLocators.has(dedupeKey)) continue
      seenLocators.add(dedupeKey)
      localIds.push(id)
    } else {
      webIds.push(id)
    }
  }

  let displayIds = [...webIds, ...localIds]
  if (displayIds.length === 0) displayIds = citedIds.slice(0, 15)

  const lines = ['## 参考资料']
  for (const id of displayIds) {
    const source = lookup[id]
    if (!source) continue
    const locator = source.locator || (source.source_type === 'web' ? '链接暂不可用' : '本地知识库')
    const typeLabel = source.source_type === 'local' ? '本地' : '网络'
    lines.push(`- **[${source.source_id}]**（${typeLabel}）${source.label} — ${locator}`)
  }
  if (lines.length === 1) lines.push('- 暂无参考资料')
  return lines.join('\n')
}

export function ensureReferenceSection(content: string, state: ResearchState): string {
  const base = (content ?? '').replace(/\s+$/, '')
  if (/##\s*(引用列表|来源清单|参考资料|参考文献)/.test(base)) return base
  return `${base}\n\n${renderReferenceList(state)}`
}

/** 执行明细附录：把规划、检索轨迹、统计口径全部落地成可审计文本 */
export function renderExecutionAppendix(state: ResearchState): string {
  const lines: string[] = ['## 附录：执行明细', '', '### 执行概览']
  const webStats = state.web_retrieval_stats
  const localStats = state.local_retrieval_stats
  lines.push(`- 规划研究问题数：${state.research_questions?.length ?? 0}`)
  lines.push(`- 规划检索步骤数：${state.search_plan?.length ?? 0}`)
  lines.push(`- 检索迭代轮次：${(state.iteration ?? 0) + 1}`)
  lines.push(
    `- 网络检索：query=${webStats?.query_count ?? 0} raw=${webStats?.raw_count ?? 0} kept=${webStats?.kept_count ?? 0} dropped=${webStats?.dropped_count ?? 0}`,
  )
  lines.push(
    `- 本地检索：query=${localStats?.query_count ?? 0} raw=${localStats?.raw_count ?? 0} kept=${localStats?.kept_count ?? 0} dropped=${localStats?.dropped_count ?? 0}`,
  )
  lines.push(`- 模型调用次数：${state.llm_calls}，累计 token：${state.input_tokens + state.output_tokens}`)

  lines.push('', '### 问题拆解')
  for (const question of state.sub_questions ?? []) lines.push(`- ${question}`)
  if (!state.sub_questions?.length) lines.push('- 无')

  lines.push('', '### 证据池置信度分布')
  const buckets = { high: 0, medium: 0, low: 0 }
  for (const evidence of state.evidence_pool ?? []) {
    const score = evidence.reliability_score ?? 0
    if (score >= 0.8) buckets.high += 1
    else if (score >= 0.6) buckets.medium += 1
    else buckets.low += 1
  }
  lines.push(`- 高可信（≥0.8）：${buckets.high} 条`)
  lines.push(`- 中可信（0.6~0.8）：${buckets.medium} 条`)
  lines.push(`- 低可信（<0.6）：${buckets.low} 条`)

  if (state.audit_flags?.length) {
    lines.push('', '### 审计标记')
    for (const flag of state.audit_flags) {
      lines.push(`- [${flag.type}] ${flag.target}：${flag.reason}`)
    }
  }

  if (state.critique) {
    lines.push('', `### 质检结论（评分 ${state.critique.score}/100）`)
    lines.push(state.critique.verdict || '')
    for (const issue of state.critique.issues ?? []) {
      lines.push(`- [${issue.severity}] ${issue.type} · ${issue.target}：${issue.detail}`)
    }
  }
  return lines.join('\n')
}

export function collectSourceIndex(state: ResearchState): SourceIndexEntry[] {
  return state.source_index ?? []
}
