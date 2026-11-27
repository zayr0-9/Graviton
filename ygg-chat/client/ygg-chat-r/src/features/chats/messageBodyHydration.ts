import { createAsyncThunk } from '@reduxjs/toolkit'
import type { ConversationId } from '../../../../../shared/types'
import type { RootState } from '../../store/store'
import { localApi } from '../../utils/api'
import { chatSliceActions } from './chatSlice'
import type { Message } from './chatTypes'

/** Ids per `/messages/bodies` request; the host accepts up to 200. */
export const MESSAGE_BODY_BATCH = 60

/** Full enriched rows for the given ids, in branch order, fetched in bounded batches. */
export async function fetchMessageBodies(conversationId: string, ids: readonly string[], signal?: AbortSignal): Promise<Message[]> {
  const rows: Message[] = []
  for (let start = 0; start < ids.length; start += MESSAGE_BODY_BATCH) {
    const batch = ids.slice(start, start + MESSAGE_BODY_BATCH)
    const { messages } = await localApi.get<{ messages: Message[] }>(
      `/app/conversations/${conversationId}/messages/bodies?ids=${encodeURIComponent(batch.join(','))}`,
      signal ? { signal } : undefined
    )
    rows.push(...messages)
  }
  return rows
}

/** `conversation:message` → the request that will deliver that row. */
const inFlight = new Map<string, Promise<Message[]>>()

export function clearMessageBodyHydrationForTests(): void {
  inFlight.clear()
}

/**
 * Fetches the full bodies of rows a branch read shipped compacted (`body_omitted`) and installs
 * them. Rows already loading are awaited, not requested again; rows that are not compacted are
 * skipped. Resolves with every hydrated row, so a caller that needs full bodies synchronously
 * (a transfer, for example) can merge them with `withHydratedBodies`.
 */
export const hydrateMessageBodies = createAsyncThunk<
  Message[],
  { conversationId: ConversationId; messageIds: readonly string[] },
  { state: RootState }
>('chat/hydrateMessageBodies', async ({ conversationId, messageIds }, { dispatch, getState }) => {
  const key = String(conversationId)
  const rows = new Map(getState().chat.conversation.messages.map(message => [String(message.id), message]))
  const waits: Promise<Message[]>[] = []
  const fresh: string[] = []
  for (const id of new Set(messageIds.map(String))) {
    if (!rows.get(id)?.body_omitted) continue
    const pending = inFlight.get(`${key}:${id}`)
    if (pending) waits.push(pending)
    else fresh.push(id)
  }
  if (fresh.length > 0) {
    const request = fetchMessageBodies(key, fresh)
      .then(messages => {
        if (String(getState().chat.conversation.currentConversationId ?? '') === key) {
          dispatch(chatSliceActions.messageBodiesHydrated({ conversationId, messages }))
        }
        return messages
      })
      .finally(() => {
        for (const id of fresh) if (inFlight.get(`${key}:${id}`) === request) inFlight.delete(`${key}:${id}`)
      })
    for (const id of fresh) inFlight.set(`${key}:${id}`, request)
    waits.push(request)
  }
  return (await Promise.all(waits)).flat()
})

/** `messages` with each row replaced by its hydrated copy when one was fetched. */
export function withHydratedBodies(messages: readonly Message[], hydrated: readonly Message[]): Message[] {
  if (hydrated.length === 0) return [...messages]
  const byId = new Map(hydrated.map(message => [String(message.id), message]))
  return messages.map(message => {
    const full = byId.get(String(message.id))
    return full && message.body_omitted ? { ...message, ...full, body_omitted: undefined, body_omitted_chars: undefined } : message
  })
}
