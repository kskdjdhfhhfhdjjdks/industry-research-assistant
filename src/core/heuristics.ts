/**
 * 启发式规则层 —— 完全不依赖大模型的可解释规则。
 *
 * 这是原项目「规则引擎 + 大模型双模态判断」里的规则那一半：
 * 意图预判、检索词派生、相关性估算、域名黑白名单、证据可信度评分。
 * 放在浏览器里跑还有个额外好处：零成本、零延迟、且行为完全可复现。
 */

import type { EvidenceItem, SearchPlanItem, SourceRecord, SourceType } from './types'
import { asString, dedupeBy, truncate } from './utils'

// ---------------------------------------------------------------------------
// 一、意图规则路由（对应 nodes.py detect_intent）
// ---------------------------------------------------------------------------

const FORCE_MULTIAGENT_KEYWORDS = [
  '调查',
  '调研',
  '来源',
  '证据',
  '检索统计',
  '来源清单',
  '重大新闻',
  '热门项目',
  '趋势',
  '新闻',
  '最新',
  '盘点',
  '研报',
  '市场',
  '竞品',
  '行业',
]

const MULTIAGENT_KEYWORDS = [
  '调研',
  '研究',
  '调查',
  '盘点',
  '热门',
  '趋势',
  '榜单',
  '分析',
  '方案',
  '架构',
  '设计',
  '对比',
  '报告',
  '代码',
  '实现',
  '落地',
  '检索',
  '知识库',
  '证据',
  '来源',
  '溯源',
  '资料',
  '手册',
  '验证',
  '数据',
  '模型',
]

export function detectIntent(query: string): 'direct' | 'multiagent' {
  const normalized = (query ?? '').trim()
  // 中文长度短且没有检索类词，通常是寒暄或概念提问
  if (/\b20\d{2}\s*年\b|20\d{2}年/.test(normalized)) {
    if (['趋势', '新闻', '调研', '调查', '盘点', '市场'].some((word) => normalized.includes(word))) {
      return 'multiagent'
    }
  }
  if (FORCE_MULTIAGENT_KEYWORDS.some((word) => normalized.includes(word))) return 'multiagent'
  if (MULTIAGENT_KEYWORDS.some((word) => normalized.includes(word))) return 'multiagent'
  return 'direct'
}

// ---------------------------------------------------------------------------
// 二、检索词派生（对应 nodes.py _guess_primary_entity / _derive_direct_search_queries）
// ---------------------------------------------------------------------------

const STOP_ENTITIES = new Set([
  '帮我',
  '调查',
  '最新',
  '使用趋势',
  '是什么',
  '多少',
  '情况',
  '请调研',
  '请分析',
  'the',
  'latest',
  'trend',
  'news',
  'agent',
  'open',
  'using',
])

export function guessPrimaryEntity(query: string): string {
  const lowered = (query ?? '').toLowerCase()
  const asciiTerms = lowered.match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  for (const term of asciiTerms) {
    if (!STOP_ENTITIES.has(term)) return term
  }
  const cjkTerms = (query ?? '').match(/[\u4e00-\u9fff]{2,}/g) ?? []
  for (const term of cjkTerms) {
    if (!STOP_ENTITIES.has(term)) return term
  }
  return ''
}

/** 把用户原始提问展开成一组直接检索词（这是「搜索词优化」的零成本版本） */
export function deriveDirectSearchQueries(query: string): string[] {
  const base = (query ?? '').trim()
  if (!base) return []
  const entity = guessPrimaryEntity(base)
  const candidates = [base]
  if (entity) {
    candidates.push(
      `${entity} 市场规模 2026`,
      `${entity} 行业报告`,
      `${entity} 竞争格局`,
      `${entity} 官方数据`,
      `${entity} 政策 监管`,
    )
  } else {
    candidates.push(`${base} 行业报告`, `${base} 市场规模`, `${base} 官方数据`)
  }
  const deduped: string[] = []
  for (const item of candidates) {
    const text = item.trim()
    if (text && !deduped.includes(text)) deduped.push(text)
  }
  return deduped.slice(0, 6)
}

