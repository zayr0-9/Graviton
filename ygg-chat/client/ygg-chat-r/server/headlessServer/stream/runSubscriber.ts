import type { Response } from 'express'
import type { RunSubscriber } from '../services/runSessionRegistry.js'

/** A slow observer has a bounded queue, never a backpressure signal to the run. */
export function createRunSubscriber(res: Response, maxQueuedBytes = 1024 * 1024): RunSubscriber {
  let blocked = false
  let ending = false
  let closed = false
  let queuedBytes = 0
  const queue: string[] = []
  const cleanup = () => {
    closed = true
    queue.length = 0
    queuedBytes = 0
    res.off('drain', drain)
  }
  const finish = () => { cleanup(); if (!res.writableEnded && !res.destroyed) res.end() }
  const drain = () => {
    if (closed) return
    blocked = false
    while (queue.length && !blocked) {
      const value = queue.shift()!
      queuedBytes -= Buffer.byteLength(value)
      blocked = res.write(value) === false
    }
    if (ending && !queue.length) finish()
  }
  res.on('drain', drain)
  res.once('close', cleanup)
  res.once('error', cleanup)
  return {
    send: frame => {
      if (closed || ending || res.writableEnded || res.destroyed) return
      const value = `data: ${JSON.stringify({ ...frame.event, seq: frame.seq })}\n\n`
      if (blocked) {
        queuedBytes += Buffer.byteLength(value)
        if (queuedBytes > maxQueuedBytes) {
          cleanup()
          res.destroy()
          return
        }
        queue.push(value)
      } else {
        blocked = res.write(value) === false
      }
    },
    end: () => {
      ending = true
      if (!queue.length) finish()
    },
  }
}
