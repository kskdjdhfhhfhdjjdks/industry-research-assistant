/**
 * 研究流程的前端状态编排。
 *
 * 这里做的事和原项目后端 WorkflowService 的角色类似：
 * 持有运行时配置、驱动一次完整任务、把事件流翻译成 UI 状态。
 */

import { computed, reactive, ref, shallowRef } from 'vue'
import { NODE_LABELS, NODE_ROLES } from '@/core/prompts'
import { applyPreset, loadSettings, saveSettings } from '@/core/config'
import type { AppSettings } from '@/core/config'
import { ensureSession, dbStatus } from '@/core/db'
import { deleteDocument, ingestDocument, knowledgeMode, listDocuments } from '@/core/knowledge'
import type { DocumentMeta } from '@/core/knowledge'
import { listRecentRuns } from '@/core/memory'
import type { ResearchRun } from '@/core/memory'
import { runResearch } from '@/core/workflow'
import type { AgentEvent, NodeId, ResearchState } from '@/core/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'status'
  content: string
  streaming?: boolean
  error?: boolean
}

export type NodeStatus = 'idle' | 'running' | 'done' | 'error' | 'skipped'

export interface PipelineNodeState {
  node: NodeId
  label: string
  role: string
  status: NodeStatus
  summary: string
  ms: number
  round: number
}

export interface LogLine {
  id: number
  node: string
  level: 'info' | 'warn' | 'error'
  message: string
  at: string
}

const PIPELINE_ORDER: NodeId[] = [
  'intent',
  'plan',
  'web_search',
  'local_rag',
  'deep_dive',
  'analyze',
  'reflect',
  'write',
  'critic',
]

function createPipeline(): PipelineNodeState[] {
  return PIPELINE_ORDER.map((node) => ({
    node,
    label: NODE_LABELS[node] ?? node,
    role: NODE_ROLES[node] ?? node,
    status: 'idle',
    summary: '',
    ms: 0,
    round: 0,
  }))
}

let messageSeed = 0
function nextId(prefix: string): string {
  messageSeed += 1
  return `${prefix}-${Date.now()}-${messageSeed}`
}