const QUERY_STOPWORDS = new Set([
  '什么',
  '如何',
  '以及',
  '一个',
  '关于',
  '这个',
  '那个',
  '进行',
  '基于',
  '附带',
  '来源',
  '清单',
  '情况',
  '请给',
  '帮我',
])

export function extractQueryTerms(query: string): string[] {
  const parts = (query ?? '').toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z0-9_-]{3,}/g) ?? []
  const terms: string[] = []
  for (const part of parts) {
    if (QUERY_STOPWORDS.has(part)) continue
    terms.push(part)
  }
  return terms.slice(0, 12)
}

/** 关键词命中率，作为「无 LLM 参与」的相关性基线 */
export function estimateRelevance(query: string, text: string): number {
  const terms = extractQueryTerms(query)
  if (terms.length === 0) return 0
  const haystack = (text ?? '').toLowerCase()
  const hits = terms.filter((term) => haystack.includes(term)).length
  return hits / terms.length
}

/** 检索词必须与用户问题有实体或词元重叠，避免 LLM 规划时跑偏 */
export function isQueryGrounded(candidate: string, userQuery: string): boolean {
  const entity = guessPrimaryEntity(userQuery)
  if (entity && candidate.toLowerCase().includes(entity)) return true
  const candidateTerms = new Set(extractQueryTerms(candidate))
  const userTerms = new Set(extractQueryTerms(userQuery))
  if (candidateTerms.size === 0 || userTerms.size === 0) return false
  for (const term of candidateTerms) {
    if (userTerms.has(term)) return true
  }
  return false
}

/** 组装最终检索计划（对应 nodes.py _derive_search_plan） */
export function deriveSearchPlan(
  outline: { id: string; search_queries?: string[] }[],
  query: string,
): SearchPlanItem[] {
  const plan: SearchPlanItem[] = []
  for (const direct of deriveDirectSearchQueries(query)) {
    plan.push({
      section_id: 'user_query',
      query: direct,
      source_preference: 'hybrid',
      reason: '围绕用户原始问题生成的直接检索词',
    })
  }
  for (const section of outline ?? []) {
    const sectionId = section.id || 'sec'
    for (const raw of section.search_queries ?? []) {
      const text = asString(raw, '').trim()
      if (!text || !isQueryGrounded(text, query)) continue
      plan.push({
        section_id: sectionId,
        query: text,
        source_preference: 'hybrid',
        reason: `来自大纲章节 ${sectionId}`,
      })
    }
  }
  if (plan.length === 0) {
    plan.push({ section_id: 'sec_1', query, source_preference: 'hybrid', reason: 'fallback' })
  }
  return dedupeBy(plan, (item) => item.query).slice(0, 6)
}

// ---------------------------------------------------------------------------
// 三、域名与记录过滤（对应 nodes.py _is_bad_web_domain / _filter_*_records）
// ---------------------------------------------------------------------------

const BLOCKED_DOMAINS = ['datasheet', 'bdtic', 'doc88', 'elecfans', 'down', 'csdn.net/download']

export function isBadWebDomain(domain: string): boolean {
  const value = (domain ?? '').toLowerCase()
  return BLOCKED_DOMAINS.some((item) => value.includes(item))
}

export function isOfficialDomain(domain: string): boolean {
  const value = (domain ?? '').toLowerCase()
  if (!value) return false
  return (
    value.endsWith('.gov.cn') ||
    value.endsWith('.gov') ||
    value.endsWith('.edu.cn') ||
    value.endsWith('.edu') ||
    value.includes('.org.cn') ||
    value.includes('official')
  )
}

const MAINSTREAM_MEDIA = [
  'reuters',
  'bloomberg',
  'xinhuanet',
  'people.com',
  '36kr',
  'caixin',
  'yicai',
  'stcn',
  'eastmoney',
  'iresearch',
  'analysys',
  'qianzhan',
]

export function isMainstreamMedia(domain: string): boolean {
  const value = (domain ?? '').toLowerCase()
  return MAINSTREAM_MEDIA.some((item) => value.includes(item))
}

export interface FilterStats {
  raw_count: number
  kept_count: number
  dropped_irrelevant: number
  dropped_domain: number
  dropped_empty: number
  dropped_missing_doc: number
}

