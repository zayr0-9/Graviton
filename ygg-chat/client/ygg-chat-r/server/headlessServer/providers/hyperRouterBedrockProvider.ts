import { AmazonBedrockVAIProvider } from '@hyper-labs/hyper-router/providers/amazon-bedrock-vai'
import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
} from './openRouterProvider.js'
import type { ProviderTokenRecord, ProviderTokenStore } from './tokenStore.js'
import { buildContentBlocks, normalizeBearer, toHyperMessages, toHyperTools, toProviderToolCalls } from './hyperRouterAdapter.js'

interface HyperRouterBedrockProviderDeps {
  tokenStore?: ProviderTokenStore
}

type BedrockCredentials = {
  region?: string
  apiKey?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  baseURL?: string
}

const DEFAULT_BEDROCK_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0'

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (normalized) return normalized
  }
  return undefined
}

function parseCredentialPayload(raw: string | null | undefined): BedrockCredentials {
  const value = normalizeBearer(raw)
  if (!value) return {}

  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { apiKey: value }
    }

    return {
      region: firstNonEmpty(parsed.region, parsed.awsRegion, parsed.aws_region),
      apiKey: firstNonEmpty(parsed.apiKey, parsed.api_key),
      accessKeyId: firstNonEmpty(parsed.accessKeyId, parsed.access_key_id, parsed.awsAccessKeyId, parsed.aws_access_key_id),
      secretAccessKey: firstNonEmpty(
        parsed.secretAccessKey,
        parsed.secret_access_key,
        parsed.awsSecretAccessKey,
        parsed.aws_secret_access_key
      ),
      sessionToken: firstNonEmpty(parsed.sessionToken, parsed.session_token, parsed.awsSessionToken, parsed.aws_session_token),
      baseURL: firstNonEmpty(parsed.baseURL, parsed.baseUrl, parsed.base_url),
    }
  } catch {
    return { apiKey: value }
  }
}

function credentialsFromRecord(record?: ProviderTokenRecord | null): BedrockCredentials {
  return parseCredentialPayload(record?.accessToken)
}

function hasUsableCredentials(credentials: BedrockCredentials): boolean {
  if (credentials.apiKey) return true
  return Boolean(credentials.accessKeyId && credentials.secretAccessKey)
}

function mergeCredentials(...sources: BedrockCredentials[]): BedrockCredentials {
  const merged: BedrockCredentials = {}
  for (const source of sources) {
    if (!source) continue
    if (!merged.region && source.region) merged.region = source.region
    if (!merged.apiKey && source.apiKey) merged.apiKey = source.apiKey
    if (!merged.accessKeyId && source.accessKeyId) merged.accessKeyId = source.accessKeyId
    if (!merged.secretAccessKey && source.secretAccessKey) merged.secretAccessKey = source.secretAccessKey
    if (!merged.sessionToken && source.sessionToken) merged.sessionToken = source.sessionToken
    if (!merged.baseURL && source.baseURL) merged.baseURL = source.baseURL
  }
  return merged
}

function credentialsFromEnv(): BedrockCredentials {
  return {
    region: firstNonEmpty(process.env.AWS_BEDROCK_REGION, process.env.AWS_REGION, process.env.AWS_DEFAULT_REGION),
    apiKey: firstNonEmpty(process.env.AWS_BEDROCK_API_KEY, process.env.BEDROCK_API_KEY),
    accessKeyId: firstNonEmpty(process.env.AWS_ACCESS_KEY_ID, process.env.AWS_BEDROCK_ACCESS_KEY_ID),
    secretAccessKey: firstNonEmpty(process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_BEDROCK_SECRET_ACCESS_KEY),
    sessionToken: firstNonEmpty(process.env.AWS_SESSION_TOKEN, process.env.AWS_BEDROCK_SESSION_TOKEN),
    baseURL: firstNonEmpty(process.env.AWS_BEDROCK_BASE_URL, process.env.BEDROCK_BASE_URL),
  }
}

export class HyperRouterBedrockProvider implements HeadlessProvider {
  readonly name = 'bedrock'
  private readonly tokenStore?: ProviderTokenStore

  constructor(deps: HyperRouterBedrockProviderDeps = {}) {
    this.tokenStore = deps.tokenStore
  }

  private resolveCredentials(input: ProviderGenerateInput): BedrockCredentials {
    const direct = parseCredentialPayload(input.accessToken)
    const stored = input.userId ? this.tokenStore?.get('bedrock', input.userId) : this.tokenStore?.getLatest('bedrock')
    const credentials = mergeCredentials(direct, credentialsFromRecord(stored), credentialsFromEnv())

    if (!credentials.region) {
      credentials.region = 'us-east-1'
    }

    return credentials
  }

  async generate(input: ProviderGenerateInput, _emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const credentials = this.resolveCredentials(input)
    if (!hasUsableCredentials(credentials)) {
      throw new Error(
        'AWS Bedrock credentials missing. Store a Bedrock credential payload or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (plus AWS_REGION/AWS_BEDROCK_REGION).'
      )
    }

    const provider = new AmazonBedrockVAIProvider({
      region: credentials.region,
      ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
      ...(credentials.accessKeyId ? { accessKeyId: credentials.accessKeyId } : {}),
      ...(credentials.secretAccessKey ? { secretAccessKey: credentials.secretAccessKey } : {}),
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
    })

    const result = await provider.generate({
      model: input.modelName || process.env.AWS_BEDROCK_MODEL || DEFAULT_BEDROCK_MODEL,
      messages: toHyperMessages(input) as any,
      tools: toHyperTools(input),
      previousSessionMetadata: null,
    })

    const content = result.message?.content ?? ''
    const reasoning = result.message?.reasoningContent || undefined
    const toolCalls = toProviderToolCalls(result.toolCalls ?? result.message?.toolCalls)

    return {
      content,
      reasoning,
      toolCalls,
      contentBlocks: buildContentBlocks(content, reasoning, toolCalls),
      raw: result,
    }
  }
}