export function useResearch() {
  const settings = reactive<AppSettings>(loadSettings())
  const messages = ref<ChatMessage[]>([])
  const pipeline = ref<PipelineNodeState[]>(createPipeline())
  const logs = ref<LogLine[]>([])
  const liveState = reactive<Record<string, unknown>>({})
  const running = ref(false)
  const route = ref<'direct' | 'multiagent' | ''>('')
  const demoMode = ref(false)
  const capability = reactive({ llm: false, search: false, searchProvider: '', proxyPresent: false, probed: false })
  const usage = reactive({ calls: 0, promptTokens: 0, outputTokens: 0, elapsedMs: 0 })
  const documents = ref<DocumentMeta[]>([])
  const runs = ref<ResearchRun[]>([])
  const sessionUserId = ref(settings.userId)
  const toast = ref('')
  const controller = shallowRef<AbortController | null>(null)

  let logSeed = 0
  let streamingMessageId: string | null = null

  const knowledgeSource = computed(() => knowledgeMode())
  const supabaseEnabled = computed(() => dbStatus().enabled)

  const stats = computed(() => ({
    calls: usage.calls,
    tokens: usage.promptTokens + usage.outputTokens,
    evidence: Array.isArray(liveState.evidence_pool) ? (liveState.evidence_pool as unknown[]).length : 0,
    sources: Array.isArray(liveState.source_index) ? (liveState.source_index as unknown[]).length : 0,
    findings: Array.isArray(liveState.findings) ? (liveState.findings as unknown[]).length : 0,
    round: typeof liveState.iteration === 'number' ? liveState.iteration + 1 : 1,
    flags: Array.isArray(liveState.audit_flags) ? (liveState.audit_flags as unknown[]).length : 0,
    score: (liveState.critique as { score?: number } | undefined)?.score ?? 0,
  }))

  function pushLog(node: string, level: LogLine['level'], message: string) {
    logSeed += 1
    logs.value.push({
      id: logSeed,
      node,
      level,
      message,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    })
    if (logs.value.length > 200) logs.value.splice(0, logs.value.length - 200)
  }

  function resetPipeline() {
    pipeline.value = createPipeline()
  }

  function updateNode(node: NodeId, patch: Partial<PipelineNodeState>) {
    const target = pipeline.value.find((item) => item.node === node)
    if (target) Object.assign(target, patch)
  }

  function persist() {
    saveSettings({ ...settings })
  }

  async function probeCapability() {
    let proxyPresent = false
    let llm = false
    let search = false
    let searchProvider = ''
    try {
      const response = await fetch('/api/llm', { method: 'GET' })
      if (response.ok) {
        const data = (await response.json()) as { keyConfigured?: boolean }
        proxyPresent = true
        llm = Boolean(data.keyConfigured)
      }
    } catch {
      proxyPresent = false
    }
    try {
      const response = await fetch('/api/search', { method: 'GET' })
      if (response.ok) {
        const data = (await response.json()) as { keyConfigured?: boolean; provider?: string }
        search = Boolean(data.keyConfigured)
        searchProvider = data.provider ?? ''
      }
    } catch {
      search = false
    }
    capability.proxyPresent = proxyPresent
    capability.llm = llm
    capability.search = search
    capability.searchProvider = searchProvider
    capability.probed = true
    demoMode.value = !llm && !settings.apiKey
    return { llm, search, proxyPresent }
  }

  async function refreshDocuments() {
    try {
      documents.value = await listDocuments(settings.userId)
    } catch {
      documents.value = []
    }
  }

  async function refreshRuns() {
    try {
      runs.value = await listRecentRuns(settings.userId, 6)
    } catch {
      runs.value = []
    }
  }

  async function init() {
    sessionUserId.value = await ensureSession(settings.userId)
    await probeCapability()
    await Promise.all([refreshDocuments(), refreshRuns()])
  }

  function handleEvent(event: AgentEvent) {
    switch (event.type) {
      case 'node_start': {
        updateNode(event.node, { status: 'running', round: event.iteration + 1, summary: '', ms: 0 })
        break
      }
      case 'node_done': {
        updateNode(event.node, {
          status: 'done',
          summary: event.summary,
          ms: event.ms,
          round: event.iteration + 1,
        })
        break
      }
      case 'token': {
        if (!streamingMessageId) {
          const id = nextId('a')
          streamingMessageId = id
          messages.value.push({ id, role: 'assistant', content: '', streaming: true })
        }
        const target = messages.value.find((item) => item.id === streamingMessageId)
        if (target) target.content += event.text
        break
      }
      case 'log': {
        pushLog(event.node, event.level, event.message)
        break
      }
      case 'usage': {
        usage.calls += 1
        usage.promptTokens += event.promptTokens
        usage.outputTokens += event.completionTokens
        break
      }
      case 'stats': {
        Object.assign(liveState, event.patch)
        if (typeof event.patch.intent === 'string' && event.patch.intent) {
          route.value = event.patch.intent as 'direct' | 'multiagent'
        }
        break
      }
      case 'error': {
        pushLog('system', 'error', event.message)
        break
      }
      default:
        break
    }
  }

  async function start(query: string) {
    const text = query.trim()
    if (!text || running.value) return
    messages.value.push({ id: nextId('u'), role: 'user', content: text })
    resetPipeline()
    logs.value = []
    Object.keys(liveState).forEach((key) => delete liveState[key])
    usage.calls = 0
    usage.promptTokens = 0
    usage.outputTokens = 0
    usage.elapsedMs = 0
    route.value = ''
    streamingMessageId = null
    running.value = true
    const startedAt = Date.now()
    controller.value = new AbortController()

    try {
      const outcome = await runResearch({
        query: text,
        settings: { ...settings },
        demoMode: demoMode.value,
        emit: handleEvent,
        signal: controller.value.signal,
      })
      usage.elapsedMs = Date.now() - startedAt

      if (outcome.ok) {
        const finalState = outcome.state as ResearchState
        if (streamingMessageId) {
          const target = messages.value.find((item) => item.id === streamingMessageId)
          if (target) {
            target.content = finalState.final || target.content
            target.streaming = false
          }
        } else if (finalState.final) {
          messages.value.push({ id: nextId('a'), role: 'assistant', content: finalState.final })
        }
        liveState.evidence_pool = finalState.evidence_pool
        liveState.source_index = finalState.source_index
        liveState.findings = finalState.findings
        liveState.audit_flags = finalState.audit_flags
        liveState.critique = finalState.critique
        liveState.iteration = finalState.iteration
        route.value = finalState.intent || route.value
        void refreshRuns()
      } else if (outcome.error && outcome.error !== '已取消') {
        if (streamingMessageId) {
          const target = messages.value.find((item) => item.id === streamingMessageId)
          if (target && !target.content) {
            target.content = `执行失败：${outcome.error}`
            target.error = true
            target.streaming = false
          } else if (target) {
            target.streaming = false
          }
        } else {
          messages.value.push({ id: nextId('e'), role: 'assistant', content: `执行失败：${outcome.error}`, error: true })
        }
        toast.value = outcome.error
      } else if (!outcome.ok) {
        if (streamingMessageId) {
          const target = messages.value.find((item) => item.id === streamingMessageId)
          if (target) target.streaming = false
        }
        pushLog('system', 'warn', '任务已取消')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      pushLog('system', 'error', message)
      messages.value.push({ id: nextId('e'), role: 'assistant', content: `执行失败：${message}`, error: true })
      toast.value = message
    } finally {
      running.value = false
      controller.value = null
      pipeline.value.forEach((item) => {
        if (item.status === 'running') item.status = 'error'
      })
      streamingMessageId = null
      void refreshDocuments()
    }
  }

  function abort() {
    controller.value?.abort()
  }

  function newSession() {
    messages.value = []
    logs.value = []
    resetPipeline()
    Object.keys(liveState).forEach((key) => delete liveState[key])
    route.value = ''
    usage.calls = 0
    usage.promptTokens = 0
    usage.outputTokens = 0
    usage.elapsedMs = 0
    settings.threadId = `thread-${Math.random().toString(36).slice(2, 8)}`
    persist()
  }

  async function addDocument(title: string, content: string) {
    const result = await ingestDocument({
      title,
      content,
      userId: settings.userId,
      semantic: settings.semanticEmbedding,
    })
    await refreshDocuments()
    toast.value = `已索引《${title}》共 ${result.chunks} 个分片（${result.storage === 'supabase' ? 'Supabase pgvector' : '浏览器本地'}，向量后端 ${result.backend}）`
    return result
  }

  async function removeDocument(id: string) {
    await deleteDocument(id, settings.userId)
    await refreshDocuments()
  }

  function updateProvider(providerId: string) {
    Object.assign(settings, applyPreset({ ...settings }, providerId))
    persist()
  }

  function save() {
    persist()
    void probeCapability()
    toast.value = '设置已保存到本地'
  }

  return {
    settings,
    messages,
    pipeline,
    logs,
    liveState,
    running,
    route,
    demoMode,
    capability,
    usage,
    documents,
    runs,
    sessionUserId,
    toast,
    stats,
    knowledgeSource,
    supabaseEnabled,
    init,
    start,
    abort,
    newSession,
    addDocument,
    removeDocument,
    updateProvider,
    save,
    persist,
    probeCapability,
    refreshDocuments,
    refreshRuns,
  }
}
