import { getAuthManager } from '../../auth/runtime.js'
import { readHostExecutionPreferences } from '../../hostExecutionStore.js'
import type { HostHookGeneration } from '../../../../../shared/hostHookGeneration.js'
import { generateClaudeHook, HookGenerationError } from './claudeHookGeneration.js'
import { resolveClaudeExecutable } from './claudeProcessConfig.js'

export { HookGenerationError }
export interface HookGenerationDeps {
  preferences?: () => HostHookGeneration
  openAiStatus?: () => string
  claude?: typeof generateClaudeHook
  openAi: (input: { content: string; systemPrompt: string; modelName: string; signal: AbortSignal }) => Promise<{ text: string; modelName: string }>
}
type JsonObject = Record<string, unknown>
type GenerationResult = { text: string; modelName: string; structured?: JsonObject }
const isJsonObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const REPAIR_INSTRUCTION = '\n\nYour previous reply was not a valid JSON object. Reply again with only the JSON object described in the instructions: no prose, no markdown fences.'

/** Lenient object extraction for providers without native structured output. */
export function parseJsonObject(text: string): JsonObject | null {
  const trimmed = text.trim()
  const attempt = (candidate: string) => { try { const value = JSON.parse(candidate); return isJsonObject(value) ? value : null } catch { return null } }
  const direct = attempt(trimmed)
  if (direct) return direct
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
  return start >= 0 && end > start ? attempt(trimmed.slice(start, end + 1)) : null
}

function validResponseSchema(value: unknown): value is JsonObject {
  if (!isJsonObject(value) || value.type !== 'object') return false
  try { return JSON.stringify(value).length <= 16000 } catch { return false }
}
let activeGenerations = 0
export class HookGenerationService {
  constructor(private readonly deps: HookGenerationDeps) {}
  private selection() {
    const preferences = this.deps.preferences ? this.deps.preferences() : (() => {
      const stored = readHostExecutionPreferences()
      if (stored.repairNeeded) throw new HookGenerationError('Repair host execution settings before generating hook text.', 503)
      return stored.values.hookGeneration
    })()
    const openAiStatus = preferences.provider === 'claudecode' ? 'not_checked'
      : (this.deps.openAiStatus ?? (() => getAuthManager().snapshot('codex').status))()
    const provider = preferences.provider === 'auto'
      ? ['signed_out', 'reauth_required'].includes(openAiStatus) ? 'claudecode' : 'openaichatgpt'
      : preferences.provider
    return { provider, modelName: provider === 'claudecode' ? preferences.claudeModel : preferences.openAiModel, openAiStatus }
  }
  async availability() {
    const selected = this.selection()
    const claudeInstalled = await resolveClaudeExecutable().then(() => true, () => false)
    return { ...selected, claudeInstalled, claudeLogin: 'not_checked' }
  }
  async generate(body: any, signal?: AbortSignal) {
    if (!body || typeof body.content !== 'string' || !body.content.trim() || body.content.length > 128000 ||
      (body.systemPrompt !== undefined && (typeof body.systemPrompt !== 'string' || body.systemPrompt.length > 32000)) ||
      (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 0))) throw new HookGenerationError('Hook generation requires bounded content and systemPrompt, without history.', 400)
    if (body.responseSchema !== undefined && !validResponseSchema(body.responseSchema)) throw new HookGenerationError('responseSchema must be a bounded JSON Schema with type "object".', 400)
    const responseSchema: JsonObject | undefined = body.responseSchema
    const selected = this.selection()
    if (activeGenerations >= 2) throw new HookGenerationError('Hook generation is busy. Try again after the current hooks finish.', 429)
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(abort, 40000)
    let work: Promise<GenerationResult> | undefined
    let attempts = 0
    activeGenerations++
    try {
      const systemPrompt = body.systemPrompt ?? ''
      const callProvider = (content: string): Promise<GenerationResult> => {
        controller.signal.throwIfAborted()
        attempts++
        return selected.provider === 'claudecode'
          ? (this.deps.claude ?? generateClaudeHook)({ content, systemPrompt, model: selected.modelName, signal: controller.signal, jsonSchema: responseSchema })
          : this.deps.openAi({ content, systemPrompt, modelName: selected.modelName, signal: controller.signal })
      }
      // Claude enforces the schema natively. Other providers get one same-provider repair attempt
      // inside the same slot and deadline when their reply does not contain a JSON object.
      const run = async (): Promise<GenerationResult> => {
        const first = await callProvider(body.content)
        if (!responseSchema || isJsonObject(first.structured)) return first
        const parsed = first.text ? parseJsonObject(first.text) : null
        if (parsed) return { ...first, structured: parsed }
        const second = await callProvider(body.content + REPAIR_INSTRUCTION)
        const repaired = second.text ? parseJsonObject(second.text) : null
        if (!repaired) throw new HookGenerationError('The selected hook provider did not return a JSON object after a retry.', 502)
        return { ...second, structured: repaired }
      }
      work = run()
      // Provider calls also receive the signal; bound the HTTP lifetime even if an adapter stalls.
      const result = await new Promise<GenerationResult>((resolve, reject) => {
        const cancelled = () => reject(new HookGenerationError('Hook generation cancelled or timed out.', 504))
        controller.signal.addEventListener('abort', cancelled, { once: true })
        if (controller.signal.aborted) cancelled()
        work!.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled))
      })
      if (!result.text?.trim() || result.text.length > 128000) throw new HookGenerationError('The selected hook provider returned an empty or oversized response.')
      return { success: true, provider: selected.provider, modelName: result.modelName, text: result.text,
        ...(responseSchema ? { structured: result.structured, structuredMode: selected.provider === 'claudecode' ? 'native' : 'parsed' } : {}),
        attempts, message: { role: 'assistant', content: result.text } }
    } catch (error) {
      if (error instanceof HookGenerationError) throw error
      throw new HookGenerationError(controller.signal.aborted ? 'Hook generation cancelled or timed out.'
        : 'The selected hook provider failed. Check its host login, model access and account limits; no other provider was tried.', controller.signal.aborted ? 504 : 502)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      // A cancelled adapter must actually settle before its resource slot is reusable.
      if (work) void work.then(() => { activeGenerations-- }, () => { activeGenerations-- })
      else activeGenerations--
    }
  }
}
