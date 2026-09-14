/**
 * 节点层 —— 迁移自原项目 app/mult_agents/nodes.py。
 *
 * 与原版的对应关系：
 *   intent_node        ← 意图路由（规则引擎 + 模型双模态）
 *   direct_answer_node ← 快速回答（流式）
 *   plan_node          ← 任务规划 + 检索计划派生
 *   web_search_node    ← 网络侦察（检索 → 代码剪枝 → 模型结构化抽取）
 *   local_rag_node     ← 本地知识库侦察
 *   deep_dive_node     ← 证据裁判（去重、评分、冲突审计）
 *   analyze_node       ← 分析归纳 + 完备性评估
 *   reflect_node       ← 反思补搜（迭代入口）
 *   write_node         ← 研报撰写 + 引用校验
 *   critic_node        ← 新增：研报质检（原项目没有的增量环节）
 *
 * 关键工程决策：
 * 1. 检索由「代码」完成，而不是让模型自己调工具。
 *    这样能做确定性的剪枝与去重，token 消耗降低一个量级，而且链路可回放。
 * 2. 所有结构化节点都强制走 JSON + 容错解析 + 代码侧白名单校验，
 *    绝不信任模型返回的 source_id。
 */

import { PROMPTS } from './prompts'
import { chat, chatJson } from './llm'
import { demoLlm, demoSearch } from './demo'
import { webSearch } from './search'
import { searchKnowledge, toSourceRecords } from './knowledge'
import {
  deriveSearchPlan,
  detectIntent,
  emptyFilterStats,
  filterLocalRecords,
  filterWebRecords,
  formatRawRecords,
  guessPrimaryEntity,
  normalizeEvidence,
  scoreEvidence,
} from './heuristics'
import {
  asBoolean,
  asNumber,
  asRecord,
  asRecordArray,
  asString,
  asStringArray,
  dedupeBy,
  estimateTokens,
  parseJsonLoose,
  sleep,
  truncate,
} from './utils'
import { ensureReferenceSection, renderExecutionAppendix, validateAndFixCitations } from './citations'
import { appendTurn, withMemoryContext } from './memory'
import type { NodeContext } from './graph'
import type { AppSettings } from './config'
import type {
  CritiqueReport,
  EvidenceItem,
  Finding,
  NodeId,
  OutlineSection,
  QueryTrace,
  ResearchBudget,
  ResearchState,
  RetrievalStats,
  SearchPlanItem,
  SourceIndexEntry,
  SourceRecord,
  TraceRecord,
} from './types'

export interface NodeDeps {
  settings: AppSettings
  demoMode: boolean
}

function emptyStats(): RetrievalStats {
  return { query_count: 0, raw_count: 0, kept_count: 0, dropped_count: 0 }
}

const TEMPERATURE: Record<string, number> = {
  intent: 0.0,
  direct_answer: 0.3,
  plan: 0.3,
  web_search: 0.4,
  local_rag: 0.4,
  deep_dive: 0.2,
  analyze: 0.3,
  reflect: 0.3,
  write: 0.5,
  critic: 0.1,
}

// ---------------------------------------------------------------------------
// 模型调用包装：统一处理「演示模式 / 真实模式 + 用量上报 + 节奏控制」
// ---------------------------------------------------------------------------

function pace(signal: AbortSignal, ms: number): Promise<void> {
  return sleep(ms, signal)
}

async function runStructured<T extends object>(
  deps: NodeDeps,
  ctx: NodeContext,
  node: NodeId,
  promptKey: string,
  userPrompt: string,
  fallback: T,
): Promise<{ data: Record<string, unknown>; text: string }> {
  const messages = [
    { role: 'system' as const, content: PROMPTS[promptKey] ?? '' },
    { role: 'user' as const, content: userPrompt },
  ]
  const started = Date.now()

  if (deps.demoMode) {
    await pace(ctx.signal, 200 + Math.floor(Math.random() * 260))
    const result = demoLlm({ messages, label: node })
    ctx.emit({
      type: 'usage',
      node,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      ms: Date.now() - started,
      channel: 'demo',
      model: result.model,
    })
    return { data: asRecord(parseJsonLoose(result.text, fallback)), text: result.text }
  }

  const { data, raw, result } = await chatJson(
    { messages, label: node, temperature: TEMPERATURE[node] ?? 0.3, signal: ctx.signal },
    deps.settings,
    fallback,
  )
  ctx.emit({
    type: 'usage',
    node,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    ms: Date.now() - started,
    channel: result.channel,
    model: result.model,
  })
  return { data: asRecord(data), text: raw }
}

