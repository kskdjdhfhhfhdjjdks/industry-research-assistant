/**
 * Netlify Edge Function：/api/search
 *
 * 多后端网络检索代理。把不同厂商的检索 API 差异收敛在服务端，
 * 向上层（web_search 节点）只暴露一种统一格式。
 *
 * 为什么放服务端：
 *   1. 隐藏检索密钥，访客无需自备密钥；
 *   2. 浏览器直连第三方检索 API 会遇到 CORS，服务端代理顺带解决跨域。
 *
 * 支持的后端（按顺序自动探测，也可用 SEARCH_PROVIDER 强制指定）：
 *   - tavily  国际通用，专为 LLM 设计，直接返回已抽正文 + 相关性打分
 *   - bocha   博查，国内合规、支付宝/微信可充值，国内开发者最省事
 *   - serper  Google 结果，注册不需要信用卡
 *
 * 未配置任何密钥时返回 401 + error=missing_key，
 * 前端据此把网络检索切换到内置演示语料，保证流水线不中断。
 */

type ProviderId = 'tavily' | 'bocha' | 'serper'

interface NormalizedResult {
  title: string
  url: string
  content: string
  published_date: string
  score: number
}

interface SearchOptions {
  query: string
  count: number
  topic: 'general' | 'news'
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const SERPER_ENDPOINT = 'https://google.serper.dev/search'
const SERPER_NEWS_ENDPOINT = 'https://google.serper.dev/news'

/** 探测顺序即优先级：先国际通用，再国内友好，最后备用 */
const PROVIDER_ORDER: ProviderId[] = ['tavily', 'bocha', 'serper']

const PROVIDER_ENV: Record<ProviderId, string> = {
  tavily: 'TAVILY_API_KEY',
  bocha: 'BOCHA_API_KEY',
  serper: 'SERPER_API_KEY',
}

/** 上游请求超时。边缘函数整体有墙钟限制，不能无限等。 */
const UPSTREAM_TIMEOUT_MS = 12000

function readEnv(key: string): string {
  const netlifyGlobal = (globalThis as { Netlify?: { env?: { get(name: string): string | undefined } } }).Netlify
  if (netlifyGlobal?.env?.get) {
    const value = netlifyGlobal.env.get(key)
    if (value) return value
  }
  const deno = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno
  if (deno?.env?.get) {
    const value = deno.env.get(key)
    if (value) return value
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[key] ?? ''
}

function timeoutSignal(): AbortSignal | undefined {
  const withTimeout = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  return typeof withTimeout.timeout === 'function' ? withTimeout.timeout(UPSTREAM_TIMEOUT_MS) : undefined
}

class UpstreamError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail || `上游返回 ${status}`)
    this.status = status
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  })
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 按配置解析该用哪个后端；都不存在则返回 null（前端会切演示语料） */
function resolveProvider(requested: string): { id: ProviderId; key: string } | null {
  const forced = requested.trim().toLowerCase()
  if (forced && (PROVIDER_ORDER as string[]).includes(forced)) {
    const key = readEnv(PROVIDER_ENV[forced as ProviderId])
    if (key) return { id: forced as ProviderId, key }
  }
  for (const id of PROVIDER_ORDER) {
    const key = readEnv(PROVIDER_ENV[id])
    if (key) return { id, key }
  }
  return null
}

async function postJson(url: string, key: string, body: unknown): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    })
  } catch (error) {
    throw new UpstreamError(502, error instanceof Error ? error.message : '检索服务不可达')
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new UpstreamError(response.status, detail.slice(0, 500))
  }
  return response.json().catch(() => ({}))
}

/** Tavily：返回已抽正文 content 与相关性 score，质量最稳但国内注册门槛高 */
async function searchTavily(key: string, opts: SearchOptions): Promise<NormalizedResult[]> {
  const data = (await postJson(TAVILY_ENDPOINT, key, {
    query: opts.query,
    max_results: opts.count,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
    topic: opts.topic === 'news' ? 'news' : 'general',
  })) as { results?: { title?: string; url?: string; content?: string; published_date?: string; score?: number }[] }

  return (data.results ?? []).map((item, index) => ({
    title: pickString(item.title),
    url: pickString(item.url),
    content: pickString(item.content),
    published_date: pickString(item.published_date),
    score: typeof item.score === 'number' ? item.score : opts.count - index,
  }))
}

