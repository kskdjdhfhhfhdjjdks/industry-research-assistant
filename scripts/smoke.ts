/**
 * 端到端逻辑冒烟测试（Node 环境，不带浏览器）。
 *
 * 验证的是最容易出错、也最核心的部分：
 *   1. StateGraph 超步调度会不会收敛（并行扇出 / 隐式汇合 / 条件边回退）
 *   2. 9 个 Agent 节点是否真的依次执行并产出可用状态
 *   3. 引用校验与参考列表是否生效
 *   4. 迭代补搜是否真的触发了第二轮
 *   5. 本地知识库（分片 / 向量 / 余弦检索）链路是否打通
 *   6. 检索层的多后端适配（博查 / Tavily / Serper 的字段映射与去重）
 *   7. Supabase 环境变量误配是否会拖垮首屏渲染（防白屏回归）
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
import { webSearch, resetSearchState } from '../src/core/search'
import { isSupabaseEnabled, validateSupabaseConfig } from '../src/core/config'
import searchHandler from '../netlify/edge-functions/search'
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

  // 7. Supabase 配置校验 —— 非法 URL 必须被拦下，否则首屏渲染会整页白屏
  //    （真实故障：VITE_SUPABASE_URL 被填成 postgresql:// 连接串，
  //      createClient 抛错冒泡到 render，最终只渲染出空注释节点）
  const connString = 'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres'
  check(
    'Supabase 配置：两项皆空 → 视为未配置',
    validateSupabaseConfig('', '') === '未配置' && !isSupabaseEnabled(),
    '',
  )
  check(
    'Supabase 配置：合法 Project URL + key → 可用',
    validateSupabaseConfig('https://abcdefgh.supabase.co', 'eyJhbGciOi') === '',
    '',
  )
  const connIssue = validateSupabaseConfig(connString, 'eyJhbGciOi')
  check(
    'Supabase 配置：数据库连接串被判为误配（防白屏）',
    connIssue.length > 0 && connIssue.includes('数据库连接串'),
    connIssue,
  )
  check(
    'Supabase 配置：缺协议头的域名被判为非法',
    validateSupabaseConfig('abcdefgh.supabase.co', 'eyJhbGciOi').includes('不是合法'),
    validateSupabaseConfig('abcdefgh.supabase.co', 'eyJhbGciOi'),
  )
  check(
    'Supabase 配置：只有 URL 缺 key → 拒绝',
    validateSupabaseConfig('https://abcdefgh.supabase.co', '').includes('VITE_SUPABASE_ANON_KEY'),
    '',
  )
  check(
    'Supabase 配置：非 http(s) 协议（如 ftp）→ 拒绝',
    validateSupabaseConfig('ftp://example.com', 'eyJhbGciOi').length > 0,
    validateSupabaseConfig('ftp://example.com', 'eyJhbGciOi'),
  )

  // 8. 本地知识库写入（无 Supabase → 走浏览器本地兜底）
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

  // ---------------------------------------------------------------
  // 检索层：多后端适配
  //
  // 检索是整条链路最容易被外部因素卡住的一环（国际服务常要国外信用卡），
  // 所以把三个后端的字段映射、去重、优先级、错误分支全部用假响应验证一遍，
  // 不需要任何真实 API Key，也不发出任何真实网络请求。
  // 注意：本段会替换 globalThis.fetch，因此必须放在流水线测试之后。
  // ---------------------------------------------------------------
  log('')
  log('=== 检索层：多后端适配（假响应验证字段映射）===')

  const realFetch = globalThis.fetch
  const calls: { url: string; authorization: string; body: any }[] = []

  const stubFetch = (body: unknown, status = 200): void => {
    ;(globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input?.url ?? '')
      const headers = (init?.headers ?? {}) as Record<string, string>
      let parsed: any = {}
      try {
        parsed = init?.body ? JSON.parse(String(init.body)) : {}
      } catch {
        parsed = {}
      }
      calls.push({ url, authorization: headers.Authorization ?? '', body: parsed })
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
  }

  const postSearch = async (payload: Record<string, unknown>): Promise<{ status: number; data: any }> => {
    const response = await (searchHandler as any)(
      new Request('https://smoke.test/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
    return { status: response.status, data: await response.json() }
  }

  const env = process.env

  // --- 场景 1：只配博查，使用标准顶层结构 ---
  delete env.TAVILY_API_KEY
  delete env.SERPER_API_KEY
  delete env.SEARCH_PROVIDER
  env.BOCHA_API_KEY = 'sk-smoke-bocha'

  calls.length = 0
  stubFetch({
    webPages: {
      value: [
        {
          name: '博查结果一',
          url: 'https://www.example.com/a',
          snippet: '片段A',
          summary: '摘要A',
          datePublished: '2026-03-01T00:00:00+08:00',
        },
        { name: '博查结果二', url: 'https://example.com/b', snippet: '片段B', summary: '', datePublished: '' },
        { name: '同源重复条目', url: 'http://www.example.com/a', snippet: '重复', summary: '重复摘要', datePublished: '' },
      ],
    },
  })

  const bocha = await postSearch({ query: '企业级 AI Agent 市场规模', count: 5 })
  check('检索后端：自动选中博查', bocha.data.provider === 'bocha', `provider=${bocha.data.provider}`)
  check(
    '检索后端：请求打到博查端点并带上密钥',
    calls[0]?.url === 'https://api.bochaai.com/v1/web-search' && calls[0]?.authorization === 'Bearer sk-smoke-bocha',
    `${calls[0]?.url} / ${calls[0]?.authorization}`,
  )
  check(
    '博查字段映射 name→title / summary→content / datePublished→published_date',
    bocha.data.results?.[0]?.title === '博查结果一' &&
      bocha.data.results?.[0]?.content === '摘要A' &&
      bocha.data.results?.[0]?.published_date === '2026-03-01T00:00:00+08:00',
    JSON.stringify(bocha.data.results?.[0] ?? {}),
  )
  check('博查 summary 为空时回退到 snippet', bocha.data.results?.[1]?.content === '片段B', String(bocha.data.results?.[1]?.content))
  check('按规范化 URL 去重（3 条 → 2 条）', bocha.data.results?.length === 2, `实际 ${bocha.data.results?.length}`)
  check(
    '博查请求体使用 count / freshness / summary',
    calls[0]?.body?.count === 5 && calls[0]?.body?.summary === true && typeof calls[0]?.body?.freshness === 'string',
    JSON.stringify(calls[0]?.body ?? {}),
  )

  // --- 场景 2：博查响应被包一层 data（不同版本结构不一致）---
  stubFetch({
    code: 200,
    data: { webPages: { value: [{ name: '包装结构', url: 'https://wrapped.example.com/p', snippet: 'S' }] } },
  })
  const wrapped = await postSearch({ query: '包装结构测试', count: 3 })
  check(
    '博查兼容 data.webPages 包装结构',
    wrapped.data.results?.length === 1 && wrapped.data.results?.[0]?.title === '包装结构',
    JSON.stringify(wrapped.data.results ?? []),
  )

  // --- 场景 3：博查业务错误码 ---
  stubFetch({ code: 401, msg: '无效的 API KEY' })
  const badCode = await postSearch({ query: '错误分支', count: 3 })
  check(
    '博查业务错误码转为 502 + upstream_error',
    badCode.status === 502 && badCode.data.error === 'upstream_error' && String(badCode.data.message).includes('无效的 API KEY'),
    `${badCode.status} ${badCode.data.error}`,
  )

  // --- 场景 4：优先级与强制指定 ---
  env.TAVILY_API_KEY = 'tvly-smoke'
  calls.length = 0
  stubFetch({
    results: [{ title: 'Tavily 结果', url: 'https://tavily.example.com/t', content: '内容T', published_date: '', score: 0.9 }],
  })
  const both = await postSearch({ query: '优先级测试', count: 3 })
  check(
    '同时配置时按优先级选中 Tavily',
    both.data.provider === 'tavily' && calls[0]?.url === 'https://api.tavily.com/search',
    `provider=${both.data.provider}`,
  )
  check(
    'Tavily 的 content 与 score 原样保留',
    both.data.results?.[0]?.title === 'Tavily 结果' && both.data.results?.[0]?.content === '内容T',
    JSON.stringify(both.data.results?.[0] ?? {}),
  )

  env.SEARCH_PROVIDER = 'bocha'
  calls.length = 0
  stubFetch({ webPages: { value: [{ name: '强制博查', url: 'https://forced.example.com/f', snippet: 'F' }] } })
  const forced = await postSearch({ query: '强制指定测试', count: 3 })
  check(
    'SEARCH_PROVIDER 可强制覆盖优先级',
    forced.data.provider === 'bocha' && calls[0]?.url === 'https://api.bochaai.com/v1/web-search',
    `provider=${forced.data.provider}`,
  )

  // --- 场景 5：Serper 适配 ---
  delete env.BOCHA_API_KEY
  delete env.TAVILY_API_KEY
  delete env.SEARCH_PROVIDER
  env.SERPER_API_KEY = 'serper-smoke'
  calls.length = 0
  stubFetch({ organic: [{ title: 'Serper 结果', link: 'https://serper.example.com/s', snippet: '内容S', date: '2026-02-02' }] })
  const serper = await postSearch({ query: 'Serper 测试', count: 3 })
  check(
    'Serper 适配 link→url / snippet→content',
    serper.data.provider === 'serper' &&
      serper.data.results?.[0]?.url === 'https://serper.example.com/s' &&
      serper.data.results?.[0]?.content === '内容S',
    JSON.stringify(serper.data.results?.[0] ?? {}),
  )

  // --- 场景 6：一个 key 都没有 ---
  delete env.SERPER_API_KEY
  const none = await postSearch({ query: '无密钥', count: 3 })
  check(
    '无任何检索密钥时返回 401 missing_key',
    none.status === 401 && none.data.error === 'missing_key',
    `${none.status} ${none.data.error}`,
  )

  // --- 场景 7：GET 能力探测（设置面板据此显示后端名）---
  env.BOCHA_API_KEY = 'sk-smoke-bocha'
  const probe = await (searchHandler as any)(new Request('https://smoke.test/api/search', { method: 'GET' }))
  const probeData = await probe.json()
  check('GET 能力探测返回生效的后端名', probeData.keyConfigured === true && probeData.provider === 'bocha', JSON.stringify(probeData))

  // --- 场景 8：前端客户端把统一格式转成 SourceRecord ---
  resetSearchState()
  stubFetch({
    results: [{ title: '前端映射', url: 'https://news.example.com/x', content: '正文C', published_date: '2026-01-01' }],
    provider: 'bocha',
  })
  const client = await webSearch('前端映射测试', { count: 3 })
  check(
    '前端 webSearch 映射为 SourceRecord（域名提取 + source_type）',
    client.records[0]?.domain === 'news.example.com' &&
      client.records[0]?.source_type === 'web' &&
      client.records[0]?.snippet === '正文C',
    JSON.stringify(client.records[0] ?? {}),
  )
  check('前端记录生效的检索后端', client.provider === 'bocha', String(client.provider))

  globalThis.fetch = realFetch

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
