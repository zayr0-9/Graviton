import { attachPartialOutput } from '../openRouterProvider.js'
import type { CodexParseResult, CodexResponseParseOptions } from './types.js'
import {
  codexPartialOutputFromState,
  codexResponseParseResult,
  createCodexResponseParseState,
  processCodexResponseEventText,
} from './codexResponseEvents.js'

export async function parseCodexSseResponse(response: Response, options: CodexResponseParseOptions = {}): Promise<CodexParseResult> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`ChatGPT backend request failed (${response.status}): ${text}`)
  }
  if (!response.body && !options.reader) return parseCodexSseText(await response.text(), options)
  const state = createCodexResponseParseState(options)
  const decoder = new TextDecoder()
  const reader = options.reader || response.body?.getReader()
  if (!reader) throw new Error('ChatGPT backend request returned no readable stream body')
  let buffer = ''
  let pendingRead = options.firstRead ?? null
  // R1(a): one boundary for every mid-stream failure this transport can raise —
  // a rejected read (socket reset, timeout, abort) and a thrown terminal frame
  // (`response.failed` / `response.incomplete` / `error`) alike — so the text
  // already streamed to the user rides out on the error instead of being lost.
  try {
    for (;;) {
      const readResult = pendingRead ?? (await reader.read())
      pendingRead = null
      const { value, done } = readResult
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      const frames = buffer.split(/\n\n+/)
      buffer = frames.pop() || ''
      for (const frame of frames) if (frame.trim()) processFrameText(frame, state)
    }
    buffer += decoder.decode()
    if (buffer.trim()) processFrameText(buffer, state)
  } catch (error) {
    throw attachPartialOutput(error, codexPartialOutputFromState(state))
  }
  return codexResponseParseResult(state)
}

export function parseCodexSseText(text: string, options: CodexResponseParseOptions = {}): CodexParseResult {
  const state = createCodexResponseParseState(options)
  try {
    for (const frame of splitFrames(text)) processFrameText(frame, state)
  } catch (error) {
    // Non-streamed body, but frames are still replayed through `emit`, so a
    // terminal error frame can land after the user has already seen text.
    throw attachPartialOutput(error, codexPartialOutputFromState(state))
  }
  return codexResponseParseResult(state)
}

function processFrameText(frame: string, state: ReturnType<typeof createCodexResponseParseState>): void {
  const parsed = parseFrame(frame)
  if (!parsed || parsed.data === '[DONE]') return
  processCodexResponseEventText(parsed.data, state, parsed.event)
}

function splitFrames(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n\n+/).filter(frame => frame.trim())
}

function parseFrame(frame: string): { event?: string; data: string } | null {
  let event = ''
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  return { ...(event ? { event } : {}), data: data.join('\n') }
}
