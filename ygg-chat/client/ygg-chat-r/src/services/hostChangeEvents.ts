export const HOST_DATA_CHANGED = 'graviton:host-data-changed'
export interface HostDataChange {
  conversationIds: string[]
  reset: boolean
  changes?: Array<{ domain: string; entity_id: string; conversation_id: string | null; revision: number | null; deleted: number }>
}
