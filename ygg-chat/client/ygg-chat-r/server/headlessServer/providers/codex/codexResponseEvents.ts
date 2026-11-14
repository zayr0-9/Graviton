import type { ProviderPartialOutput } from '../providerTypes.js'
import type { CodexParseResult, CodexResponseParseOptions } from './types.js'

type State = {
  content: string
  visibleContent: string
  reasoningParts: string[]
  toolCalls: NonNullable<CodexParseResult['toolCalls']>
  generatedImages: NonNullable<CodexParseResult['generatedImages']>
  providerStopReason: string
  responseId: string
  usage: any
  outputItems: any[]
  responseItemsAdded: any[]
  eventCounts: Map<string, number>
  itemPhases: Map<string, string>
  itemText: Map<string, string>
  textParts: Map<string, Map<number, string>>
  reasoningTextParts: Map<string, Map<string, string>>
  displayBlocks: Map<string, any>
  lastTextItem?: string
  options: CodexResponseParseOptions
}

export function createCodexResponseParseState(options: CodexResponseParseOptions = {}): State {
  const state: State = {
    content: '',
    visibleContent: '',
    reasoningParts: [],
    toolCalls: [],
    generatedImages: [],
    providerStopReason: '',
    responseId: '',
    usage: undefined,
    outputItems: [],
    responseItemsAdded: [],
    eventCounts: new Map(),
    itemPhases: new Map(),
    itemText: new Map(),
    textParts: new Map(),
    reasoningTextParts: new Map(),
    displayBlocks: new Map(),
    options,
  }
  options.registerPartialOutput?.(() => codexPartialOutputFromState(state))
  return state
}

export function codexResponseParseResult(state: State): CodexParseResult {
  const reasoningContent = canonicalReasoningText(state.reasoningParts)
  const outputItems = stripDuplicateReasoningFromOutputItems(state.outputItems, reasoningContent)
  return {
    content: selectFinalText(state),
    contentBlocks: Array.from(state.displayBlocks.values())
      .filter(block => block.type === 'tool_use' || block.content?.trim())
      .map((block, index) => ({ ...block, index })),
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls: dedupeToolCalls(state.toolCalls),
    ...(state.providerStopReason ? { providerStopReason: state.providerStopReason } : {}),
    ...(state.generatedImages.length ? { generatedImages: state.generatedImages } : {}),
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
    ...(outputItems.length ? { outputItems } : {}),
    ...(state.responseItemsAdded.length ? { responseItemsAdded: state.responseItemsAdded } : {}),
    debug: {
      eventCounts: Object.fromEntries(state.eventCounts.entries()),
      outputItemCount: outputItems.length,
      addedItemCount: state.responseItemsAdded.length,
    },
  }
}

/**
 * R1(a): whatever this stream had accumulated at the moment it failed, in the
 * shape every provider uses (`err.partialOutput`).
 *
 * Deliberately reuses `codexResponseParseResult`, so a partial is assembled by the
 * exact same text/reasoning/tool-call selection as a successful run — a failure
 * must not produce differently-shaped text from a success. Ordered display blocks
 * include commentary even when the selected answer is still empty.
 */
export function codexPartialOutputFromState(state: State): ProviderPartialOutput {
  const result = codexResponseParseResult(state)
  return {
    ...(result.content ? { content: result.content } : {}),
    contentBlocks: result.contentBlocks,
    ...(result.reasoningContent ? { reasoning: result.reasoningContent } : {}),
    ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
  }
}

export function processCodexResponseEventText(text: string, state: State, eventHint = ''): void {
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return
  }
  processCodexResponsePayload(payload, state, eventHint)
}

