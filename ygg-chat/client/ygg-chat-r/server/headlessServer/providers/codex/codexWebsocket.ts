import WebSocket from 'ws'
import { attachPartialOutput } from '../openRouterProvider.js'
import type { CodexParseResult, CodexResponseParseOptions } from './types.js'
import {
  codexPartialOutputFromState,
  codexResponseParseResult,
  createCodexResponseParseState,
  processCodexResponseEventText,
} from './codexResponseEvents.js'

const RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE = 'responses_websockets=2026-02-06'
const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'
const RESPONSES_LITE_CLIENT_METADATA = 'ws_request_header_x_openai_internal_codex_responses_lite'

export function codexWebSocketUrl(baseURL: string): string {
  const url = new URL(`${baseURL.replace(/\/$/, '')}/responses`)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.toString()
}

export function buildCodexWebSocketHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'accept') result[key] = value
  })
  result['OpenAI-Beta'] = RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE
  return result
}

export function buildCodexWebSocketRequestBody(body: Record<string, unknown>, headers?: Headers): Record<string, unknown> {
  const clientMetadata = {
    ...((body.client_metadata && typeof body.client_metadata === 'object' && !Array.isArray(body.client_metadata))
      ? (body.client_metadata as Record<string, unknown>)
      : {}),
    ...(headers?.get(RESPONSES_LITE_HEADER) === 'true' ? { [RESPONSES_LITE_CLIENT_METADATA]: 'true' } : {}),
    'x-codex-ws-stream-request-start-ms': String(Date.now()),
  }
  return { type: 'response.create', ...body, client_metadata: clientMetadata }
}

export async function parseCodexWebSocketResponse(options: {
  baseURL: string
  headers: Headers
  body: Record<string, unknown>
  signal?: AbortSignal
  connectTimeoutMs?: number
  idleTimeoutMs?: number
} & CodexResponseParseOptions): Promise<CodexParseResult> {
  const socket = await connect(options)
  const state = createCodexResponseParseState(options)
  try {
    await sendWithTimeout(
      socket,
      JSON.stringify(buildCodexWebSocketRequestBody(options.body, options.headers)),
      options.idleTimeoutMs ?? 120000,
      options.signal
    )
    for (;;) {
      const message = await nextMessage(socket, options.idleTimeoutMs ?? 120000, options.signal)
      if (message.kind === 'close') throw new Error(`OpenAI websocket closed before completion${message.reason ? `: ${message.reason}` : ''}`)
      if (message.kind === 'error') throw message.error
      if (message.isBinary) throw new Error('unexpected binary websocket event')
      let eventType = ''
      try {
        eventType = JSON.parse(message.text)?.type || ''
      } catch {}
      processCodexResponseEventText(message.text, state)
      if (eventType === 'response.completed' || eventType === 'response.done') return codexResponseParseResult(state)
    }
  } catch (error) {
    // R1(a): every mid-stream failure this transport can raise lands here — idle
    // timeout, user abort, socket error, close-before-completion, and the terminal
    // `response.failed` / `response.incomplete` / `error` frames thrown by the
    // parser — so the text already streamed to the user survives the throw.
    throw attachPartialOutput(error, codexPartialOutputFromState(state))
  } finally {
    closeSocket(socket)
  }
}

function connect(options: { baseURL: string; headers: Headers; signal?: AbortSignal; connectTimeoutMs?: number }): Promise<WebSocket> {
  const socket = new WebSocket(codexWebSocketUrl(options.baseURL), {
    headers: buildCodexWebSocketHeaders(options.headers),
    perMessageDeflate: true,
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(new Error('websocket connect timeout')), options.connectTimeoutMs ?? 10000)
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'))
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error) {
        closeSocket(socket)
        reject(error)
      } else resolve(socket)
    }
    const onOpen = () => finish()
    const onError = (error: Error) => finish(error)
    const onClose = (_code: number, reason: Buffer) => finish(new Error(`websocket closed before connection was established${reason?.length ? `: ${reason.toString()}` : ''}`))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('open', onOpen)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

type SocketMessage =
  | { kind: 'message'; text: string; isBinary: boolean }
  | { kind: 'error'; error: Error }
  | { kind: 'close'; code: number; reason: string }

function nextMessage(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<SocketMessage> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(undefined, new Error('idle timeout waiting for websocket')), timeoutMs)
    const onAbort = () => finish(undefined, new DOMException('Aborted', 'AbortError'))
    const finish = (message?: SocketMessage, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve(message!)
    }
    const onMessage = (data: unknown, isBinary?: boolean) => finish({ kind: 'message', text: socketDataToText(data), isBinary: Boolean(isBinary) })
    const onError = (error: Error) => finish({ kind: 'error', error })
    const onClose = (code: number, reason: Buffer) => finish({ kind: 'close', code, reason: reason?.toString('utf8') || '' })
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('message', onMessage)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

function sendWithTimeout(socket: WebSocket, data: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(new Error('idle timeout sending websocket request')), timeoutMs)
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'))
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.send(data, error => finish(error || undefined))
  })
}

function socketDataToText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

function closeSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    else if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) socket.close()
  } catch {}
}