async function runFreeform(
  deps: NodeDeps,
  ctx: NodeContext,
  node: NodeId,
  promptKey: string,
  userPrompt: string,
): Promise<{ text: string }> {
  const messages = [
    { role: 'system' as const, content: PROMPTS[promptKey] ?? '' },
    { role: 'user' as const, content: userPrompt },
  ]
  const started = Date.now()

  if (deps.demoMode) {
    const result = demoLlm({ messages, label: node })
    // 演示模式也逐字输出，让流式渲染这条链路真实可见
    const chunkSize = node === 'write' ? 18 : 6
    for (let i = 0; i < result.text.length; i += chunkSize) {
      if (ctx.signal.aborted) throw new DOMException('运行已取消', 'AbortError')
      ctx.emit({ type: 'token', node, text: result.text.slice(i, i + chunkSize) })
      await pace(ctx.signal, node === 'write' ? 14 : 8)
    }
    ctx.emit({
      type: 'usage',
      node,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      ms: Date.now() - started,
      channel: 'demo',
      model: result.model,
    })
    return { text: result.text }
  }

  const result = await chat(
    {
      messages,
      label: node,
      temperature: TEMPERATURE[node] ?? 0.3,
      stream: true,
      signal: ctx.signal,
      onToken: (delta) => ctx.emit({ type: 'token', node, text: delta }),
    },
    deps.settings,
  )
  ctx.emit({
    type: 'usage',
    node,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    ms: Date.now() - started,
    channel: result.channel,
    model: result.model,
  })
  return { text: result.text }
}

// ---------------------------------------------------------------------------
// 公共小工具（对应 nodes.py 里的一堆下划线私有函数）
// ---------------------------------------------------------------------------

function assignSourceIds(records: SourceRecord[], prefix: string): SourceRecord[] {
  return records.map((record, index) => ({ ...record, source_id: `${prefix}-${index + 1}` }))
}

function summarizeRecords(records: SourceRecord[]): TraceRecord[] {
  return records.slice(0, 5).map((record) => ({
    source_id: record.source_id,
    title: record.title,
    locator: record.url || record.doc_id || '',
  }))
}

function buildQueries(state: ResearchState, preference: 'web' | 'local', limit: number): SearchPlanItem[] {
  const iteration = state.iteration ?? 0
  const base =
    iteration > 0 && (state.supplementary_queries?.length ?? 0) > 0
      ? state.supplementary_queries
      : state.search_plan ?? []
  const picked = base.filter((item) => {
    const pref = item.source_preference ?? 'hybrid'
    return pref === preference || pref === 'hybrid'
  })
  if (picked.length === 0) {
    return [{ section_id: 'sec_1', query: state.query, source_preference: preference, reason: 'fallback' }]
  }
  return picked.slice(0, limit)
}

function pruneEvidenceToAllowed(evidence: EvidenceItem[], allowed: Set<string>): EvidenceItem[] {
  return evidence.filter((item) => {
    const id = asString(item.source_id, '').trim()
    return id && allowed.has(id)
  })
}

function enrichEvidenceFromRaw(evidence: EvidenceItem[], rawRecords: SourceRecord[]): EvidenceItem[] {
  const lookup = new Map<string, SourceRecord>()
  for (const record of rawRecords) {
    const id = asString(record.source_id, '').trim()
    if (id) lookup.set(id, record)
  }
  return evidence.map((item) => {
    const raw = lookup.get(asString(item.source_id, '').trim())
    if (!raw) return item
    return {
      ...item,
      title: item.title || raw.title,
      url: item.url || raw.url || '',
      domain: item.domain || raw.domain || '',
      doc_id: item.doc_id || raw.doc_id || '',
      snippet: item.snippet || raw.snippet,
      source_type: item.source_type || raw.source_type,
    }
  })
}

function finalizeTraces(
  traces: QueryTrace[],
  keptIds: Set<string>,
  rejectedIds: string[],
  rejectReason: string,
): QueryTrace[] {
  const rejected = new Set(rejectedIds.map((item) => asString(item).trim()))
  return traces.map((trace) => {
    const raw = trace.raw_records ?? []
    const kept = raw.filter((item) => keptIds.has(asString(item.source_id).trim()))
    const rejectedRecords = raw.filter((item) => {
      const id = asString(item.source_id).trim()
      return rejected.has(id) || !keptIds.has(id)
    })
    return {
      ...trace,
      kept_source_ids: kept.map((item) => item.source_id),
      rejected_source_ids: rejectedRecords.map((item) => item.source_id),
      kept_count: kept.length,
      rejected_count: rejectedRecords.length,
      reject_reason: rejectReason || undefined,
    }
  })
}

