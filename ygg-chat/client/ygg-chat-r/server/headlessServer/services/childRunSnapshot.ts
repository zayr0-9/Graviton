import { SnapshotEventJournal } from './snapshotPayloadStore.js'
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { hostEpoch } from '../../hostEpoch.js'
import type { RunSession } from './runSessionRegistry.js'

/** Child transcript rows remain in their own repository. This is only the
 * unfinished text/reasoning tail consumed by the transcript observer. */
export function installChildRunSnapshot(session: RunSession, subagentRunId: string, readPersisted?: () => import('../../../../../shared/types.js').SubagentRunRow | null): void {
  const tail = new SnapshotEventJournal<HeadlessStreamEvent>(session.snapshotPayloads)
  session.setProjector((event: HeadlessStreamEvent) => {
    if (event.type === 'assistant_message_persisted' || (event.type === 'tool_loop' && event.status === 'turn_started')) {
      tail.reset()
    } else if (event.type === 'chunk' && (event.part === 'text' || event.part === 'reasoning')) {
      tail.append(event)
    }
  })
  session.setChildSnapshotProvider(() => {
    const captured = tail.snapshot()
    let text = ''; let reasoning = ''
    for (const event of captured.events) {
      if (event.type === 'chunk' && event.part === 'text') text += event.delta
      if (event.type === 'chunk' && event.part === 'reasoning') reasoning += event.delta
    }
    return { kind: 'child', schema: 1, epoch: hostEpoch, streamId: session.streamId,
      conversationId: session.conversationId!, subagentRunId, persistedRun: readPersisted?.() ?? undefined, stateSeq: session.latestSeq,
      text, reasoning, ...(captured.eventsReference ? { eventsReference: captured.eventsReference } : {}), terminal: session.isTerminal() }
  })
}
