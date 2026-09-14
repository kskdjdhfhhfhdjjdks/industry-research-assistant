/**
 * 工作流装配 —— 迁移自原项目 app/mult_agents/graph.py。
 *
 * 拓扑完全对齐原实现，只增加了一个后置环节：
 *
 *   START → intent ─┬─(direct)────────────→ direct_answer → END
 *                   └─(multiagent)─→ plan ─┬─→ web_search ─┐
 *                                          └─→ local_rag  ──┴─→ deep_dive → analyze
 *                                                                             │
 *                            ┌────────────────(证据不足)──────────────────────┤
 *                            ▼                                                │(证据充分)
 *                    reflect → web_search / local_rag                        ▼
 *                                                                        write → critic → END
 *
 * 条件边的两个判断函数（route_after_intent / should_continue_research）
 * 与原 nodes/graph 中的实现一一对应，包括 iteration 计数器与 max_iterations 上限保护。
 */

import { CompiledGraph, END, START, StateGraph } from './graph'
import { createNodes, recordTurns, type NodeDeps } from './nodes'
import { createInitialState, type AgentEvent, type ResearchState } from './types'
import { buildMemoryContext, extractPreferences, saveMemory, saveRun } from './memory'
import { resetDemoState } from './demo'
import { resetProxyState } from './llm'
import { resetSearchState } from './search'
import type { AppSettings } from './config'

/** 意图路由条件边：闲聊/简单问答走 direct，其余走完整研究链路 */
export function routeAfterIntent(state: ResearchState): string {
  return state.intent === 'direct' ? 'direct_answer' : 'plan'
}

/** 分析后的条件边：达到迭代上限或证据充分则撰写，否则回头补搜 */
export function shouldContinueResearch(state: ResearchState): string {
  const iteration = state.iteration ?? 0
  const maxIterations = state.max_iterations ?? 2
  if (iteration >= maxIterations) return 'write'
  if (state.needs_more_research) return 'reflect'
  return 'write'
}

export function buildWorkflow(deps: NodeDeps): CompiledGraph<ResearchState> {
  const nodes = createNodes(deps)
  const graph = new StateGraph<ResearchState>()

  graph.addNode('intent', nodes.intent)
  graph.addNode('direct_answer', nodes.direct_answer)
  graph.addNode('plan', nodes.plan)
  graph.addNode('web_search', nodes.web_search)
  graph.addNode('local_rag', nodes.local_rag)
  graph.addNode('deep_dive', nodes.deep_dive)
  graph.addNode('analyze', nodes.analyze)
  graph.addNode('reflect', nodes.reflect)
  graph.addNode('write', nodes.write)
  graph.addNode('critic', nodes.critic)

  graph.addEdge(START, 'intent')
  graph.addConditionalEdges('intent', routeAfterIntent, {
    direct_answer: 'direct_answer',
    plan: 'plan',
  })
  // 两个侦察节点并行执行（同一超步），随后汇合到证据裁判
  graph.addEdge('plan', 'web_search')
  graph.addEdge('plan', 'local_rag')
  graph.addEdge('web_search', 'deep_dive')
  graph.addEdge('local_rag', 'deep_dive')
  graph.addEdge('deep_dive', 'analyze')
  graph.addConditionalEdges('analyze', shouldContinueResearch, {
    reflect: 'reflect',
    write: 'write',
  })
  // 补搜同样走并行双路检索
  graph.addEdge('reflect', 'web_search')
  graph.addEdge('reflect', 'local_rag')
  graph.addEdge('write', 'critic')
  graph.addEdge('critic', END)
  graph.addEdge('direct_answer', END)

  return graph.compile()
}

/** 图结构描述，供前端渲染流水线布局（保证 UI 与实际拓扑永远一致） */
export function workflowDescriptor() {
  return buildWorkflow({ settings: {} as AppSettings, demoMode: true }).describe()
}

export interface RunResearchOptions {
  query: string
  settings: AppSettings
  demoMode: boolean
  emit: (event: AgentEvent) => void
  signal: AbortSignal
}

export interface RunResearchOutcome {
  state: ResearchState
  ok: boolean
  error?: string
}

/**
 * 一次完整研究任务的入口。
 * 与 FastAPI 版的 WorkflowService.run 职责一致，只是运行在浏览器里：
 * 先装配跨会话记忆上下文，再驱动状态图，最后把这一轮写回记忆。
 */
export async function runResearch(options: RunResearchOptions): Promise<RunResearchOutcome> {
  const { query, settings, demoMode, emit, signal } = options

  resetDemoState()
  resetProxyState()
  resetSearchState()

  let memoryContext = ''
  try {
    const memory = await buildMemoryContext({
      userId: settings.userId,
      threadId: settings.threadId,
      query,
      semantic: settings.semanticEmbedding,
    })
    memoryContext = memory.text
    if (memory.text) {
      emit({
        type: 'log',
        node: 'system',
        level: 'info',
        message: `已注入跨会话记忆（语义 ${memory.semantic.length} 条 / 情景 ${memory.episodic.length} 条${memory.summary ? ' / 含历史摘要' : ''}）`,
      })
    }
  } catch {
    memoryContext = ''
  }

  const initialState = createInitialState({
    query,
    user_id: settings.userId,
    tenant_id: settings.tenantId,
    thread_id: settings.threadId,
    max_iterations: settings.maxIterations,
    memory_context: memoryContext,
  })

  const workflow = buildWorkflow({ settings, demoMode })

  try {
    const finalState = await workflow.run(initialState, emit, signal)
    finalState.elapsed_ms = Date.now() - finalState.started_at
    finalState.llm_calls = finalState.llm_calls || 0

    // 记忆写回：短期对话 + 语义偏好 + 情景任务
    try {
      if (finalState.final) {
        recordTurns(settings.threadId, query, finalState.final)
        const preferences = extractPreferences(query)
        for (const preference of preferences) {
          await saveMemory({
            userId: settings.userId,
            tenantId: settings.tenantId,
            kind: 'semantic',
            content: preference,
            semantic: settings.semanticEmbedding,
          })
        }
        await saveRun({
          userId: settings.userId,
          tenantId: settings.tenantId,
          threadId: settings.threadId,
          query,
          answer: finalState.final,
          iterations: finalState.iteration,
          sources: finalState.source_index?.length ?? 0,
        })
      }
    } catch (error) {
      emit({
        type: 'log',
        node: 'system',
        level: 'warn',
        message: `记忆写回失败（不影响本次结果）：${error instanceof Error ? error.message : String(error)}`,
      })
    }

    return { state: finalState, ok: true }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { state: initialState, ok: false, error: '已取消' }
    }
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message })
    return { state: initialState, ok: false, error: message }
  }
}
