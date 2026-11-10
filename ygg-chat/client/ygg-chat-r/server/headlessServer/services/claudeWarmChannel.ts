/**
 * Primitives for a Claude CLI process that outlives one Graviton run (warm sessions).
 *
 * `InputChannel` is the process's single SDK prompt stream: every run, and the queue inside a run,
 * pushes into it, and only closing it ends the CLI.
 *
 * `EventPump` lets consecutive readers (a run, the idle drainer, the next run) share one SDK
 * iterator. `next()` keeps returning the same read until `consume()`, so a read left waiting when
 * one reader stops is handed, unresolved, to the next one: nothing is lost or read twice (CLI
 * 2.1.318: a read held while idle resolves with the next turn's first event).
 */
export class InputChannel<T> {
  private readonly items: T[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(item: T): boolean {
    if (this.closed) return false
    this.items.push(item)
    this.wake?.()
    return true
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  get isClosed(): boolean { return this.closed }

  async *stream(): AsyncGenerator<T> {
    while (true) {
      const next = this.items.shift()
      if (next !== undefined) { yield next; continue }
      if (this.closed) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = null
    }
  }
}

export class EventPump<T> {
  private readonly iterator: AsyncIterator<T>
  private pending: Promise<IteratorResult<T>> | null = null
  private finished = false
  private resolveExit!: () => void
  /** Settles once a read sees the iterator end or throw (the CLI exited or was killed). Never rejects. */
  readonly exited = new Promise<void>(resolve => { this.resolveExit = resolve })

  constructor(source: AsyncIterable<T>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  private finish() {
    this.finished = true
    this.resolveExit()
  }

  /** The SDK iterator is finished: no event will ever arrive again. */
  get done(): boolean { return this.finished }

  /**
   * The outstanding read, or a new one; it pulls one event, like the SDK's own iterator, so hook
   * callbacks and events keep the order a lazy reader sees. Call `consume()` once handled.
   */
  next(): Promise<IteratorResult<T>> {
    if (!this.pending) {
      this.pending = this.iterator.next().then(result => {
        if (result.done) this.finish()
        return result
      }, error => {
        this.finish()
        throw error
      })
      // A reader may stop waiting (a run that parks); a later failure must not go unhandled.
      this.pending.catch(() => {})
    }
    return this.pending
  }

  /** The read was handled; the next `next()` reads a new event. */
  consume(): void { this.pending = null }

  /** Reads and drops events until the iterator ends, or `timeoutMs` passes. */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.finished) {
      const left = deadline - Date.now()
      if (left <= 0) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), left) })
      try {
        if (await Promise.race([this.next(), late]) === 'late') return
        this.consume()
      } catch {
        this.consume()
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
