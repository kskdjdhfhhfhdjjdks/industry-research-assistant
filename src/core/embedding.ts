/**
 * 向量化层 —— 双后端设计，保证「任何环境下都能跑」。
 *
 * 后端 A：本地特征哈希（默认，零依赖、零下载、确定性）
 *   对中文做字符 1~2 gram、英文做词 1~2 gram 的特征哈希（signed hashing trick），
 *   L2 归一化后得到 512 维向量。它本质上是「带权词袋」的向量化表达，
 *   配合余弦相似度即可完成检索，且完全可离线。
 *
 * 后端 B：语义模型（可选，按需从 CDN 懒加载）
 *   Xenova/bge-small-zh-v1.5，同样是 512 维 —— 与后端 A 维度一致，
 *   所以数据库里 vector(512) 这一列可以同时容纳两种向量，切换后端无需改表。
 *
 * 这个设计的好处：即使模型下载失败、或者用户在弱网环境，
 * 「本地知识库检索」这条链路依然可用，只是精度略低。
 */

export const EMBEDDING_DIM = 512
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3'
const SEMANTIC_MODEL = 'Xenova/bge-small-zh-v1.5'

export type EmbeddingBackend = 'hash' | 'semantic'

export interface EmbeddingState {
  backend: EmbeddingBackend
  loading: boolean
  message: string
}

let semanticExtractor: ((texts: string[], options: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) | null = null
let semanticFailed = false

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 抽取特征：中文按字组合，英文按词组合 */
function extractFeatures(text: string): string[] {
  const normalized = (text ?? '').toLowerCase()
  const features: string[] = []

  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i += 1) {
      features.push(run[i])
      if (i + 1 < run.length) features.push(run.slice(i, i + 2))
    }
  }

  const latinWords = normalized.match(/[a-z0-9][a-z0-9+#._-]*/g) ?? []
  for (let i = 0; i < latinWords.length; i += 1) {
    features.push(latinWords[i])
    if (i + 1 < latinWords.length) features.push(`${latinWords[i]} ${latinWords[i + 1]}`)
  }

  return features
}

export function hashEmbed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  const features = extractFeatures(text)
  if (features.length === 0) return vector
  for (const feature of features) {
    const hash = fnv1a(feature)
    const index = hash % EMBEDDING_DIM
    // 用高位做符号位，降低哈希碰撞带来的系统性偏差
    const sign = (hash >>> 31) === 0 ? 1 : -1
    vector[index] += sign
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
  }
  return vector
}

/** 懒加载语义模型；失败则永久降级，不反复重试 */
async function ensureSemantic(): Promise<boolean> {
  if (semanticExtractor) return true
  if (semanticFailed) return false
  try {
    const mod = (await import(/* @vite-ignore */ TRANSFORMERS_CDN)) as {
      env: { allowLocalModels: boolean; useBrowserCache: boolean }
      pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
    }
    mod.env.allowLocalModels = false
    mod.env.useBrowserCache = true
    const pipe = (await mod.pipeline('feature-extraction', SEMANTIC_MODEL, {
      dtype: 'q8',
      progress_callback: () => undefined,
    })) as (texts: string[], options: Record<string, unknown>) => Promise<{ tolist(): number[][] }>
    semanticExtractor = pipe
    return true
  } catch {
    semanticFailed = true
    return false
  }
}

export async function embedTexts(
  texts: string[],
  options: { semantic?: boolean } = {},
): Promise<{ vectors: number[][]; backend: EmbeddingBackend }> {
  if (options.semantic) {
    const ready = await ensureSemantic()
    if (ready && semanticExtractor) {
      try {
        const output = await semanticExtractor(texts, { pooling: 'mean', normalize: true })
        const list = output.tolist()
        if (Array.isArray(list) && list.length === texts.length && list[0]?.length) {
          return { vectors: list, backend: 'semantic' }
        }
      } catch {
        semanticFailed = true
      }
    }
  }
  return { vectors: texts.map((text) => hashEmbed(text)), backend: 'hash' }
}

export async function embedQuery(text: string, options: { semantic?: boolean } = {}): Promise<{ vector: number[]; backend: EmbeddingBackend }> {
  const { vectors, backend } = await embedTexts([text], options)
  return { vector: vectors[0] ?? hashEmbed(text), backend }
}

/** 余弦相似度（pgvector 用的是 1 - cosine_distance，这里给本地兜底使用） */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function embeddingStatus(): EmbeddingState {
  if (semanticExtractor) return { backend: 'semantic', loading: false, message: `语义向量已就绪（${SEMANTIC_MODEL}）` }
  if (semanticFailed) return { backend: 'hash', loading: false, message: '语义模型不可用，已降级为特征哈希向量' }
  return { backend: 'hash', loading: false, message: '当前使用特征哈希向量（可选开启语义向量）' }
}
