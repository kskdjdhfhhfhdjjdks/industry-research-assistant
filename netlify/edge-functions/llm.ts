/**
 * Netlify Edge Function：/api/llm
 *
 * 这是整个项目里唯一接触密钥、也唯一需要服务端的地方。
 *
 * 为什么用 Edge Function 而不是普通 Function：
 *   Netlify 普通同步函数 60s、流式函数 10s 上限，而一份 3000 字研报的流式生成
 *   很容易超过 10s。Edge Function 的 CPU 预算只有 50ms，但官方明确说明
 *   「等待网络/上游的时间不计入 CPU」——所以只要不做逐帧解析，
 *   把 upstream.body 直接当作响应体返回（零拷贝），就能长时间稳定透传 SSE。
 *
 * 安全模型：
 *   - 服务端密钥（DEEPSEEK_API_KEY）永远不会随响应下发；仅当请求未自带密钥时使用。
 *   - 使用服务端密钥时，强制使用服务端配置的 baseUrl，忽略客户端传入的地址，
 *     避免这个接口被当成「拿我的额度去请求任意主机」的跳板。
 *   - 客户端自带密钥（x-llm-key）时才允许指定 baseUrl，此时消耗的是访客自己的额度。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-llm-key, x-llm-model, x-llm-base-url',
}

export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const serverKey = readEnv('DEEPSEEK_API_KEY') || readEnv('LLM_API_KEY')
  const serverBaseUrl = (readEnv('LLM_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const serverModel = readEnv('LLM_MODEL') || DEFAULT_MODEL

  // 能力探查：前端用它决定「走真实链路」还是「切演示模式」，不消耗任何额度
  if (request.method === 'GET') {
    return json(
      {
        ok: true,
        keyConfigured: Boolean(serverKey),
        defaultModel: serverModel,
        baseUrl: serverBaseUrl,
      },
      200,
    )
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  let payload: Record<string, unknown>
  try {
    payload = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const clientKey = (request.headers.get('x-llm-key') ?? '').trim()
  const clientBaseUrl = (request.headers.get('x-llm-base-url') ?? '').trim()
  const clientModel = (request.headers.get('x-llm-model') ?? '').trim()

  const usingServerKey = !clientKey
  if (usingServerKey && !serverKey) {
    return new Response(JSON.stringify({ error: 'missing_key', message: '站点未配置模型密钥' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    })
  }

  const key = clientKey || serverKey
  const baseUrl = (usingServerKey ? serverBaseUrl : clientBaseUrl || serverBaseUrl).replace(/\/+$/, '')
  const model = clientModel || serverModel
  const stream = payload.stream === true

  const messages = payload.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages_required' }, 400)
  }

  const upstreamBody: Record<string, unknown> = {
    model,
    messages,
    stream,
  }
  if (typeof payload.temperature === 'number') upstreamBody.temperature = payload.temperature
  if (typeof payload.max_tokens === 'number') upstreamBody.max_tokens = payload.max_tokens

  let upstream: Response
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(upstreamBody),
    })
  } catch (error) {
    return json(
      { error: 'upstream_unreachable', message: error instanceof Error ? error.message : '上游不可达' },
      502,
    )
  }

  if (!upstream.ok) {
    // 直接把上游的错误体透传出去，方便前端展示真实原因（额度不足 / key 无效等）
    const detail = await upstream.text().catch(() => '')
    let parsed: unknown = null
    try {
      parsed = JSON.parse(detail)
    } catch {
      parsed = { message: detail.slice(0, 600) }
    }
    return new Response(JSON.stringify(parsed ?? { error: 'upstream_error' }), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    })
  }

  if (!stream) {
    const text = await upstream.text()
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
    })
  }

  if (!upstream.body) {
    return json({ error: 'upstream_no_body' }, 502)
  }

  // 零拷贝透传：不解码、不解析、不缓冲，CPU 占用接近 0
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS_HEADERS,
    },
  })
}

export const config = {
  path: '/api/llm',
  cache: 'manual' as const,
}
