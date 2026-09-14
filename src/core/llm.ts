/**
 * LLM 客户端 —— 统一的 OpenAI 兼容协议调用层。
 *
 * 两条通道：
 *   A. 代理通道（默认）：POST /api/llm → Netlify Edge Function 注入服务端密钥后转发。
 *      好处是访客不需要自备 key，而且密钥永不落到浏览器。
 *   B. 直连通道（兜底）：本地 `vite dev` 没有边缘函数运行时，或访客想用自己的 key 时，
 *      直接从浏览器调用供应商端点。
 *
 * 关键实现点：
 * - 流式解析按行缓冲，容忍 SSE 半包；
 * - 对 429/5xx 做指数退避重试；
 * - 代理返回 404/405 时自动降级到直连，保证本地开发不阻塞；
 * - 单独累积 reasoning_content（推理型模型），不混进正文。
 */

import type { AppSettings } from './config'
import { estimateTokens, parseJsonLoose, sleep } from './utils'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  temperature?: number
  stream?: boolean
  maxTokens?: number
  onToken?: (delta: string) => void
  signal?: AbortSignal
  /** 仅用于日志与错误定位 */
  label?: string
}

export interface ChatResult {
  text: string
  reasoning: string
  promptTokens: number
  completionTokens: number
  model: string
  /** 本次调用走的是代理还是直连 */
  channel: 'proxy' | 'direct'
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

/** 代理不可用时置位，避免每个节点都白白多试一次 */
let proxyDisabled = false

export function resetProxyState(): void {
  proxyDisabled = false
}

interface Prepared {
  url: string
  headers: Record<string, string>
  channel: 'proxy' | 'direct'
}

function prepare(settings: AppSettings, preferDirect: boolean): Prepared {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '')
  const useProxy = settings.useProxy && !proxyDisabled && !preferDirect
  if (useProxy) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-llm-model': settings.model,
      'x-llm-base-url': baseUrl,
    }
    if (settings.apiKey) headers['x-llm-key'] = settings.apiKey
    return { url: '/api/llm', headers, channel: 'proxy' }
  }
  if (!settings.apiKey) {
    throw new LlmError('未配置 API Key：请等待站点服务端密钥，或在设置中填入自己的 Key')
  }
  if (!baseUrl) {
    throw new LlmError('未配置 Base URL：请在设置中填写 OpenAI 兼容端点地址')
  }
  return {
    url: `${baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    channel: 'direct',
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), ms)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

async function readStream(
  response: Response,
  onToken?: (delta: string) => void,
): Promise<{ text: string; reasoning: string; promptTokens: number; completionTokens: number; model: string }> {
  const reader = response.body?.getReader()
  if (!reader) throw new LlmError('上游未返回可读流')
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let text = ''
  let reasoning = ''
  let promptTokens = 0
  let completionTokens = 0
  let model = ''

  const consume = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const chunk = JSON.parse(payload) as {
        model?: string
        choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (chunk.model) model = chunk.model
      const delta = chunk.choices?.[0]?.delta
      if (delta?.reasoning_content) reasoning += delta.reasoning_content
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content
        onToken?.(delta.content)
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens
        completionTokens = chunk.usage.completion_tokens ?? completionTokens
      }
    } catch {
      /* 半包或非 JSON 帧，忽略 */
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
  }
  if (buffer) consume(buffer)

  return { text, reasoning, promptTokens, completionTokens, model }
}

async function requestOnce(
  prepared: Prepared,
  settings: AppSettings,
  options: ChatOptions,
): Promise<ChatResult> {
  const stream = options.stream ?? false
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.3,
    stream,
  }
  if (options.maxTokens) body.max_tokens = options.maxTokens
  if (prepared.channel === 'proxy') body.channel = 'proxy'

  const { signal, cleanup } = withTimeout(options.signal, stream ? 300_000 : 120_000)
  try {
    const response = await fetch(prepared.url, {
      method: 'POST',
      headers: prepared.headers,
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        `模型调用失败（${response.status}）：${detail.slice(0, 400) || response.statusText}`,
        response.status,
      )
    }

    if (stream) {
      const parsed = await readStream(response, options.onToken)
      return {
        ...parsed,
        promptTokens: parsed.promptTokens || estimateTokens(JSON.stringify(options.messages)),
        completionTokens: parsed.completionTokens || estimateTokens(parsed.text),
        model: parsed.model || settings.model,
        channel: prepared.channel,
      }
    }

    const json = (await response.json()) as {
      model?: string
      choices?: { message?: { content?: string; reasoning_content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const text = json.choices?.[0]?.message?.content ?? ''
    const reasoning = json.choices?.[0]?.message?.reasoning_content ?? ''
    return {
      text,
      reasoning,
      promptTokens: json.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(options.messages)),
      completionTokens: json.usage?.completion_tokens ?? estimateTokens(text),
      model: json.model ?? settings.model,
      channel: prepared.channel,
    }
  } finally {
    cleanup()
  }
}

export async function chat(options: ChatOptions, settings: AppSettings): Promise<ChatResult> {
  const errors: string[] = []
  let preferDirect = false

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('运行已取消', 'AbortError')
    let prepared: Prepared
    try {
      prepared = prepare(settings, preferDirect)
    } catch (error) {
      throw error
    }

    try {
      return await requestOnce(prepared, settings, options)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)

      // 代理不存在（本地 vite dev）→ 立刻降级直连，不再重试代理
      if (prepared.channel === 'proxy' && error instanceof LlmError && error.status && [404, 405, 501].includes(error.status)) {
        proxyDisabled = true
        preferDirect = true
        continue
      }
      // 代理没收到 key（服务端未配置）→ 若访客自填了 key，降级直连
      if (prepared.channel === 'proxy' && error instanceof LlmError && [401, 403].includes(error.status ?? 0) && settings.apiKey) {
        preferDirect = true
        continue
      }
      // 限流或上游抖动 → 退避重试
      if (error instanceof LlmError && error.status && [429, 500, 502, 503, 504].includes(error.status)) {
        await sleep(600 * (attempt + 1), options.signal)
        continue
      }
      if (error instanceof TypeError) {
        await sleep(500 * (attempt + 1), options.signal)
        continue
      }
      throw error instanceof Error ? error : new LlmError(message)
    }
  }

  throw new LlmError(`模型调用连续失败：${errors[errors.length - 1] ?? '未知错误'}`)
}

/** 结构化节点专用：要求模型输出 JSON，并用容错解析器兜底 */
export async function chatJson<T extends object>(
  options: ChatOptions,
  settings: AppSettings,
  fallback: T,
): Promise<{ data: T; raw: string; result: ChatResult }> {
  const result = await chat({ ...options, stream: false }, settings)
  const data = parseJsonLoose<T>(result.text, fallback)
  return { data, raw: result.text, result }
}
