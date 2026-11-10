import type { SnapshotPayloadReference } from './snapshotPayload.js'
import type { HeadlessStreamEvent } from './headlessApi.js'

export type RunProjectionEvent = Exclude<HeadlessStreamEvent, { type: 'bootstrap' }>
export interface MainRunBootstrap {
  kind: 'main'
  schema: 1
  epoch: string
  streamId: string
  conversationId: string
  stateSeq: number
  /** Exact synchronous boundary rows, not a second asynchronous tree read. */
  persisted: Array<{ id: string; revision: number; row: any }>
  deletedMessageIds?: string[]
  /** Compact active-turn projection; installation never executes tools. */
  events: RunProjectionEvent[]
  eventsReference?: SnapshotPayloadReference
  eventsOffset?: number
  pendingDecisions: RunProjectionEvent[]
  queueRevision: number
  effectiveConfiguration?: { provider: string; modelName: string; fullAccess: boolean; toolAutoApprove: boolean; operationMode: 'plan' | 'execute' }
}

export interface ChildRunBootstrap {
  kind: 'child'
  schema: 1
  epoch: string
  streamId: string
  conversationId: string
  subagentRunId: string
  persistedRun?: import('./types.js').SubagentRunRow
  stateSeq: number
  text: string
  reasoning: string
  eventsReference?: SnapshotPayloadReference
  terminal: boolean
}
