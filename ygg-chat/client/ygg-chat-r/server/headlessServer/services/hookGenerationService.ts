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
    const selected = this.selection()
    if (activeGenerations >= 2) throw new HookGenerationError('Hook generation is busy. Try again after the current hooks finish.', 429)
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(abort, 40000)
    let work: Promise<{ text: string; modelName: string }> | undefined
    activeGenerations++
    try {
      controller.signal.throwIfAborted()
      work = selected.provider === 'claudecode'
        ? (this.deps.claude ?? generateClaudeHook)({ content: body.content, systemPrompt: body.systemPrompt ?? '', model: selected.modelName, signal: controller.signal })
        : this.deps.openAi({ content: body.content, systemPrompt: body.systemPrompt ?? '', modelName: selected.modelName, signal: controller.signal })
      // Provider calls also receive the signal; bound the HTTP lifetime even if an adapter stalls.
      const result = await new Promise<{ text: string; modelName: string }>((resolve, reject) => {
        const cancelled = () => reject(new HookGenerationError('Hook generation cancelled or timed out.', 504))
        controller.signal.addEventListener('abort', cancelled, { once: true })
        if (controller.signal.aborted) cancelled()
        work!.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled))
      })
      if (!result.text?.trim() || result.text.length > 128000) throw new HookGenerationError('The selected hook provider returned an empty or oversized response.')
      return { success: true, provider: selected.provider, modelName: result.modelName, text: result.text,
        message: { role: 'assistant', content: result.text } }
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
