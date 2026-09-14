/**
 * 端到端逻辑冒烟测试（Node 环境，不带浏览器）。
 *
 * 验证的是最容易出错、也最核心的部分：
 *   1. StateGraph 超步调度会不会收敛（并行扇出 / 隐式汇合 / 条件边回退）
 *   2. 9 个 Agent 节点是否真的依次执行并产出可用状态
 *   3. 引用校验与参考列表是否生效
 *   4. 迭代补搜是否真的触发了第二轮
 *   5. 本地知识库（分片 / 向量 / 余弦检索）链路是否打通
 *
 * 运行方式见 package.json 的 smoke 脚本。
 */

import { runResearch } from '../src/core/workflow'
import { ingestDocument } from '../src/core/knowledge'
import { detectIntent, deriveSearchPlan, estimateRelevance } from '../src/core/heuristics'
import { validateAndFixCitations } from '../src/core/citations'
import { hashEmbed, cosineSimilarity } from '../src/core/embedding'
import { demoDocument } from '../src/core/demo'
import { chunkText } from '../src/core/knowledge'
import type { AgentEvent } from '../src/core/types'
import type { AppSettings } from '../src/core/config'

// ---- 浏览器 API 垫片 -------------------------------------------------------
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage

const results: { name: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

const settings: AppSettings = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  useProxy: true,
  maxIterations: 2,
  userId: 'smoke-user',
  threadId: 'smoke-thread',
  tenantId: 'public',
  semanticEmbedding: false,
}

