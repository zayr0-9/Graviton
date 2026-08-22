export type LmStudioEmbeddingInputType = 'query' | 'document' | 'none'

export const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234/v1'
export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = 'text-embedding-nomic-embed-text-v1.5'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function resolveLmStudioBaseUrl(baseUrl?: string): string {
  const trimmed = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  if (trimmed) return normalizeBaseUrl(trimmed)

  const envBaseUrl = typeof process.env.LMSTUDIO_BASE_URL === 'string' ? process.env.LMSTUDIO_BASE_URL.trim() : ''
  if (envBaseUrl) return normalizeBaseUrl(envBaseUrl)

  return DEFAULT_LMSTUDIO_BASE_URL
}

function resolveEmbeddingModel(model?: string): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (trimmed) return trimmed

  const envModel = typeof process.env.LMSTUDIO_EMBEDDING_MODEL === 'string' ? process.env.LMSTUDIO_EMBEDDING_MODEL.trim() : ''
  if (envModel) return envModel

  return DEFAULT_LMSTUDIO_EMBEDDING_MODEL
}

function normalizeInputType(inputType?: string): LmStudioEmbeddingInputType {
  const normalized = typeof inputType === 'string' ? inputType.trim().toLowerCase() : ''
  if (normalized === 'query') return 'query'
  if (normalized === 'document') return 'document'
  return 'none'
}

function formatInput(text: string, inputType: LmStudioEmbeddingInputType): string {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('embedding input text must be non-empty')
  }

  if (inputType === 'query') return `search_query: ${trimmed}`
  if (inputType === 'document') return `search_document: ${trimmed}`
  return trimmed
}

function normalizeEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.map(item => Number(item)).filter(item => Number.isFinite(item))
}

export function getLmStudioBaseUrl(baseUrl?: string): string {
  return resolveLmStudioBaseUrl(baseUrl)
}

export async function embedTexts(params: {
  inputs: string[]
  model?: string
  inputType?: LmStudioEmbeddingInputType
  baseUrl?: string
}): Promise<{
  model: string
  inputType: LmStudioEmbeddingInputType
  dimensions: number
  embeddings: number[][]
}> {
  if (!Array.isArray(params.inputs) || params.inputs.length === 0) {
    throw new Error('inputs must be a non-empty string array')
  }

  const inputType = normalizeInputType(params.inputType)
  const formattedInputs = params.inputs.map(input => {
    if (typeof input !== 'string') {
      throw new Error('inputs must contain only strings')
    }
    return formatInput(input, inputType)
  })

  const model = resolveEmbeddingModel(params.model)
  const baseUrl = resolveLmStudioBaseUrl(params.baseUrl)

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: formattedInputs,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`LM Studio embeddings request failed (${response.status}): ${text}`)
  }

  const json = (await response.json()) as any
  const data = Array.isArray(json?.data) ? json.data : []
  if (data.length !== formattedInputs.length) {
    throw new Error(`LM Studio embeddings response size mismatch: expected ${formattedInputs.length}, got ${data.length}`)
  }

  const indexedVectors = data
    .map((item: any, index: number) => ({
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index,
      embedding: normalizeEmbeddingVector(item?.embedding),
    }))
    .sort((a: { index: number }, b: { index: number }) => a.index - b.index)

  const embeddings = indexedVectors.map((item: { embedding: number[] }) => item.embedding)
  const dimensions = embeddings[0]?.length || 0
  if (!dimensions) {
    throw new Error('LM Studio embeddings response did not include a valid embedding vector')
  }

  if (embeddings.some((embedding: number[]) => embedding.length !== dimensions)) {
    throw new Error('LM Studio embeddings response contained inconsistent embedding dimensions')
  }

  return {
    model: typeof json?.model === 'string' && json.model.trim().length > 0 ? json.model.trim() : model,
    inputType,
    dimensions,
    embeddings,
  }
}

export async function embedText(params: {
  text: string
  model?: string
  inputType?: LmStudioEmbeddingInputType
  baseUrl?: string
}): Promise<{
  model: string
  inputType: LmStudioEmbeddingInputType
  dimensions: number
  embedding: number[]
}> {
  if (typeof params.text !== 'string' || !params.text.trim()) {
    throw new Error('text must be a non-empty string')
  }

  const result = await embedTexts({
    inputs: [params.text],
    model: params.model,
    inputType: params.inputType,
    baseUrl: params.baseUrl,
  })

  return {
    model: result.model,
    inputType: result.inputType,
    dimensions: result.dimensions,
    embedding: result.embeddings[0],
  }
}
