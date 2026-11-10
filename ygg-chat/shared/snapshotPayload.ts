/** Immutable, short-lived payload captured at a run's snapshot boundary. */
export interface SnapshotPayloadReference {
  id: string
  bytes: number
  partBytes: number
  parts: number
  encoding: 'json-lines'
}