export function processCodexResponsePayload(payload: any, state: State, eventHint = ''): void {
  const eventType = eventHint || payload?.type || ''
  state.eventCounts.set(eventType || 'unknown', (state.eventCounts.get(eventType || 'unknown') || 0) + 1)
  switch (eventType) {
    case 'response.output_text.delta': {
      const delta = String(payload.delta ?? '')
      const itemId = getPayloadItemId(payload)
      const parts = state.textParts.get(itemId) || new Map<number, string>()
      const index = payload.content_index ?? 0
      parts.set(index, (parts.get(index) || '') + delta)
      state.textParts.set(itemId, parts)
      appendOutputText(state, itemId, delta)
      state.options.onTextDelta?.(delta)
      const phase = itemId ? state.itemPhases.get(itemId) : ''
      if (phase !== 'commentary') state.visibleContent += delta
      updateDisplayText(state, itemId, delta, false)
      break
    }
    case 'response.output_text.done': {
      const itemId = getPayloadItemId(payload)
      const parts = state.textParts.get(itemId) || new Map<number, string>()
      parts.set(payload.content_index ?? 0, String(payload.text ?? ''))
      state.textParts.set(itemId, parts)
      const text = [...parts].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
      const existing = itemId ? state.itemText.get(itemId) || '' : ''
      const suffix = text.startsWith(existing) ? text.slice(existing.length) : !existing ? text : ''
      if (suffix) {
        appendOutputText(state, itemId, suffix)
        const phase = itemId ? state.itemPhases.get(itemId) : ''
        if (phase !== 'commentary') state.visibleContent += suffix
      }
      if (text) updateDisplayText(state, itemId, text, true)
      break
    }
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta': {
      const delta = textFromUnknown(payload.delta)
      if (delta) {
        state.options.onReasoningDelta?.(delta)
        state.options.emit?.({ type: 'chunk', part: 'reasoning', delta })
      }
      appendReasoning(state, payload.delta)
      const key = `reasoning:${getPayloadItemId(payload) || 'unknown'}`
      const parts = state.reasoningTextParts.get(key) || new Map<string, string>()
      const partKey = `${eventType}:${payload.summary_index ?? payload.content_index ?? 0}`
      parts.set(partKey, (parts.get(partKey) || '') + delta)
      state.reasoningTextParts.set(key, parts)
      state.displayBlocks.set(key, { type: 'thinking', content: canonicalReasoningText([...parts.values()]) })
      break
    }
    case 'response.output_item.added': {
      const item = payload.item
      const id = item?.id || `output-${payload.output_index ?? state.displayBlocks.size}`
      // Reserve the provider's item order even if text arrives only in done/completed.
      const type = item?.type === 'reasoning' ? 'thinking'
        : item?.type === 'message' || item?.type === 'output_message' ? 'text' : undefined
      const key = type === 'thinking' ? `reasoning:${id}` : `text:${id}`
      if (type && !state.displayBlocks.has(key)) state.displayBlocks.set(key, { type, content: '' })
      if (item?.type === 'function_call') {
        const toolKey = `tool:${item.call_id || item.id}`
        if (!state.displayBlocks.has(toolKey)) state.displayBlocks.set(toolKey, { type: 'pending' })
      }
      rememberItemPhase(payload.item, state)
      if (payload.item) state.responseItemsAdded.push(payload.item)
      break
    }
    case 'response.output_item.done': {
      const item = enrichMessageItemWithStreamedText(payload.item || payload.output_item || payload, state)
      rememberItemPhase(item, state)
      if (item) state.responseItemsAdded.push(item)
      if (isHostedToolOutputItem(item)) state.outputItems.push(item)
      collectOutputItem(item, state, `output-${payload.output_index ?? state.displayBlocks.size}`)
      break
    }
    case 'response.completed':
    case 'response.done':
      state.providerStopReason = eventType
      captureCompletedResponseMetadata(payload.response, state)
      collectResponseOutput(payload.response, state)
      break
    case 'response.failed':
      throw new Error(`Codex response failed${payload.response?.error?.message ? `: ${payload.response.error.message}` : ''}`)
    case 'response.incomplete': {
      const message = payload.response?.error?.message || payload.response?.incomplete_details?.reason || 'OpenAI response was incomplete.'
      throw new Error(message)
    }
    case 'error':
      throw new Error(typeof payload.error?.message === 'string' ? payload.error.message : 'OpenAI websocket returned an error event.')
    default:
      if (payload?.type === 'function_call') collectOutputItem(payload, state)
      break
  }
}

