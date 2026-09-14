/**
 * Netlify Edge Function：/api/search
 *
 * 代理 Tavily 检索 API。放在服务端有两个原因：
 *   1. 隐藏 TAVILY_API_KEY，访客无需自备密钥；
 *   2. 浏览器直连第三方检索 API 会遇到 CORS，服务端代理顺带解决跨域。
 *
 * 未配置密钥时返回 401 + error=missing_key，
 * 前端据此把网络检索切换到内置演示语料，保证流水线不中断。
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

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

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const apiKey = readEnv('TAVILY_API_KEY')

  if (request.method === 'GET') {
    return json({ ok: true, keyConfigured: Boolean(apiKey) })
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  if (!apiKey) {
    return json({ error: 'missing_key', message: '站点未配置 TAVILY_API_KEY' }, 401)
  }

  let payload: { query?: string; count?: number; topic?: string }
  try {
    payload = (await request.json()) as typeof payload
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const query = (payload.query ?? '').trim()
  if (!query) {
    return json({ error: 'query_required' }, 400)
  }

  const maxResults = Math.min(Math.max(Number(payload.count ?? 5), 1), 10)

  let upstream: Response
  try {
    upstream = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        topic: payload.topic === 'news' ? 'news' : 'general',
      }),
    })
  } catch (error) {
    return json({ error: 'upstream_unreachable', message: error instanceof Error ? error.message : '检索服务不可达' }, 502)
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return json(
      {
        error: 'upstream_error',
        status: upstream.status,
        message: detail.slice(0, 500) || `检索上游返回 ${upstream.status}`,
      },
      upstream.status === 429 ? 429 : 502,
    )
  }

  const data = (await upstream.json().catch(() => ({}))) as {
    results?: { title?: string; url?: string; content?: string; published_date?: string; score?: number }[]
  }

  // 顺带做一次服务端相关性排序，减少前端无效上下文
  const results = (data.results ?? [])
    .map((item) => ({
      title: (item.title ?? '').trim(),
      url: (item.url ?? '').trim(),
      content: (item.content ?? '').trim(),
      published_date: item.published_date ?? '',
      score: typeof item.score === 'number' ? item.score : 0,
    }))
    .filter((item) => item.url && (item.content || item.title))
    .sort((a, b) => b.score - a.score)

  return json({ results })
}

export const config = {
  path: '/api/search',
  cache: 'manual' as const,
}
