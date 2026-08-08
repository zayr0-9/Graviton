import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type QueueItem = {
  dbPath: string
  query: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutMs: number
}

type WorkerResponse = {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

const DEFAULT_TIMEOUT_MS = 120_000

class LocalAnalyticsWorkerClient {
  private worker: Worker | null = null
  private nextId = 1
  private active = false
  private queue: QueueItem[] = []
  private pending = new Map<string, PendingRequest>()

  run(dbPath: string, query: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      this.queue.push({ dbPath, query, resolve, reject, timeoutMs })
      this.drain()
    })
  }

  shutdown() {
    this.rejectAll(new Error('Local analytics worker is shutting down'))
    this.queue.splice(0).forEach(item => item.reject(new Error('Local analytics worker is shutting down')))
    this.worker?.terminate().catch(() => undefined)
    this.worker = null
    this.active = false
  }

  private drain() {
    if (this.active) return
    const item = this.queue.shift()
    if (!item) return

    this.active = true
    const worker = this.ensureWorker()
    const id = String(this.nextId++)
    const timeout = setTimeout(() => {
      this.pending.delete(id)
      this.active = false
      item.reject(new Error('Local analytics request timed out'))
      this.restartWorker(new Error('Local analytics request timed out'))
      this.drain()
    }, item.timeoutMs)

    this.pending.set(id, { resolve: item.resolve, reject: item.reject, timeout })
    worker.postMessage({ id, dbPath: item.dbPath, query: item.query })
  }

  private ensureWorker() {
    if (this.worker) return this.worker

    const workerUrl = new URL('./localAnalyticsWorker.mjs', import.meta.url)
    const worker = new Worker(fileURLToPath(workerUrl))
    worker.on('message', (message: WorkerResponse) => this.handleMessage(message))
    worker.on('error', error => this.restartWorker(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (code !== 0) this.restartWorker(new Error(`Local analytics worker exited with code ${code}`))
      else this.worker = null
    })
    this.worker = worker
    return worker
  }

  private handleMessage(message: WorkerResponse) {
    const pending = this.pending.get(message.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(message.id)
    this.active = false

    if (message.ok) pending.resolve(message.data)
    else pending.reject(new Error(message.error || 'Local analytics worker failed'))

    this.drain()
  }

  private restartWorker(error: Error) {
    const worker = this.worker
    this.worker = null
    this.active = false
    this.rejectAll(error)
    if (worker) worker.terminate().catch(() => undefined)
    this.drain()
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export const localAnalyticsWorkerClient = new LocalAnalyticsWorkerClient()