/** Display every assistant message, independently of the answer selected for loop control. */
function updateDisplayText(state: State, itemId: string, text: string, done: boolean): void {
  if (!text) return
  const key = `text:${itemId || 'unknown'}`
  const previous = state.displayBlocks.get(key)?.content || ''
  const content = done ? text : previous + text
  state.displayBlocks.set(key, { type: 'text', content })
  const delta = done ? content.startsWith(previous) ? content.slice(previous.length) : '' : text
  if (delta) {
    // The shared text stream has no item-boundary event. Keep adjacent assistant
    // messages readable without adding protocol/UI types just for Codex.
    const separator = state.lastTextItem && state.lastTextItem !== key ? '\n\n' : ''
    state.lastTextItem = key
    state.options.emit?.({ type: 'chunk', part: 'text', delta: separator + delta })
  }
}

function getPayloadItemId(payload: any): string {
  return typeof payload?.item_id === 'string'
    ? payload.item_id
    : typeof payload?.itemId === 'string'
      ? payload.itemId
      : ''
}

function appendOutputText(state: State, itemId: string, text: string): void {
  if (!text) return
  state.content += text
  if (itemId) state.itemText.set(itemId, `${state.itemText.get(itemId) || ''}${text}`)
}

function rememberItemPhase(item: any, state: State): void {
  const id = typeof item?.id === 'string' ? item.id : ''
  const phase = typeof item?.phase === 'string' ? item.phase : ''
  if (id && phase) state.itemPhases.set(id, phase)
}

function enrichMessageItemWithStreamedText(item: any, state: State): any {
  if (!item || typeof item !== 'object') return item
  if (item.type !== 'message' && item.type !== 'output_message') return item
  const id = typeof item.id === 'string' ? item.id : ''
  const streamedText = id ? state.itemText.get(id) || '' : ''
  if (!streamedText || outputTextFromItem(item).trim()) return item
  return { ...item, content: [{ type: 'output_text', text: streamedText }] }
}

function captureCompletedResponseMetadata(response: any, state: State): void {
  if (!response || typeof response !== 'object') return
  if (typeof response.id === 'string') state.responseId = response.id
  if (response.usage !== undefined) state.usage = response.usage
  if (Array.isArray(response.output))
    state.outputItems = response.output.map((item: any) => enrichMessageItemWithStreamedText(item, state))
}

function collectResponseOutput(response: any, state: State): void {
  if (!Array.isArray(response?.output)) return
  response.output.forEach((item: any, index: number) =>
    collectOutputItem(enrichMessageItemWithStreamedText(item, state), state, `output-${index}`))
}

function collectOutputItem(item: any, state: State, fallbackId = 'unknown'): void {
  if (!item || typeof item !== 'object') return
  if (item.type === 'reasoning') {
    const text = reasoningTextFromItem(item)
    appendReasoning(state, text)
    const key = `reasoning:${item.id || fallbackId}`
    const previous = state.displayBlocks.get(key)?.content || ''
    const content = canonicalReasoningText([previous, text])
    if (content) {
      state.displayBlocks.set(key, { type: 'thinking', content })
      const delta = content.startsWith(previous) ? content.slice(previous.length) : ''
      if (delta) state.options.emit?.({ type: 'chunk', part: 'reasoning', delta })
    }
    return
  }
  if (item.type === 'function_call') {
    state.displayBlocks.set(`tool:${item.call_id || item.id}`, {
      type: 'tool_use', id: item.call_id || item.id, name: String(item.name || 'unknown_tool'), input: parseArgs(item.arguments),
    })
    state.toolCalls.push({
      id: item.call_id || item.id,
      name: String(item.name || 'unknown_tool'),
      arguments: parseArgs(item.arguments),
      status: 'pending',
    })
    return
  }
  if (item.type === 'image_generation_call' || item.type === 'generated_image') {
    const url = item.url || item.image_url
    const dataUrl = dataUrlFromImageItem(item)
    const mimeType = mimeTypeFromImageItem(item)
    state.generatedImages.push({ ...(url ? { url } : {}), ...(dataUrl ? { dataUrl } : {}), ...(mimeType ? { mimeType } : {}) })
    return
  }
  if (item.type === 'message' || item.type === 'output_message') {
    const text = outputTextFromItem(item)
    if (text && !state.content) {
      state.content += text
      if (item.phase !== 'commentary') state.visibleContent += text
    }
    updateDisplayText(state, typeof item.id === 'string' ? item.id : fallbackId, text, true)
  }
}

