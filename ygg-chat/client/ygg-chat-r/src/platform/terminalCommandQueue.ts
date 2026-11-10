/** Preserve keystroke/resize order over HTTP. An uncertain write must not be
 * retried or followed by later buffered input on the same terminal. */
export class TerminalCommandQueue {
  private tails = new Map<string, Promise<unknown>>()
  private failed = new Set<string>()
  private counts = new Map<string, number>()
  run<T>(id: string, command: () => Promise<T>): Promise<T> {
    if (this.failed.has(id)) return Promise.reject(new Error('Terminal input delivery is uncertain. Close and reopen this terminal before sending more input.'))
    const count = this.counts.get(id) ?? 0
    if (count >= 256) return Promise.reject(new Error('Terminal input queue is full. Wait before typing more.'))
    this.counts.set(id, count + 1)
    const result = (this.tails.get(id) ?? Promise.resolve()).then(() => {
      if (this.failed.has(id)) throw new Error('Terminal input delivery is uncertain')
      return command()
    }).catch(error => { this.failed.add(id); throw error })
    const settled = result.then(() => {}, () => {}).finally(() => {
      this.counts.set(id, (this.counts.get(id) ?? 1) - 1)
      if (this.tails.get(id) === settled) { this.tails.delete(id); this.counts.delete(id) }
    })
    this.tails.set(id, settled)
    return result
  }
  close(id: string): void { this.failed.add(id) }
}
