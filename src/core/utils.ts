/** 通用工具层：JSON 容错解析、类型强制转换、去重与格式化。 */

/** 从 LLM 返回的文本里抠出 JSON 主体（容忍 ```json 包裹与前后废话） */
export function extractJsonBlock(text: string): string {
  let cleaned = (text ?? '').trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json|JSON)?/, '').trim()
    cleaned = cleaned.replace(/```$/, '').trim()
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1)
  }
  return cleaned
}

/** 宽松 JSON 解析：先标准解析，失败后做常见修补，最终回落到 fallback */
export function parseJsonLoose<T>(text: string, fallback: T): T {
  const body = extractJsonBlock(text)
  const attempts: string[] = [
    body,
    body.replace(/,\s*([}\]])/g, '$1'),
    body.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'),
    body.replace(/\/\/[^\n]*/g, '').replace(/,\s*([}\]])/g, '$1'),
  ]
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object') return value as T
    } catch {
      continue
    }
  }
  return fallback
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number.parseFloat(asString(value, ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const text = asString(value, '').trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(text)) return true
  if (['false', '0', 'no', 'n'].includes(text)) return false
  return fallback
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asStringArray(value: unknown, limit = 40): string[] {
  const source = Array.isArray(value) ? value : []
  const output: string[] = []
  for (const item of source) {
    const text = asString(item, '').trim()
    if (text && !output.includes(text)) output.push(text)
    if (output.length >= limit) break
  }
  return output
}

export function asRecordArray(value: unknown, limit = 200): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, limit)
}

export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const output: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    output.push(item)
  }
  return output
}

export function truncate(text: string, max: number): string {
  const value = text ?? ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 安全序列化：用于把状态片段塞进 prompt，避免超长把上下文打爆 */
export function safeJson(value: unknown, maxLength = 6000): string {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return truncate(text ?? '', maxLength)
}

/** 粗略 token 估算：中文约 1 字 1 token，英文约 4 字符 1 token */
export function estimateTokens(text: string): number {
  const value = text ?? ''
  const cjk = (value.match(/[\u4e00-\u9fff]/g) ?? []).length
  const rest = value.length - cjk
  return Math.ceil(cjk + rest / 4)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('运行已取消', 'AbortError'))
      },
      { once: true },
    )
  })
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