function selectFinalText(state: State): string {
  const streamFallback = state.options.allowCommentaryFallbackText ? state.content.trim() : state.visibleContent.trim()
  const messages = Array.isArray(state.outputItems)
    ? state.outputItems
        .filter(item => item?.type === 'message' || item?.type === 'output_message')
        .map(item => {
          const id = typeof item.id === 'string' ? item.id : ''
          const phase = typeof item.phase === 'string' ? item.phase : id ? state.itemPhases.get(id) || '' : ''
          const itemText = outputTextFromItem(item)
          const streamedText = id ? state.itemText.get(id) || '' : ''
          return { phase, text: itemText.trim() ? itemText : streamedText }
        })
        .filter(item => item.text.trim())
    : []

  const finalAnswer = [...messages].reverse().find(item => item.phase === 'final_answer')
  if (finalAnswer?.text.trim()) return finalAnswer.text

  const nonCommentary = [...messages].reverse().find(item => item.phase !== 'commentary')
  if (nonCommentary?.text.trim()) return nonCommentary.text

  if (state.options.allowCommentaryFallbackText) {
    const commentary = [...messages].reverse().find(item => item.phase === 'commentary')
    if (commentary?.text.trim()) return commentary.text
  }

  return streamFallback
}

function appendReasoning(state: State, value: unknown): void {
  for (const text of textPartsFromUnknown(value)) {
    mergeReasoningSegment(state.reasoningParts, text)
  }
}

function canonicalReasoningText(parts: string[]): string {
  const merged: string[] = []
  for (const part of parts) mergeReasoningSegment(merged, part)
  return merged.join('\n\n').trim()
}

function mergeReasoningSegment(parts: string[], value: string): void {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return

  const normalizedText = normalizeReasoningText(text)
  if (!normalizedText) return

  for (let index = parts.length - 1; index >= 0; index--) {
    const existing = parts[index]
    const normalizedExisting = normalizeReasoningText(existing)
    if (!normalizedExisting) {
      parts.splice(index, 1)
      continue
    }

    if (normalizedExisting === normalizedText) return

    if (normalizedExisting.includes(normalizedText)) {
      return
    }

    if (normalizedText.includes(normalizedExisting)) {
      parts.splice(index, 1)
      continue
    }

    if (areSimilarReasoningSegments(normalizedExisting, normalizedText)) {
      if (normalizedText.length > normalizedExisting.length) {
        parts.splice(index, 1)
        continue
      }
      return
    }
  }

  parts.push(text)
}