/** 证据抽取的通用实现：Scout 节点（网络 / 本地）共用 */
async function scoutExtract(
  deps: NodeDeps,
  ctx: NodeContext,
  node: 'web_search' | 'local_rag',
  state: ResearchState,
  rawRecords: SourceRecord[],
  sourceLabel: string,
): Promise<{ evidence: EvidenceItem[]; summary: string; text: string; rejectedIds: string[]; rejectReason: string }> {
  const fallback = {
    summary: `完成${sourceLabel}证据采集。`,
    evidence: rawRecords.slice(0, 12).map((record) => normalizeEvidence({
      source_id: record.source_id,
      source_type: record.source_type,
      title: record.title,
      snippet: record.snippet,
      url: record.url,
      doc_id: record.doc_id,
      domain: record.domain,
    })),
    gaps: [],
    rejected_source_ids: [],
    reject_reason: '',
  }

  const userPrompt = [
    `请基于以下${sourceLabel}原始证据整理结构化 JSON。`,
    `原问题：${state.query}`,
    `子问题：${JSON.stringify(state.sub_questions ?? [])}`,
    `原始证据：`,
    formatRawRecords(rawRecords, node === 'web_search' ? 'web' : 'local'),
  ].join('\n')

  const { data, text } = await runStructured(deps, ctx, node, node, userPrompt, fallback)

  const allowed = new Set(rawRecords.map((record) => asString(record.source_id).trim()).filter(Boolean))
  const rawEvidence = asRecordArray(data.evidence)
  let evidence: EvidenceItem[] = rawEvidence.map((item) =>
    normalizeEvidence({
      source_id: asString(item.source_id).trim(),
      source_type: node === 'web_search' ? 'web' : 'local',
      title: asString(item.title, ''),
      snippet: asString(item.snippet, ''),
      url: asString(item.url, ''),
      doc_id: asString(item.doc_id, ''),
      domain: asString(item.domain, ''),
      supports_questions: asStringArray(item.supports_questions),
      notes: asString(item.notes, ''),
    }),
  )
  evidence = pruneEvidenceToAllowed(evidence, allowed)
  evidence = enrichEvidenceFromRaw(evidence, rawRecords)
  if (evidence.length === 0) {
    evidence = fallback.evidence.filter((item) => allowed.has(item.source_id))
  }

  return {
    evidence,
    summary: asString(data.summary, fallback.summary),
    text,
    rejectedIds: asStringArray(data.rejected_source_ids),
    rejectReason: asString(data.reject_reason, ''),
  }
}

// ---------------------------------------------------------------------------
// 节点实现
// ---------------------------------------------------------------------------

function fallbackPlan(state: ResearchState) {
  return {
    objective: state.query,
    sub_questions: [state.query],
    outline: [
      {
        id: 'sec_1',
        title: '综合概览',
        description: '默认生成的大纲章节',
        section_type: 'mixed',
        requires_data: false,
        requires_chart: false,
        priority: 1,
        search_queries: [state.query],
        status: 'pending',
      },
    ],
    research_questions: [state.query],
    budget: { max_rounds: 2, max_sources: 12, max_tokens: 12000, max_seconds: 180 },
  }
}

function intentNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const ruleRoute = detectIntent(state.query)
    const userPrompt = [
      `用户问题：${state.query}`,
      `规则引擎初判：${ruleRoute}`,
      '请输出 JSON：{"route":"direct|multiagent","reason":"..."}',
    ].join('\n')
    const { data } = await runStructured(deps, ctx, 'intent', 'intent_router', userPrompt, {
      route: ruleRoute,
      reason: 'rule',
    })
    let route = asString(data.route, ruleRoute).trim().toLowerCase()
    if (route !== 'direct' && route !== 'multiagent') route = ruleRoute
    ctx.emit({
      type: 'log',
      node: 'intent',
      level: 'info',
      message: `规则引擎判定=${ruleRoute}，模型判定=${route}${route === ruleRoute ? '（一致）' : '（模型修正）'}`,
    })
    return { intent: route as ResearchState['intent'], phase: 'routed' }
  }
}

function directAnswerNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const userPrompt = withMemoryContext(state, `用户问题：${state.query}`)
    const { text } = await runFreeform(deps, ctx, 'direct_answer', 'direct_answer', userPrompt)
    const content = text.trim()
    return {
      intent: 'direct',
      final: content,
      draft: content,
      analysis: content,
      needs_more_research: false,
      phase: 'direct_answered',
    }
  }
}

function planNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const fallback = fallbackPlan(state)
    const userPrompt = `用户需求：${state.query}\n请先做大纲与问题拆解，再输出规划 JSON。`
    const { data } = await runStructured(deps, ctx, 'plan', 'plan', withMemoryContext(state, userPrompt), fallback)

    const outlineRaw = asRecordArray(data.outline ?? fallback.outline)
    const outline: OutlineSection[] = outlineRaw.map((item, index) => ({
      id: asString(item.id, `sec_${index + 1}`),
      title: asString(item.title, `章节 ${index + 1}`),
      description: asString(item.description, ''),
      section_type: asString(item.section_type, 'mixed'),
      requires_data: asBoolean(item.requires_data, false),
      requires_chart: asBoolean(item.requires_chart, false),
      priority: asNumber(item.priority, index + 1),
      search_queries: asStringArray(item.search_queries, 4),
      status: asString(item.status, 'pending'),
    }))
    const sections = outline.length > 0 ? outline : (fallback.outline as OutlineSection[])

    const subQuestions = asStringArray(data.sub_questions).length
      ? asStringArray(data.sub_questions)
      : [state.query]
    const researchQuestions = asStringArray(data.research_questions).length
      ? asStringArray(data.research_questions)
      : subQuestions
    const budgetRaw = asRecord(data.budget)
    const budget: ResearchBudget = {
      max_rounds: asNumber(budgetRaw.max_rounds, fallback.budget.max_rounds),
      max_sources: asNumber(budgetRaw.max_sources, fallback.budget.max_sources),
      max_tokens: asNumber(budgetRaw.max_tokens, fallback.budget.max_tokens),
      max_seconds: asNumber(budgetRaw.max_seconds, fallback.budget.max_seconds),
    }

    const searchPlan = deriveSearchPlan(sections, state.query)
    const entity = guessPrimaryEntity(state.query)
    ctx.emit({
      type: 'log',
      node: 'plan',
      level: 'info',
      message: `拆解出 ${subQuestions.length} 个子问题、${sections.length} 个章节，派生 ${searchPlan.length} 条检索词${entity ? `（核心实体：${entity}）` : ''}`,
    })

    return {
      phase: 'planned',
      plan: asString(data.objective, state.query),
      outline: sections,
      sub_questions: subQuestions,
      research_questions: researchQuestions,
      search_plan: searchPlan,
      budget,
      iteration: 0,
    }
  }
}

function webSearchNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const limit = deps.demoMode ? 3 : 5
    const queries = buildQueries(state, 'web', limit)
    const iteration = state.iteration ?? 0
    const prefix = `WEB${iteration + 1}`
    const traces: QueryTrace[] = [...(state.web_search_trace ?? [])]
    const rawRecords: SourceRecord[] = []
    const stats: RetrievalStats = { ...emptyStats(), ...(state.web_retrieval_stats ?? {}) }

    const responses = await Promise.all(
      queries.map(async (item, index) => {
        if (deps.demoMode) {
          return { item, index, records: demoSearch(item.query, 4), status: 'ok' as const, message: '演示语料' }
        }
        const response = await webSearch(item.query, { count: 4, signal: ctx.signal })
        return { item, index, records: response.records, status: response.status, message: response.message }
      }),
    )

    const statusMessages = new Set<string>()
    for (const { item, index, records, status, message } of responses) {
      if (status !== 'ok' && message) statusMessages.add(message)
      const assigned = assignSourceIds(records, `${prefix}_${index + 1}`).map((record) => ({
        ...record,
        section_id: item.section_id,
        search_query: item.query,
      }))
      rawRecords.push(...assigned)
      traces.push({
        iteration,
        plan_step: index + 1,
        query: item.query,
        section_id: item.section_id,
        reason: item.reason,
        source_preference: item.source_preference,
        raw_count: assigned.length,
        raw_records: summarizeRecords(assigned),
        kept_source_ids: [],
        rejected_source_ids: [],
        kept_count: 0,
        rejected_count: 0,
      })
    }

    const deduped = dedupeBy(rawRecords, (record) => `${record.url}|${record.title}`).filter(
      (record) => record.title || record.snippet || record.url,
    )

    stats.query_count = (stats.query_count ?? 0) + queries.length
    stats.raw_count = (stats.raw_count ?? 0) + deduped.length

    if (deduped.length === 0) {
      const note = statusMessages.size > 0 ? Array.from(statusMessages).join('；') : '未检索到可用网页证据'
      ctx.emit({ type: 'log', node: 'web_search', level: 'warn', message: note })
      return {
        web_search: `未检索到可用网页证据：${note}`,
        web_evidence: state.web_evidence ?? [],
        web_retrieval_stats: stats,
        web_search_trace: traces,
        phase: 'web_empty',
      }
    }

    // 代码侧相关性剪枝：明显无关的直接不进入模型上下文，显著降低 token 消耗
    const { kept, stats: filterStats } = filterWebRecords(state.query, deduped)
    let finalRecords = kept
    if (kept.length === 0) {
      finalRecords = [...deduped]
        .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
        .slice(0, 8)
      ctx.emit({
        type: 'log',
        node: 'web_search',
        level: 'warn',
        message: '相关性阈值过滤后为空，已退化为按相关性取 Top-N，避免证据断供',
      })
    } else {
      ctx.emit({
        type: 'log',
        node: 'web_search',
        level: 'info',
        message: `候选 ${filterStats.raw_count} 条 → 保留 ${filterStats.kept_count} 条（丢弃：无关 ${filterStats.dropped_irrelevant}、黑名单域名 ${filterStats.dropped_domain}、空内容 ${filterStats.dropped_empty}）`,
      })
    }

    const { evidence, summary, rejectedIds, rejectReason } = await scoutExtract(
      deps,
      ctx,
      'web_search',
      state,
      finalRecords.slice(0, 40),
      '网页',
    )

    stats.kept_count = (stats.kept_count ?? 0) + evidence.length
    stats.dropped_count = (stats.dropped_count ?? 0) + Math.max(finalRecords.length - evidence.length, 0)

    const keptIds = new Set(evidence.map((item) => item.source_id))
    const finalized = finalizeTraces(traces, keptIds, rejectedIds, rejectReason)

    return {
      web_search: summary,
      web_evidence: [...(state.web_evidence ?? []), ...evidence],
      web_retrieval_stats: stats,
      web_search_trace: finalized,
      phase: 'web_done',
    }
  }
}

function localRagNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const limit = deps.demoMode ? 2 : 4
    const queries = buildQueries(state, 'local', limit)
    const iteration = state.iteration ?? 0
    const prefix = `LOC${iteration + 1}`
    const traces: QueryTrace[] = [...(state.local_rag_trace ?? [])]
    const rawRecords: SourceRecord[] = []
    const stats = { ...(state.local_retrieval_stats ?? emptyFilterStats()) }

    for (let index = 0; index < queries.length; index += 1) {
      const item = queries[index]
      let hits: SourceRecord[] = []
      try {
        const found = await searchKnowledge(item.query, {
          userId: state.user_id,
          limit: 4,
          semantic: deps.settings.semanticEmbedding,
        })
        hits = toSourceRecords(found)
      } catch (error) {
        ctx.emit({
          type: 'log',
          node: 'local_rag',
          level: 'warn',
          message: `本地检索失败：${error instanceof Error ? error.message : String(error)}`,
        })
        hits = []
      }
      const assigned = assignSourceIds(hits, `${prefix}_${index + 1}`).map((record) => ({
        ...record,
        section_id: item.section_id,
        search_query: item.query,
      }))
      rawRecords.push(...assigned)
      traces.push({
        iteration,
        plan_step: index + 1,
        query: item.query,
        section_id: item.section_id,
        reason: item.reason,
        source_preference: item.source_preference,
        raw_count: assigned.length,
        raw_records: summarizeRecords(assigned),
        kept_source_ids: [],
        rejected_source_ids: [],
        kept_count: 0,
        rejected_count: 0,
      })
    }

    const deduped = dedupeBy(rawRecords, (record) => `${record.doc_id}|${record.snippet}`)
    stats.query_count = (stats.query_count ?? 0) + queries.length
    stats.raw_count = (stats.raw_count ?? 0) + deduped.length

    if (deduped.length === 0) {
      ctx.emit({
        type: 'log',
        node: 'local_rag',
        level: 'info',
        message: '本地知识库暂无命中（可在侧栏导入文档后重试），本轮只使用网络证据',
      })
      return {
        local_rag: '本地知识库暂无命中，已跳过本地上下文注入。',
        local_evidence: state.local_evidence ?? [],
        local_retrieval_stats: stats,
        local_rag_trace: traces,
        phase: 'local_empty',
      }
    }

    const { kept } = filterLocalRecords(state.query, deduped)
    const finalRecords = kept.length > 0 ? kept : deduped.slice(0, 12)

    const { evidence, summary, rejectedIds, rejectReason } = await scoutExtract(
      deps,
      ctx,
      'local_rag',
      state,
      finalRecords.slice(0, 30),
      '本地知识库',
    )

    stats.kept_count = (stats.kept_count ?? 0) + evidence.length
    stats.dropped_count = (stats.dropped_count ?? 0) + Math.max(finalRecords.length - evidence.length, 0)

    const keptIds = new Set(evidence.map((item) => item.source_id))
    const finalized = finalizeTraces(traces, keptIds, rejectedIds, rejectReason)

    return {
      local_rag: summary,
      local_evidence: [...(state.local_evidence ?? []), ...evidence],
      local_retrieval_stats: stats,
      local_rag_trace: finalized,
      phase: 'local_done',
    }
  }
}

function deepDiveNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const web = state.web_evidence ?? []
    const local = state.local_evidence ?? []
    if (web.length === 0 && local.length === 0) {
      ctx.emit({ type: 'log', node: 'deep_dive', level: 'warn', message: '无任何证据可供裁判，跳过评分环节' })
      return { phase: 'audit_skipped' }
    }

    const rawEvidence = [...web, ...local]
    const fallback = {
      summary: `完成 ${rawEvidence.length} 条证据的评分与审计。`,
      evidence_pool: rawEvidence.map((item) =>
        normalizeEvidence({
          source_id: item.source_id,
          source_type: item.source_type,
          title: item.title,
          snippet: item.snippet,
          url: item.url,
          doc_id: item.doc_id,
          domain: item.domain,
          supports_questions: item.supports_questions,
        }),
      ),
      audit_flags: [],
      source_index: rawEvidence.map((item) => ({
        source_id: item.source_id,
        label: item.title,
        locator: item.url || item.doc_id || '',
        source_type: item.source_type,
      })),
    }

    const userPrompt = [
      '请对 web 与 local 证据进行评分、去重、冲突审计，并只输出 JSON。',
      `问题：${state.query}`,
      `子问题：${JSON.stringify(state.sub_questions ?? [])}`,
      `web_evidence：${JSON.stringify(web.map((item) => ({ ...item, snippet: truncate(item.snippet, 400) })))}`,
      `local_evidence：${JSON.stringify(local.map((item) => ({ ...item, snippet: truncate(item.snippet, 400) })))}`,
    ].join('\n')

    const { data } = await runStructured(deps, ctx, 'deep_dive', 'deep_dive', userPrompt, fallback)

    const allowed = new Set(rawEvidence.map((item) => asString(item.source_id).trim()).filter(Boolean))
    let evidencePool: EvidenceItem[] = asRecordArray(data.evidence_pool)
      .map((item) =>
        normalizeEvidence({
          source_id: asString(item.source_id).trim(),
          source_type: (asString(item.source_type, 'web') === 'local' ? 'local' : 'web') as 'web' | 'local',
          title: asString(item.title, ''),
          snippet: asString(item.snippet, ''),
          url: asString(item.url, ''),
          doc_id: asString(item.doc_id, ''),
          domain: asString(item.domain, ''),
          supports_questions: asStringArray(item.supports_questions),
          reliability_score: asNumber(item.reliability_score, NaN),
          reliability_reason: asString(item.reliability_reason, ''),
          source_label: asString(item.source_label, ''),
        }),
      )
      .filter((item) => item.source_id && allowed.has(item.source_id))

    // 模型漏掉的证据由代码补齐，保证「检索到的都能被审计」
    const existing = new Set(evidencePool.map((item) => item.source_id))
    for (const record of rawEvidence) {
      const id = asString(record.source_id).trim()
      if (!id || existing.has(id)) continue
      const { score, reason } = scoreEvidence(record)
      evidencePool.push(
        normalizeEvidence({
          ...record,
          source_id: id,
          reliability_score: score,
          reliability_reason: reason,
        }),
      )
      existing.add(id)
    }

    const warnings = evidencePool.filter((item) => (item.reliability_score ?? 0) < 0.6)
    const auditFlagsRaw = asRecordArray(data.audit_flags)
    const auditFlags = auditFlagsRaw.map((item) => ({
      type: asString(item.type, 'low_confidence'),
      target: asString(item.target, ''),
      reason: asString(item.reason, ''),
    }))
    if (auditFlags.length === 0 && warnings.length > 0) {
      auditFlags.push({
        type: 'low_confidence',
        target: `${warnings.length} 条来源`,
        reason: '存在评分低于 0.6 的来源，引用时需交叉验证',
      })
    }

    const sourceIndex: SourceIndexEntry[] = dedupeBy(
      evidencePool.map((item) => ({
        source_id: item.source_id,
        label: item.title || item.source_label || item.source_id,
        locator: item.url || item.doc_id || '',
        source_type: item.source_type,
      })),
      (item) => item.source_id,
    )

    const high = evidencePool.filter((item) => (item.reliability_score ?? 0) >= 0.8).length
    ctx.emit({
      type: 'log',
      node: 'deep_dive',
      level: 'info',
      message: `证据池 ${evidencePool.length} 条（高可信 ${high} 条），审计标记 ${auditFlags.length} 项`,
    })

    return {
      deep_dive: asString(data.summary, fallback.summary),
      audit: asString(data.summary, fallback.summary),
      evidence_pool: evidencePool,
      audit_flags: auditFlags,
      source_index: sourceIndex,
      phase: 'audited',
    }
  }
}

function analyzeNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const fallback = {
      analysis_summary: '默认分析结论',
      needs_more_research: false,
      missing_gaps: [],
      findings: [],
      claim_map: [],
      next_actions: [],
    }
    const userPrompt = [
      '请基于证据池输出结论映射 JSON，并评估证据完备性：',
      `原问题：${state.query}`,
      `子问题：${JSON.stringify(state.sub_questions ?? [])}`,
      `证据池：${JSON.stringify((state.evidence_pool ?? []).map((item) => ({ ...item, snippet: truncate(item.snippet, 400) })))}`,
      `审计标记：${JSON.stringify(state.audit_flags ?? [])}`,
    ].join('\n')

    const { data } = await runStructured(deps, ctx, 'analyze', 'analyze', userPrompt, fallback)

    const allowed = new Set((state.evidence_pool ?? []).map((item) => asString(item.source_id).trim()))
    const findings: Finding[] = asRecordArray(data.findings).map((item, index) => {
      const sourceIds = asStringArray(item.source_ids).filter((id) => allowed.has(id))
      const confidenceRaw = asString(item.confidence, 'low').toLowerCase()
      const confidence = confidenceRaw === 'high' || confidenceRaw === 'medium' ? confidenceRaw : 'low'
      return {
        claim_id: asString(item.claim_id, `c_${index + 1}`),
        claim: asString(item.claim, ''),
        confidence: sourceIds.length === 0 ? 'low' : confidence,
        source_ids: sourceIds,
      }
    })

    const claimMap = findings.map((item) => ({ claim_id: item.claim_id, source_ids: item.source_ids }))
    const missingGaps = asStringArray(data.missing_gaps, 8)
    let needsMore = asBoolean(data.needs_more_research, false)
    const iteration = state.iteration ?? 0
    const maxIterations = state.max_iterations ?? 2
    if (iteration >= maxIterations) {
      if (needsMore) {
        ctx.emit({
          type: 'log',
          node: 'analyze',
          level: 'info',
          message: `已达最大补搜轮次（${maxIterations}），强制收束进入撰写`,
        })
      }
      needsMore = false
    }
    if (needsMore && findings.every((item) => item.source_ids.length === 0)) {
      needsMore = false
      ctx.emit({
        type: 'log',
        node: 'analyze',
        level: 'warn',
        message: '证据无法支撑任何结论，但继续补搜收益有限，改为强制撰写并显式标注不确定性',
      })
    }

    const unsupported = findings.filter((item) => item.source_ids.length === 0).length
    ctx.emit({
      type: 'log',
      node: 'analyze',
      level: 'info',
      message: `产出 ${findings.length} 条结论（无引用支撑 ${unsupported} 条），完备性判定=${needsMore ? '证据不足，需补搜' : '证据充分'}`,
    })

    return {
      analysis: asString(data.analysis_summary, ''),
      findings,
      claim_map: claimMap,
      needs_more_research: needsMore,
      missing_gaps: missingGaps,
      phase: needsMore ? 'analysis_gap_found' : 'analyzed',
    }
  }
}

function reflectNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const fallbackQueries: SearchPlanItem[] = [
      { section_id: 'gap_1', query: state.query, source_preference: 'hybrid', reason: 'fallback' },
    ]
    const fallback = {
      reflection_summary: '默认补搜计划',
      supplementary_queries: fallbackQueries,
    }
    const userPrompt = [
      '分析师指出当前证据不足以完全回答问题，存在以下信息缺口：',
      JSON.stringify(state.missing_gaps ?? []),
      '',
      `原问题：${state.query}`,
      `子问题：${JSON.stringify(state.sub_questions ?? [])}`,
      `已执行过的搜索计划：${JSON.stringify(state.search_plan ?? [])}`,
      `已执行过的补搜计划：${JSON.stringify(state.supplementary_queries ?? [])}`,
      '',
      '请生成新的补搜计划以填补缺口。',
    ].join('\n')

    const { data } = await runStructured(deps, ctx, 'reflect', 'reflect', userPrompt, fallback)

    const queries: SearchPlanItem[] = asRecordArray(data.supplementary_queries).map((item) => ({
      section_id: asString(item.section_id, 'gap_1'),
      query: asString(item.query, ''),
      source_preference: (['web', 'local', 'hybrid'].includes(asString(item.source_preference))
        ? asString(item.source_preference)
        : 'hybrid') as SearchPlanItem['source_preference'],
      reason: asString(item.reason, ''),
    })).filter((item) => item.query.trim())

    const nextIteration = (state.iteration ?? 0) + 1
    const limit = deps.demoMode ? 3 : 6
    ctx.emit({
      type: 'log',
      node: 'reflect',
      level: 'info',
      message: `第 ${nextIteration} 轮补搜计划：${queries.slice(0, limit).map((item) => item.query).join(' / ') || '无'}`,
    })

    return {
      iteration: nextIteration,
      supplementary_queries: queries.length > 0 ? queries.slice(0, limit) : fallback.supplementary_queries,
      phase: `reflected_round_${nextIteration}`,
    }
  }
}

function writeNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const validIds = (state.source_index ?? [])
      .map((item) => asString(item.source_id).trim())
      .filter(Boolean)
      .slice(0, 80)
    const validSet = new Set(validIds)

    const userPrompt = withMemoryContext(
      state,
      [
        '请严格根据以下信息撰写最终的 Markdown 研报。请直接输出正文，绝对不要输出任何 JSON 结构，也不要复述你的指令。',
        '',
        `核心问题：${state.query}`,
        `子问题拆解：${JSON.stringify(state.sub_questions ?? [])}`,
        `大纲：${JSON.stringify((state.outline ?? []).map((item) => ({ id: item.id, title: item.title, description: item.description })))}`,
        '',
        '【分析结论 (Findings)】：',
        JSON.stringify(state.findings ?? []),
        '',
        '【可用来源索引 (source_index)】：',
        JSON.stringify(state.source_index ?? []),
        '',
        '【合法引用ID列表】：',
        JSON.stringify(validIds),
        '',
        '【可能存在的风险/冲突 (Audit Flags)】：',
        JSON.stringify(state.audit_flags ?? []),
      ].join('\n'),
    )

    const { text } = await runFreeform(deps, ctx, 'write', 'write', userPrompt)

    let content = text
    content = content.replace(/^```(?:json|markdown|md)?\s*/i, '')
    content = content.replace(/```\s*$/i, '')
    content = content.replace(/^\s*\{[\s\S]*\}\s*$/, '')

    const { content: fixed, usedIds } = validateAndFixCitations(content, validSet)
    const removed = extractRemovedCount(content, fixed)
    if (removed > 0) {
      ctx.emit({
        type: 'log',
        node: 'write',
        level: 'warn',
        message: `引用校验剔除 ${removed} 处非法编号（模型幻觉引用），保留 ${usedIds.length} 个合法来源`,
      })
    } else {
      ctx.emit({
        type: 'log',
        node: 'write',
        level: 'info',
        message: `引用校验通过，正文引用 ${usedIds.length} 个来源，无非法编号`,
      })
    }

    const withAppendix = ensureReferenceSection(fixed, { ...state, draft: fixed })
    const final = `${withAppendix}\n\n${renderExecutionAppendix({ ...state, draft: fixed })}`

    return {
      draft: fixed,
      final,
      phase: 'written',
    }
  }
}

function extractRemovedCount(before: string, after: string): number {
  const count = (value: string) => (value.match(/\[[A-Z]+\d+_\d+-\d+\]/g) ?? []).length
  return Math.max(0, count(before) - count(after))
}

