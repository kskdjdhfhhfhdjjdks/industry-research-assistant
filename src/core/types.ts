/**
 * 共享状态定义 —— 对应原项目 app/mult_agents/state.py 的 ResearchState。
 *
 * 迁移说明：
 * 1. 原版用 LangGraph 的 TypedDict + Annotated[list, operator.add] 做消息累加；
 *    浏览器版不存在跨进程序列化，状态就是一个普通的可变对象，节点返回 Partial 由引擎合并。
 * 2. 去掉了 LangChain 的 BaseMessage 列表（浏览器里不需要维护消息历史，
 *    改为用 llm_calls / token_usage 做可观测性统计），其余字段一一对应。
 */

export type IntentRoute = 'direct' | 'multiagent'
export type SourceType = 'web' | 'local'
export type Confidence = 'high' | 'medium' | 'low'

export type NodeId =
  | 'intent'
  | 'direct_answer'
  | 'plan'
  | 'web_search'
  | 'local_rag'
  | 'deep_dive'
  | 'analyze'
  | 'reflect'
  | 'write'
  | 'critic'

/** 检索层返回的原始记录 */
export interface SourceRecord {
  source_id: string
  title: string
  snippet: string
  source_type: SourceType
  url?: string
  doc_id?: string
  domain?: string
  published_at?: string
  section_id?: string
  search_query?: string
  relevance_score?: number
}

/** 证据池条目（经过 Scout 过滤 + Judge 评分） */
export interface EvidenceItem {
  source_id: string
  source_type: SourceType
  title: string
  snippet: string
  url?: string
  doc_id?: string
  domain?: string
  supports_questions?: string[]
  reliability_score?: number
  reliability_reason?: string
  source_label?: string
  notes?: string
}

export interface AuditFlag {
  type: 'low_confidence' | 'conflict' | 'missing_evidence' | string
  target: string
  reason: string
}

export interface Finding {
  claim_id: string
  claim: string
  confidence: Confidence
  source_ids: string[]
}

export interface ClaimMapItem {
  claim_id: string
  source_ids: string[]
}

export interface SourceIndexEntry {
  source_id: string
  label: string
  locator: string
  source_type: string
}

export interface OutlineSection {
  id: string
  title: string
  description: string
  section_type: string
  requires_data: boolean
  requires_chart: boolean
  priority: number
  search_queries: string[]
  status: string
}

export interface SearchPlanItem {
  section_id: string
  query: string
  source_preference: 'web' | 'local' | 'hybrid'
  reason: string
}

export interface ResearchBudget {
  max_rounds: number
  max_sources: number
  max_tokens: number
  max_seconds: number
}

export interface RetrievalStats {
  query_count: number
  raw_count: number
  kept_count: number
  dropped_count: number
}

export interface TraceRecord {
  source_id: string
  title: string
  locator: string
}

export interface QueryTrace {
  iteration: number
  plan_step: number
  query: string
  section_id: string
  reason: string
  source_preference: string
  raw_count: number
  raw_records: TraceRecord[]
  kept_source_ids: string[]
  rejected_source_ids: string[]
  kept_count: number
  rejected_count: number
  reject_reason?: string
}

/** 全局研究状态，等价于原项目的 ResearchState */
export interface ResearchState {
  query: string
  user_id: string
  tenant_id: string
  thread_id: string
  memory_context: string
  intent: IntentRoute | ''

  phase: string
  plan: string
  outline: OutlineSection[]
  sub_questions: string[]
  research_questions: string[]
  search_plan: SearchPlanItem[]
  budget: ResearchBudget

  web_search: string
  local_rag: string
  web_evidence: EvidenceItem[]
  local_evidence: EvidenceItem[]
  web_retrieval_stats: RetrievalStats
  local_retrieval_stats: RetrievalStats
  web_search_trace: QueryTrace[]
  local_rag_trace: QueryTrace[]

  deep_dive: string
  audit: string
  evidence_pool: EvidenceItem[]
  audit_flags: AuditFlag[]
  source_index: SourceIndexEntry[]

  analysis: string
  findings: Finding[]
  claim_map: ClaimMapItem[]
  needs_more_research: boolean
  missing_gaps: string[]
  supplementary_queries: SearchPlanItem[]

  draft: string
  final: string

  /** 研报质检结果（对原项目的增量：生成后再做一轮结构化自评） */
  critique: CritiqueReport | null

  iteration: number
  max_iterations: number

  started_at: number
  elapsed_ms: number
  llm_calls: number
  input_tokens: number
  output_tokens: number
}

export interface CritiqueIssue {
  type: string
  target: string
  detail: string
  severity: 'high' | 'medium' | 'low'
}

export interface CritiqueReport {
  score: number
  verdict: string
  issues: CritiqueIssue[]
  rewrite_hints: string[]
}

export interface RunOptions {
  query: string
  user_id: string
  tenant_id: string
  thread_id: string
  max_iterations: number
  memory_context?: string
}

function emptyStats(): RetrievalStats {
  return { query_count: 0, raw_count: 0, kept_count: 0, dropped_count: 0 }
}

export function createInitialState(options: RunOptions): ResearchState {
  return {
    query: options.query,
    user_id: options.user_id,
    tenant_id: options.tenant_id,
    thread_id: options.thread_id,
    memory_context: options.memory_context ?? '',
    intent: '',

    phase: 'initialized',
    plan: '',
    outline: [],
    sub_questions: [],
    research_questions: [],
    search_plan: [],
    budget: { max_rounds: 2, max_sources: 16, max_tokens: 16000, max_seconds: 240 },

    web_search: '',
    local_rag: '',
    web_evidence: [],
    local_evidence: [],
    web_retrieval_stats: emptyStats(),
    local_retrieval_stats: emptyStats(),
    web_search_trace: [],
    local_rag_trace: [],

    deep_dive: '',
    audit: '',
    evidence_pool: [],
    audit_flags: [],
    source_index: [],

    analysis: '',
    findings: [],
    claim_map: [],
    needs_more_research: false,
    missing_gaps: [],
    supplementary_queries: [],

    draft: '',
    final: '',
    critique: null,

    iteration: 0,
    max_iterations: options.max_iterations,

    started_at: Date.now(),
    elapsed_ms: 0,
    llm_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
  }
}

/** 一次运行的完整事件流，供 UI 逐帧消费 */
export type AgentEvent =
  | { type: 'node_start'; node: NodeId; label: string; iteration: number }
  | { type: 'node_done'; node: NodeId; summary: string; iteration: number; ms: number }
  | { type: 'token'; node: NodeId; text: string }
  | { type: 'log'; node: NodeId | 'system'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'stats'; patch: Partial<ResearchState> }
  | {
      type: 'usage'
      node: NodeId
      promptTokens: number
      completionTokens: number
      ms: number
      channel: string
      model: string
    }
  | { type: 'error'; message: string }
