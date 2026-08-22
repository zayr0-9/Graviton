import type { Response } from 'express'
import type { ChatSseEvent } from './eventTypes.js'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

export function initializeSse(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
}

export function writeSseEvent(res: Response, payload: ChatSseEvent | Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function startSseHeartbeat(res: Response, intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS): () => void {
  const heartbeatTimer = setInterval(() => {
    if ((res as any).writableEnded || (res as any).destroyed) {
      return
    }

    // SSE comment frame (ignored by data parsers but keeps the connection active)
    res.write(': heartbeat\n\n')
  }, Math.max(1_000, intervalMs))

  return () => {
    clearInterval(heartbeatTimer)
  }
}
