import { SnapshotEventJournal, SnapshotPayloadStore } from './snapshotPayloadStore.js'
import { isFullAccessNotification } from '../../../../../shared/accessNotifications.js'
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import type { MainRunBootstrap, RunProjectionEvent } from '../../../../../shared/runProtocol.js'

/** Materialized current turn plus latest control state, independent of replay retention. */
export class RunSnapshotProjector {
  private started: RunProjectionEvent | undefined
  private user: RunProjectionEvent | undefined
  private priorAnchor: RunProjectionEvent | undefined
  private currentAnchor: RunProjectionEvent | undefined
  private readonly turn: SnapshotEventJournal<RunProjectionEvent>
  constructor(payloads?: SnapshotPayloadStore) { this.turn = new SnapshotEventJournal(payloads) }
  private latest = new Map<string, RunProjectionEvent>()
  private terminal: RunProjectionEvent | undefined
  private queueRevision = 0
  private readonly rowIds = new Set<string>()

  referencedMessageIds(): string[] { return [...this.rowIds] }

  apply(event: HeadlessStreamEvent): void {
    if (event.type === 'bootstrap' || event.type === 'child_bootstrap' || event.type === 'snapshot_reference' || event.type === 'event_reference') return
    if ('message' in event && event.message?.id) this.rowIds.add(event.message.id)
    if (event.type === 'context_compaction' && event.summaryMessage?.id) this.rowIds.add(event.summaryMessage.id)
    if (event.type === 'started' && event.parentId) this.rowIds.add(event.parentId)
    if (event.type === 'started') { this.started = structuredClone(event); return }
    if (event.type === 'user_message_persisted') {
      if (!isFullAccessNotification(event.message)) this.user = structuredClone(event)
      return
    }
    if (event.type === 'message_queue_updated') { this.queueRevision = event.snapshot.revision; this.latest.set(event.type, structuredClone(event)); return }
    if (event.type === 'permission_required' || event.type === 'clarify_required' || event.type === 'operation_mode_upgrade_required' || event.type === 'decision_settled') return
    if (event.type === 'complete' || (event.type === 'error' && event.terminal !== false)) { this.terminal = structuredClone(event); return }
    if (event.type === 'assistant_message_persisted' || event.type === 'queued_user_message_persisted' || event.type === 'compaction_control_persisted') this.currentAnchor = structuredClone(event)
    if (event.type === 'tool_loop' && event.status === 'turn_started') {
      this.priorAnchor = this.currentAnchor
      this.turn.reset()
    }
    if (['provider_routed', 'tools_updated', 'context_usage', 'context_compaction', 'operation_mode_changed'].includes(event.type)) {
      this.latest.set(event.type, structuredClone(event)); return
    }
    this.turn.append(event)
  }

  snapshot(input: Omit<MainRunBootstrap, 'kind' | 'schema' | 'events' | 'queueRevision'>): MainRunBootstrap {
    const prefix = [this.started, this.user, this.priorAnchor, ...this.latest.values()]
      .filter((event): event is RunProjectionEvent => Boolean(event))
    const turn = this.turn.snapshot()
    // Compact adjacent text chunks for small inline turns only.
    const compact: RunProjectionEvent[] = []
    for (const event of turn.events) {
      const last = compact.at(-1)
      if (event.type === 'chunk' && (event.part === 'text' || event.part === 'reasoning') && last?.type === 'chunk' && last.part === event.part)
        compact[compact.length - 1] = { ...event, delta: (last as typeof event).delta + event.delta }
      else compact.push(event)
    }
    const events = [...prefix, ...compact, ...(this.terminal ? [this.terminal] : [])]
    return structuredClone({ ...input, kind: 'main', schema: 1, events,
      ...(turn.eventsReference ? { eventsReference: turn.eventsReference, eventsOffset: prefix.length } : {}), queueRevision: this.queueRevision })
  }
}