async function main(): Promise<void> {
  log('=== 单元级检查 ===')

  // 1. 意图规则引擎
  const route1 = detectIntent('帮我调研 2026 年企业级 AI Agent 行业市场规模')
  const route2 = detectIntent('你是谁')
  check('意图规则：研究类 → multiagent', route1 === 'multiagent', `得到 ${route1}`)
  check('意图规则：寒暄类 → direct', route2 === 'direct', `得到 ${route2}`)

  // 2. 检索计划派生必须锚定用户实体，不能发散
  const plan = deriveSearchPlan(
    [{ id: 'sec_1', search_queries: ['企业级 AI Agent 市场规模', '无关的发散话题'] }],
    '调研 2026 年企业级 AI Agent 行业',
  )
  check('检索计划派生', plan.length > 0, `生成 ${plan.length} 条：${plan.map((item) => item.query).join(' / ')}`)
  check(
    '检索计划锚定实体（过滤发散词）',
    plan.every((item) => !item.query.includes('无关的发散话题')),
    '',
  )

  // 3. 相关性估算
  const rel = estimateRelevance('企业级 AI Agent 市场规模', '艾瑞咨询测算企业级 AI Agent 市场规模达 486 亿元')
  check('相关性估算', rel > 0.5, `命中率 ${rel.toFixed(2)}`)

  // 4. 引用校验：非法编号必须被剔除
  const fixed = validateAndFixCitations('结论 A [WEB1_1-1]，结论 B [WEB9_9-9]。', new Set(['WEB1_1-1']))
  check('引用校验剔除幻觉编号', !fixed.content.includes('WEB9_9-9') && fixed.usedIds.length === 1, fixed.content)

  // 5. 文档分片
  const sample = demoDocument()
  const chunks = chunkText(sample.content)
  check('文档分片', chunks.length >= 3, `切成 ${chunks.length} 片`)

  // 6. 向量与相似度
  const v1 = hashEmbed('企业级 AI Agent 市场规模')
  const v2 = hashEmbed('企业级 AI Agent 行业规模测算')
  const v3 = hashEmbed('今天天气不错适合出门散步')
  const simNear = cosineSimilarity(v1, v2)
  const simFar = cosineSimilarity(v1, v3)
  check('特征哈希向量维度', v1.length === 512, `维度 ${v1.length}`)
  check('向量相似度可区分语义', simNear > simFar, `近 ${simNear.toFixed(3)} > 远 ${simFar.toFixed(3)}`)

  // 7. 本地知识库写入（无 Supabase → 走浏览器本地兜底）
  const ingest = await ingestDocument({ title: sample.title, content: sample.content, userId: settings.userId })
  check('知识库索引写入', ingest.chunks > 0, `${ingest.chunks} 片，存储=${ingest.storage}`)

  log('')
  log('=== 端到端流水线（演示模式）===')
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const startedAt = Date.now()

  const outcome = await runResearch({
    query: '请调研 2026 年企业级 AI Agent 行业，覆盖市场规模与增速、竞争格局、技术路线与商业模式，并给出带来源引用的结论。',
    settings,
    demoMode: true,
    emit: (event) => events.push(event),
    signal: controller.signal,
  })

  const elapsed = Date.now() - startedAt
  const nodeStarts = events.filter((event) => event.type === 'node_start').map((event) => (event as { node: string }).node)
  const nodeDones = events.filter((event) => event.type === 'node_done')
  const usage = events.filter((event) => event.type === 'usage')
  const tokens = events.filter((event) => event.type === 'token')

  log(`事件总数：${events.length}（节点开始 ${nodeStarts.length} / 节点结束 ${nodeDones.length} / 模型调用 ${usage.length} / 流式分片 ${tokens.length}）`)
  log(`执行顺序：${nodeStarts.join(' → ')}`)
  log(`端到端耗时：${elapsed}ms`)

  check('流水线执行成功', outcome.ok, outcome.error ?? '')
  const state = outcome.state

  check('图收敛：9 个节点均被执行', nodeStarts.length >= 9, `实际 ${nodeStarts.length} 次节点执行`)
  check('意图路由走多智能体链路', state.intent === 'multiagent', `intent=${state.intent}`)
  check('规划产出子问题与大纲', state.sub_questions.length >= 3 && state.outline.length >= 3, `${state.sub_questions.length} 子问题 / ${state.outline.length} 章节`)
  check('双源检索均有证据', state.web_evidence.length > 0 && state.local_evidence.length > 0, `网络 ${state.web_evidence.length} / 本地 ${state.local_evidence.length}`)
  check('证据裁判产出证据池与来源索引', state.evidence_pool.length > 0 && state.source_index.length > 0, `证据池 ${state.evidence_pool.length} / 来源 ${state.source_index.length}`)
  check('分析产出结论且均绑定来源', state.findings.length > 0 && state.findings.every((item) => item.source_ids.length > 0), `${state.findings.length} 条结论`)
  check('迭代补搜真的触发了第二轮', state.iteration >= 1, `iteration=${state.iteration}`)
  check('撰写产出研报正文', (state.final ?? '').length > 1500, `正文 ${(state.final ?? '').length} 字`)
  check('自动拼接参考列表', (state.final ?? '').includes('## 参考资料'), '')
  check('质检环节给出评分', (state.critique?.score ?? 0) > 0, `score=${state.critique?.score ?? 0}`)
  check('执行明细附录存在', (state.final ?? '').includes('附录：执行明细'), '')
  check('模型调用次数统计', usage.length >= 8, `${usage.length} 次`)

  // 引用合法性：正文里的编号必须都在 source_index 里
  const validIds = new Set(state.source_index.map((item) => item.source_id))
  const cited = (state.draft ?? '').match(/\[[A-Z]+\d+_\d+-\d+\]/g) ?? []
  const illegal = cited.map((item) => item.slice(1, -1)).filter((id) => !validIds.has(id))
  check('正文引用全部合法（无幻觉编号）', illegal.length === 0, illegal.length ? `非法：${illegal.slice(0, 5).join(',')}` : `${cited.length} 处引用全部合法`)

  log('')
  log('=== 研报正文片段 ===')
  log((state.final ?? '').slice(0, 420))
  log('...')
  log('')
  log('=== 参考列表片段 ===')
  const refIndex = (state.final ?? '').indexOf('## 参考资料')
  log(refIndex >= 0 ? (state.final ?? '').slice(refIndex, refIndex + 320) : '（未找到参考列表）')

  log('')
  log('=== 检查结果 ===')
  let failed = 0
  for (const item of results) {
    if (!item.ok) failed += 1
    log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `  [${item.detail}]` : ''}`)
  }
  log('')
  log(`合计：${results.length - failed}/${results.length} 通过`)

  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  log(`冒烟测试异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
