/**
 * 极简 StateGraph 引擎 —— 把原项目 LangGraph 的编排语义搬到 TypeScript。
 *
 * 为什么不用 @langchain/langgraph 的 JS 版？
 * 1. 浏览器场景下我们只需要「节点 + 静态边 + 条件边 + 并行超步」这四件事，
 *    自己实现约 120 行，可读性远好于引入一个带 Node 依赖的包；
 * 2. 面试时可以直接讲清楚 Pregel 超步（superstep）调度是怎么保证
 *    「plan 并行扇出到 web/local，再汇合到 deep_dive」只跑一次的；
 * 3. 便于把节点执行过程暴露成细粒度事件给前端做流水线可视化。
 *
 * 与 LangGraph 的语义对齐点：
 * - 同一个超步内完成的所有节点，其出边目标会去重后进入下一个超步（这就是隐式 join）；
 * - 条件边在超步状态合并完成后再求值，因此路由函数可以读到本超步新写入的字段；
 * - START / END 为哨兵节点。
 */

import type { AgentEvent } from './types'

export const START = '__start__'
export const END = '__end__'

export interface NodeContext {
  /** 把执行过程中的事件推给 UI */
  emit: (event: AgentEvent) => void
  /** 当前超步序号（从 1 开始） */
  step: number
  signal: AbortSignal
}

export type NodeHandler<S> = (state: S, ctx: NodeContext) => Promise<Partial<S>> | Partial<S>

export interface ConditionalRouter<S> {
  router: (state: S) => string
  targets: Record<string, string>
}

export interface EdgeDescriptor {
  from: string
  to: string[]
  conditional: boolean
}

export interface GraphDescriptor {
  nodes: string[]
  entry: string
  edges: EdgeDescriptor[]
}

export class StateGraph<S extends object> {
  private nodes = new Map<string, NodeHandler<S>>()
  private staticEdges = new Map<string, string[]>()
  private conditionalEdges = new Map<string, ConditionalRouter<S>>()
  private entry: string | null = null
  private finishPoints = new Set<string>()

  addNode(name: string, handler: NodeHandler<S>): this {
    if (name === START || name === END) {
      throw new Error(`节点名不能使用保留字 ${name}`)
    }
    this.nodes.set(name, handler)
    return this
  }

  /** 起点：等价于 workflow.add_edge(START, node) */
  setEntry(name: string): this {
    this.entry = name
    return this
  }

  addEdge(from: string, to: string): this {
    if (from === START) {
      this.entry = to
      return this
    }
    if (to === END) {
      this.finishPoints.add(from)
      return this
    }
    const list = this.staticEdges.get(from) ?? []
    if (!list.includes(to)) list.push(to)
    this.staticEdges.set(from, list)
    return this
  }

  addConditionalEdges(
    from: string,
    router: (state: S) => string,
    targets: Record<string, string>,
  ): this {
    this.conditionalEdges.set(from, { router, targets })
    return this
  }

  /** 把图结构导出给 UI 画流水线图（节点顺序即声明顺序） */
  describe(): GraphDescriptor {
    const edges: EdgeDescriptor[] = []
    for (const [from, to] of this.staticEdges) {
      edges.push({ from, to: [...to], conditional: false })
    }
    for (const [from, { targets }] of this.conditionalEdges) {
      edges.push({ from, to: [...new Set(Object.values(targets))], conditional: true })
    }
    return {
      nodes: [...this.nodes.keys()],
      entry: this.entry ?? '',
      edges,
    }
  }

  compile(): CompiledGraph<S> {
    if (!this.entry) throw new Error('状态图缺少入口节点，请先调用 setEntry')
    const unreachable = [...this.nodes.keys()].filter((name) => name !== this.entry)
    return new CompiledGraph<S>(
      this.nodes,
      this.staticEdges,
      this.conditionalEdges,
      this.entry,
      this.finishPoints,
      unreachable,
      this.describe(),
    )
  }
}

export class CompiledGraph<S extends object> {
  constructor(
    private nodes: Map<string, NodeHandler<S>>,
    private staticEdges: Map<string, string[]>,
    private conditionalEdges: Map<string, ConditionalRouter<S>>,
    private entry: string,
    private finishPoints: Set<string>,
    private reachableFromEntry: string[],
    private descriptor: GraphDescriptor,
  ) {}

  /** 图结构描述（节点顺序 + 边），供前端渲染流水线布局 */
  describe(): GraphDescriptor {
    return this.descriptor
  }

  /** 每个节点归属的迭代轮次，供 UI 展示补搜次数 */
  async run(
    initial: S,
    emit: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<S> {
    let state: S = { ...initial }
    let frontier = new Set<string>([this.entry])
    let step = 0
    const MAX_STEPS = 64 // 防御性上限，正常链路最多 6~8 个超步

    while (frontier.size > 0) {
      if (signal.aborted) throw new DOMException('运行已取消', 'AbortError')
      step += 1
      if (step > MAX_STEPS) {
        emit({ type: 'log', node: 'system', level: 'error', message: `超步数超过上限 ${MAX_STEPS}，强制终止` })
        break
      }

      const batch = [...frontier]
      const results = await Promise.all(
        batch.map(async (name) => {
          const handler = this.nodes.get(name)
          if (!handler) throw new Error(`未注册的节点: ${name}`)
          const started = Date.now()
          try {
            const patch = await handler(state, { emit, step, signal })
            return { name, patch: patch ?? {}, ms: Date.now() - started, error: null as unknown }
          } catch (error) {
            return { name, patch: {} as Partial<S>, ms: Date.now() - started, error }
          }
        }),
      )

      const failed = results.filter((r) => r.error)
      for (const result of results) {
        if (result.error) {
          const message = result.error instanceof Error ? result.error.message : String(result.error)
          emit({ type: 'log', node: 'system', level: 'error', message: `节点 ${result.name} 执行失败：${message}` })
          continue
        }
        state = { ...state, ...result.patch }
        emit({ type: 'stats', patch: result.patch })
      }
      if (failed.length > 0 && failed.length === results.length) {
        throw new Error(`全部节点执行失败：${String((failed[0].error as Error)?.message ?? failed[0].error)}`)
      }

      const next = new Set<string>()
      for (const name of batch) {
        const conditional = this.conditionalEdges.get(name)
        if (conditional) {
          const branch = conditional.router(state)
          const target = conditional.targets[branch]
          emit({ type: 'log', node: name as never, level: 'info', message: `条件路由 → ${branch}` })
          if (target) next.add(target)
        }
        for (const target of this.staticEdges.get(name) ?? []) {
          next.add(target)
        }
      }

      // 命中 END 的节点直接终结整张图
      const terminated = batch.some((name) => this.finishPoints.has(name))
      frontier = terminated ? new Set() : next
    }

    return state
  }

  /** 未从入口可达的节点（自检用） */
  unreachable(): string[] {
    return this.reachableFromEntry
  }
}