/** 博查：中文语境更好，自带语义重排，因此保持上游顺序即可，不额外打分 */
async function searchBocha(key: string, opts: SearchOptions): Promise<NormalizedResult[]> {
  const data = (await postJson(BOCHA_ENDPOINT, key, {
    query: opts.query,
    count: opts.count,
    freshness: opts.topic === 'news' ? 'oneWeek' : 'noLimit',
    summary: true,
  })) as {
    webPages?: { value?: unknown[] }
    data?: { webPages?: { value?: unknown[] } }
    code?: number
    msg?: string
  }

  if (typeof data.code === 'number' && data.code !== 200 && data.code !== 0) {
    throw new UpstreamError(502, pickString(data.msg) || `博查返回 code=${data.code}`)
  }

  // 不同版本的响应外层可能包一层 data，两种都兼容
  const list = (data.webPages?.value ?? data.data?.webPages?.value ?? []) as {
    name?: string
    url?: string
    snippet?: string
    summary?: string
    datePublished?: string
  }[]

  return list.map((item, index) => ({
    title: pickString(item.name),
    url: pickString(item.url),
    content: pickString(item.summary) || pickString(item.snippet),
    published_date: pickString(item.datePublished),
    score: opts.count - index,
  }))
}

/** Serper：Google 结果，注册无需信用卡，作为第三档备份 */
async function searchSerper(key: string, opts: SearchOptions): Promise<NormalizedResult[]> {
  const data = (await postJson(opts.topic === 'news' ? SERPER_NEWS_ENDPOINT : SERPER_ENDPOINT, key, {
    q: opts.query,
    num: opts.count,
    gl: 'cn',
    hl: 'zh-cn',
  })) as { organic?: { title?: string; link?: string; snippet?: string; date?: string }[] }

  return (data.organic ?? []).map((item, index) => ({
    title: pickString(item.title),
    url: pickString(item.link),
    content: pickString(item.snippet),
    published_date: pickString(item.date),
    score: opts.count - index,
  }))
}

const PROVIDER_RUNNERS: Record<ProviderId, (key: string, opts: SearchOptions) => Promise<NormalizedResult[]>> = {
  tavily: searchTavily,
  bocha: searchBocha,
  serper: searchSerper,
}

/** 同一篇文章可能被不同引擎重复返回，按规范化 URL 去重，保留分数更高者 */
function dedupe(results: NormalizedResult[]): NormalizedResult[] {
  const byUrl = new Map<string, NormalizedResult>()
  for (const item of results) {
    const key = item.url
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .split('#')[0]
      .toLowerCase()
    if (!key) continue
    const existing = byUrl.get(key)
    if (!existing || item.score > existing.score) byUrl.set(key, item)
  }
  return [...byUrl.values()]
}

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const configured = resolveProvider(readEnv('SEARCH_PROVIDER'))

  if (request.method === 'GET') {
    return json({
      ok: true,
      keyConfigured: Boolean(configured),
      provider: configured?.id ?? '',
      available: PROVIDER_ORDER.filter((id) => Boolean(readEnv(PROVIDER_ENV[id]))),
    })
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  if (!configured) {
    return json(
      {
        error: 'missing_key',
        message: '站点未配置检索密钥（BOCHA_API_KEY / TAVILY_API_KEY / SERPER_API_KEY 任一即可）',
      },
      401,
    )
  }

  let payload: { query?: string; count?: number; topic?: string; provider?: string }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const query = pickString(payload.query)
  if (!query) {
    return json({ error: 'query_required' }, 400)
  }

  const count = Math.min(Math.max(Number(payload.count ?? 5), 1), 10)
  const topic: 'general' | 'news' = payload.topic === 'news' ? 'news' : 'general'

  // 请求可覆盖后端，用于前端做「多后端对比」；未指定则用服务端配置
  const requested = pickString(payload.provider).toLowerCase()
  const chosen =
    requested && (PROVIDER_ORDER as string[]).includes(requested) && readEnv(PROVIDER_ENV[requested as ProviderId])
      ? { id: requested as ProviderId, key: readEnv(PROVIDER_ENV[requested as ProviderId]) }
      : configured

  try {
    const raw = await PROVIDER_RUNNERS[chosen.id](chosen.key, { query, count, topic })
    const results = dedupe(raw.filter((item) => item.url && (item.content || item.title)))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)

    return json({ results, provider: chosen.id })
  } catch (error) {
    if (error instanceof UpstreamError) {
      const status = error.status === 429 ? 429 : 502
      return json(
        { error: 'upstream_error', provider: chosen.id, status: error.status, message: error.message },
        status,
      )
    }
    return json(
      { error: 'unknown_error', provider: chosen.id, message: error instanceof Error ? error.message : '检索失败' },
      502,
    )
  }
}

export const config = {
  path: '/api/search',
  cache: 'manual' as const,
}