export function emptyFilterStats(): FilterStats {
  return {
    raw_count: 0,
    kept_count: 0,
    dropped_irrelevant: 0,
    dropped_domain: 0,
    dropped_empty: 0,
    dropped_missing_doc: 0,
  }
}

export function filterWebRecords(query: string, records: SourceRecord[]): { kept: SourceRecord[]; stats: FilterStats } {
  const stats = emptyFilterStats()
  stats.raw_count = records.length
  const kept: SourceRecord[] = []
  for (const record of records) {
    const title = asString(record.title, '')
    const snippet = asString(record.snippet, '')
    const domain = asString(record.domain, '')
    if (!title && !snippet) {
      stats.dropped_empty += 1
      continue
    }
    if (isBadWebDomain(domain)) {
      stats.dropped_domain += 1
      continue
    }
    const relevance = estimateRelevance(query, `${title}\n${snippet}`)
    record.relevance_score = relevance
    if (relevance < 0.2 && !isOfficialDomain(domain)) {
      stats.dropped_irrelevant += 1
      continue
    }
    kept.push(record)
  }
  stats.kept_count = kept.length
  return { kept, stats }
}

export function filterLocalRecords(query: string, records: SourceRecord[]): { kept: SourceRecord[]; stats: FilterStats } {
  const stats = emptyFilterStats()
  stats.raw_count = records.length
  const kept: SourceRecord[] = []
  for (const record of records) {
    const title = asString(record.title, '')
    const snippet = asString(record.snippet, '')
    const docId = asString(record.doc_id, '').trim()
    if (!snippet) {
      stats.dropped_empty += 1
      continue
    }
    const relevance = estimateRelevance(query, `${title}\n${snippet}`)
    record.relevance_score = relevance
    if (!docId && relevance < 0.35) {
      stats.dropped_missing_doc += 1
      continue
    }
    if (relevance < 0.2) {
      stats.dropped_irrelevant += 1
      continue
    }
    kept.push(record)
  }
  stats.kept_count = kept.length
  return { kept, stats }
}

// ---------------------------------------------------------------------------
// 四、证据可信度评分（对应 nodes.py _score_evidence）
// ---------------------------------------------------------------------------

export function scoreEvidence(record: {
  source_type?: SourceType | string
  domain?: string
}): { score: number; reason: string } {
  if (record.source_type === 'local') {
    return { score: 0.92, reason: '企业内部知识库证据，默认高可信' }
  }
  const domain = asString(record.domain, '').toLowerCase()
  if (isOfficialDomain(domain)) return { score: 0.88, reason: '官方或权威机构域名' }
  if (isMainstreamMedia(domain)) return { score: 0.72, reason: '主流媒体/研究机构域名' }
  if (domain) return { score: 0.58, reason: '普通互联网来源，需要交叉验证' }
  return { score: 0.45, reason: '来源信息不完整' }
}

export function normalizeEvidence(
  record: Partial<EvidenceItem> & { source_id: string },
): EvidenceItem {
  const { score, reason } = scoreEvidence({
    source_type: record.source_type ?? 'web',
    domain: record.domain,
  })
  return {
    source_id: record.source_id,
    source_type: (record.source_type ?? 'web') as SourceType,
    title: record.title ?? record.source_id,
    snippet: truncate(record.snippet ?? '', 800),
    url: record.url ?? '',
    doc_id: record.doc_id ?? '',
    domain: record.domain ?? '',
    supports_questions: record.supports_questions ?? [],
    reliability_score: record.reliability_score ?? score,
    reliability_reason: record.reliability_reason ?? reason,
    source_label: record.source_label ?? record.title ?? record.source_id,
    notes: record.notes ?? '',
  }
}

/** 把检索原文压成给 LLM 的精简 JSONL —— 原项目「信息剪枝」的关键一步 */
export function formatRawRecords(records: SourceRecord[], sourceType: SourceType, maxSnippet = 500): string {
  if (records.length === 0) return '[]'
  return records
    .slice(0, 40)
    .map((record) =>
      JSON.stringify({
        source_id: record.source_id,
        title: truncate(record.title ?? '', 120),
        url: record.url ?? '',
        doc_id: record.doc_id ?? '',
        snippet: truncate(record.snippet ?? '', maxSnippet),
        source_type: sourceType,
      }),
    )
    .join('\n')
}
