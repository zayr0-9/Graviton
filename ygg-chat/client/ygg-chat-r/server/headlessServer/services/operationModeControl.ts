import { parseMessageMeta, renderSystemReminder } from '../../../../../shared/contextInjection.js'
import { requiresAgentMode, type OperationMode } from '../../../../../shared/operationModeToolPolicy.js'

export function lastAnnouncedMode(history: any[]): OperationMode | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const meta = parseMessageMeta(history[index]?.meta)
    if (meta?.kind === 'operation_mode_change' && (meta.mode === 'plan' || meta.mode === 'execute')) return meta.mode
  }
  return null
}

export function modeNotificationContent(mode: OperationMode): string {
  return renderSystemReminder([
    `Operation mode: ${mode === 'plan' ? 'Chat (plan)' : 'Agent (execute)'}.\nApply the corresponding mode section in the system instructions from now on. This is a mode notification, not a request for a response.`,
  ])
}

/** Run-local dispatch policy and ordered transcript changes. Never cancels executing tools. */
export class OperationModeControl {
  mode: OperationMode
  revision = 0
  closed = false
  private pending: Array<{ mode: OperationMode; previousMode: OperationMode; revision: number }> = []
  private requests = new Map<string, { mode: OperationMode; revision: number }>()

  constructor(mode: OperationMode, private onChange?: (mode: OperationMode) => void) {
    this.mode = mode
  }

  change(mode: OperationMode, requestId: string): { mode: OperationMode; revision: number } {
    const previous = this.requests.get(requestId)
    if (previous) {
      if (previous.mode !== mode) throw new Error('Mode request id was already used for another mode')
      return previous
    }
    if (this.closed) throw new Error('Run has completed; reload the branch before switching modes')
    if (this.pending.length >= 100) throw new Error('Too many pending mode changes')
    if (this.mode !== mode) {
      const previousMode = this.mode
      this.mode = mode
      this.revision++
      this.pending.push({ mode, previousMode, revision: this.revision })
      this.onChange?.(mode)
    }
    const result = { mode, revision: this.revision }
    this.requests.set(requestId, result)
    if (this.requests.size > 256) this.requests.delete(this.requests.keys().next().value!)
    return result
  }

  get hasPending(): boolean { return this.pending.length > 0 }

  assertCanDispatch(call: { name: string }): void {
    if (requiresAgentMode(call, this.mode)) {
      throw new Error(`Tool "${call.name}" skipped: the current mode is Chat. Switch to Agent Mode to run this tool.`)
    }
  }

  /** Synchronous persistence keeps the queue and transcript atomic relative to HTTP commands. */
  flush(history: any[], persist: (mode: OperationMode, previousMode: OperationMode | null, revision: number) => any, throughRevision = Infinity): any[] {
    const rows: any[] = []
    while (this.pending.length && this.pending[0].revision <= throughRevision) {
      const next = this.pending[0]
      const row = persist(next.mode, next.previousMode, next.revision)
      this.pending.shift()
      rows.push(row)
    }
    if (!rows.length && throughRevision === Infinity && lastAnnouncedMode(history) !== this.mode) {
      rows.push(persist(this.mode, lastAnnouncedMode(history), this.revision))
    }
    return rows
  }
}