function criticNode(deps: NodeDeps) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const draft = state.draft ?? ''
    if (!draft) return { phase: 'critic_skipped' }

    const fallback: { score: number; verdict: string; issues: unknown[]; rewrite_hints: string[] } = {
      score: 0,
      verdict: '未能完成质检',
      issues: [],
      rewrite_hints: [],
    }
    const userPrompt = [
      '请对以下研报做一次严格质检，并只输出 JSON。',
      `核心问题：${state.query}`,
      `合法引用 ID 列表：${JSON.stringify((state.source_index ?? []).map((item) => item.source_id))}`,
      `证据池规模：${(state.evidence_pool ?? []).length} 条，审计标记：${JSON.stringify(state.audit_flags ?? [])}`,
      '',
      '研报正文：',
      truncate(draft, 9000),
    ].join('\n')

    const { data } = await runStructured(deps, ctx, 'critic', 'critic', userPrompt, fallback)

    const critique: CritiqueReport = {
      score: Math.max(0, Math.min(100, Math.round(asNumber(data.score, 0)))),
      verdict: asString(data.verdict, ''),
      issues: asRecordArray(data.issues).map((item) => {
        const severity = asString(item.severity, 'low').toLowerCase()
        return {
          type: asString(item.type, 'format'),
          target: asString(item.target, ''),
          detail: asString(item.detail, ''),
          severity: (severity === 'high' || severity === 'medium' ? severity : 'low') as 'high' | 'medium' | 'low',
        }
      }),
      rewrite_hints: asStringArray(data.rewrite_hints, 6),
    }

    ctx.emit({
      type: 'log',
      node: 'critic',
      level: critique.score >= 70 ? 'info' : 'warn',
      message: `质检评分 ${critique.score}/100，发现 ${critique.issues.length} 项问题`,
    })

    return { critique, phase: 'critiqued' }
  }
}

// ---------------------------------------------------------------------------
// 节点装配：把每个节点包一层「开始 / 结束」事件，供流水线可视化
// ---------------------------------------------------------------------------

function instrument(node: NodeId, handler: (state: ResearchState, ctx: NodeContext) => Promise<Partial<ResearchState>>) {
  return async (state: ResearchState, ctx: NodeContext): Promise<Partial<ResearchState>> => {
    const started = Date.now()
    ctx.emit({ type: 'node_start', node, label: '', iteration: state.iteration ?? 0 })
    const patch = await handler(state, ctx)
    ctx.emit({
      type: 'node_done',
      node,
      summary: summarizePatch(node, patch, state),
      iteration: patch.iteration ?? state.iteration ?? 0,
      ms: Date.now() - started,
    })
    return patch
  }
}

function summarizePatch(node: NodeId, patch: Partial<ResearchState>, state: ResearchState): string {
  switch (node) {
    case 'intent':
      return `路由结果：${patch.intent ?? state.intent}`
    case 'direct_answer':
      return `已生成快速回答（${estimateTokens(patch.final ?? '')} token 量级）`
    case 'plan':
      return `子问题 ${patch.sub_questions?.length ?? 0} 个 · 章节 ${patch.outline?.length ?? 0} 个 · 检索词 ${patch.search_plan?.length ?? 0} 条`
    case 'web_search':
      return `网页证据 ${patch.web_evidence?.length ?? 0} 条 · 检索 ${patch.web_retrieval_stats?.query_count ?? 0} 次`
    case 'local_rag':
      return `本地证据 ${patch.local_evidence?.length ?? 0} 条`
    case 'deep_dive':
      return `证据池 ${patch.evidence_pool?.length ?? 0} 条 · 审计标记 ${patch.audit_flags?.length ?? 0} 项`
    case 'analyze':
      return `结论 ${patch.findings?.length ?? 0} 条 · ${patch.needs_more_research ? '发现信息缺口，触发补搜' : '证据充分，进入撰写'}`
    case 'reflect':
      return `生成补搜计划 ${patch.supplementary_queries?.length ?? 0} 条（第 ${patch.iteration ?? 0} 轮）`
    case 'write':
      return `研报正文约 ${estimateTokens(patch.draft ?? '')} tokens`
    case 'critic':
      return `质检评分 ${patch.critique?.score ?? 0}/100`
    default:
      return '已完成'
  }
}

export function createNodes(deps: NodeDeps): Record<NodeId, (state: ResearchState, ctx: NodeContext) => Promise<Partial<ResearchState>>> {
  return {
    intent: instrument('intent', intentNode(deps)),
    direct_answer: instrument('direct_answer', directAnswerNode(deps)),
    plan: instrument('plan', planNode(deps)),
    web_search: instrument('web_search', webSearchNode(deps)),
    local_rag: instrument('local_rag', localRagNode(deps)),
    deep_dive: instrument('deep_dive', deepDiveNode(deps)),
    analyze: instrument('analyze', analyzeNode(deps)),
    reflect: instrument('reflect', reflectNode(deps)),
    write: instrument('write', writeNode(deps)),
    critic: instrument('critic', criticNode(deps)),
  }
}

/** 记录一轮对话到短期记忆（由工作流在运行结束后调用） */
export function recordTurns(threadId: string, query: string, answer: string): void {
  appendTurn(threadId, 'user', query)
  appendTurn(threadId, 'assistant', answer)
}
