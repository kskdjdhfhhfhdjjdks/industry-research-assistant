/**
 * 网络检索客户端 —— 走 Netlify 边缘函数代理，后端可插拔。
 *
 * 前端不关心用的是哪家检索服务：边缘函数会把 Tavily / 博查 / Serper 的
 * 返回差异统一成同一格式，这里只负责把记录转成 SourceRecord。
 *
 * 为什么默认推荐博查（Bocha）：国际检索 API 大多需要国外信用卡，
 * 博查是国内合规服务，支持支付宝/微信充值，新账号有免费额度，对个人项目最友好。
 *
 * 无 key 时的行为：返回空数组，由上层（web_search 节点）切到演示语料，
 * 保证整条流水线在任何情况下都能跑完，不会卡死。
 */

import type { SourceRecord } from './types'

export type SearchStatus = 'ok' | 'unconfigured' | 'proxy-missing' | 'error'

export interface SearchResponse {
  records: SourceRecord[]
  status: SearchStatus
  message: string
  /** 实际生效的检索后端，便于在设置面板里展示 */
  provider?: string
}

let proxyMissing = false
let lastUnconfigured = false
let lastProvider = ''

export function resetSearchState(): void {
  proxyMissing = false
  lastUnconfigured = false
  lastProvider = ''
}

export function searchHealth(): { proxyMissing: boolean; unconfigured: boolean; provider: string } {
  return { proxyMissing, unconfigured: lastUnconfigured, provider: lastProvider }
}

function toDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    const cleaned = url.replace(/^https?:\/\//, '')
    return cleaned.split('/')[0] ?? ''
  }
}

export async function webSearch(
  query: string,
  options: { count?: number; signal?: AbortSignal; topic?: 'general' | 'news'; provider?: string } = {},
): Promise<SearchResponse> {
  const count = options.count ?? 6
  if (proxyMissing) {
    return { records: [], status: 'proxy-missing', message: '检索代理不可用（本地未启动 netlify dev）' }
  }

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        count,
        topic: options.topic ?? 'general',
        ...(options.provider ? { provider: options.provider } : {}),
      }),
      signal: options.signal,
    })

    if (response.status === 404 || response.status === 405) {
      proxyMissing = true
      return { records: [], status: 'proxy-missing', message: '检索代理未部署，已跳过网络检索' }
    }

    const payload = (await response.json().catch(() => ({}))) as {
      results?: { title?: string; url?: string; content?: string; published_date?: string }[]
      provider?: string
      error?: string
      message?: string
    }

    if (payload.provider) lastProvider = payload.provider

    if (response.status === 401 || payload.error === 'missing_key') {
      lastUnconfigured = true
      return {
        records: [],
        status: 'unconfigured',
        message: '服务端未配置检索密钥（博查 / Tavily / Serper 任一即可）',
      }
    }

    if (!response.ok) {
      return { records: [], status: 'error', message: payload.message ?? `检索失败（${response.status}）` }
    }

    const records: SourceRecord[] = (payload.results ?? [])
      .map((item, index) => {
        const url = (item.url ?? '').trim()
        return {
          source_id: `WEB-raw-${index + 1}`,
          title: (item.title ?? url ?? `检索结果 ${index + 1}`).trim(),
          url,
          domain: toDomain(url),
          snippet: (item.content ?? '').trim(),
          source_type: 'web' as const,
          published_at: item.published_date ?? '',
        }
      })
      .filter((item) => item.snippet || item.title)

    return { records, status: 'ok', message: `命中 ${records.length} 条`, provider: lastProvider }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      records: [],
      status: 'error',
      message: error instanceof Error ? error.message : '网络检索异常',
    }
  }
}