function normalizeReasoningText(value: string): string {
  return value
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function areSimilarReasoningSegments(normalizedA: string, normalizedB: string): boolean {
  if (!normalizedA || !normalizedB) return false

  const [headingA] = normalizedA.split(/\n|\. /)
  const [headingB] = normalizedB.split(/\n|\. /)
  if (headingA && headingB && headingA === headingB && Math.min(normalizedA.length, normalizedB.length) > 80) {
    return true
  }

  const wordsA = new Set(normalizedA.match(/[a-z0-9']+/g) || [])
  const wordsB = new Set(normalizedB.match(/[a-z0-9']+/g) || [])
  if (wordsA.size < 8 || wordsB.size < 8) return false

  let overlap = 0
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++
  }

  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.65
}

function isHostedToolOutputItem(item: any): boolean {
  return item?.type === 'web_search_call' || item?.type === 'image_generation_call' || item?.type === 'generated_image'
}

function reasoningTextFromItem(item: any): string {
  // Must not pass `textPartsFromUnknown` directly: flatMap invokes its callback as
  // (value, index, array), so the element index would bind to the `allowedTypes`
  // parameter and `allowedTypes.has(type)` would throw on a number.
  return canonicalReasoningText(
    [item.summary, item.content, item.text, item.delta].flatMap(value => textPartsFromUnknown(value))
  )
}

function stripDuplicateReasoningFromOutputItems(items: any[], canonicalReasoning: string): any[] {
  if (!Array.isArray(items) || !canonicalReasoning.trim()) return Array.isArray(items) ? items : []

  return items.map(item => {
    if (!item || typeof item !== 'object' || item.type !== 'reasoning') return item
    return stripDuplicateReasoningFromItem(item, canonicalReasoning)
  })
}

function stripDuplicateReasoningFromItem(item: any, canonicalReasoning: string): any {
  const stripped = { ...item }
  const canonicalNormalized = normalizeReasoningText(canonicalReasoning)
  const stripParts = (parts: any): any => {
    if (!Array.isArray(parts)) return parts
    return parts.map(part => {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part
      const partNormalized = normalizeReasoningText(part.text)
      if (!partNormalized || canonicalNormalized === partNormalized || canonicalNormalized.includes(partNormalized)) {
        const { text: _text, ...rest } = part
        return rest
      }
      return part
    })
  }

  stripped.summary = stripParts(stripped.summary)
  stripped.content = stripParts(stripped.content)
  if (typeof stripped.text === 'string' && canonicalNormalized.includes(normalizeReasoningText(stripped.text))) {
    delete stripped.text
  }
  if (typeof stripped.delta === 'string' && canonicalNormalized.includes(normalizeReasoningText(stripped.delta))) {
    delete stripped.delta
  }
  return stripped
}

function outputTextFromItem(item: any): string {
  return textPartsFromUnknown(item.content, new Set(['output_text', 'text'])).join('')
}

function textFromUnknown(value: unknown): string {
  return textPartsFromUnknown(value).join('')
}

function textPartsFromUnknown(value: unknown, allowedTypes?: Set<string>): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return []
  if (Array.isArray(value)) return value.flatMap(item => textPartsFromUnknown(item, allowedTypes))
  if (typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (allowedTypes && type && !allowedTypes.has(type)) return []
  const parts: string[] = []
  if (typeof record.text === 'string') parts.push(record.text)
  if (typeof record.delta === 'string') parts.push(record.delta)
  if (typeof record.content === 'string') parts.push(record.content)
  return parts
}

function parseArgs(value: unknown): any {
  if (typeof value !== 'string') return value ?? {}
  if (!value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function dedupeToolCalls(toolCalls: NonNullable<CodexParseResult['toolCalls']>): NonNullable<CodexParseResult['toolCalls']> {
  const seen = new Set<string>()
  const result = []
  for (const call of toolCalls) {
    const key = call.id || `${call.name}:${JSON.stringify(call.arguments)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(call)
  }
  return result
}

function dataUrlFromImageItem(item: any): string | undefined {
  const value = typeof item?.result === 'string' ? item.result : typeof item?.dataUrl === 'string' ? item.dataUrl : ''
  if (!value) return undefined
  if (/^data:[^;]+;base64,/i.test(value)) return value
  return `data:${mimeTypeFromImageItem(item) || 'image/png'};base64,${value}`
}

function mimeTypeFromImageItem(item: any): string | undefined {
  const explicit = typeof item?.mimeType === 'string' ? item.mimeType : typeof item?.mime_type === 'string' ? item.mime_type : ''
  if (explicit) return explicit
  const format = String(item?.output_format || item?.format || '').trim().toLowerCase()
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'png') return 'image/png'
  if (item?.result || item?.dataUrl) return 'image/png'
  return undefined
}
