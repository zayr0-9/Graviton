import { transferErrorMessage } from './messageTransfer'

/**
 * Multi-step Heimdall transfers. Each step is injected so the ordering and rollback are testable
 * without Redux. Every failure throws an Error whose message is safe to show the user, and no
 * failure leaves a half-made chat or a message in both chats behind.
 */

export interface MoveSelectionSteps {
  /** Rows the source delete would remove (server dry run); rejects when the delete would be refused. */
  previewSourceDelete: () => Promise<string[]>
  /** Copy into the target; resolves to the created rows. */
  copy: () => Promise<Array<{ id: string | number }>>
  deleteSource: () => Promise<void>
  deleteCopies: (ids: string[]) => Promise<void>
}

const CLAUDE_DELETE_REFUSED = 'claude_delete_refused'

/** Check the source delete first, copy, then delete; a refused delete removes the copies again. */
export async function moveSelection(sourceIds: readonly string[], steps: MoveSelectionSteps): Promise<void> {
  let planned: string[]
  try {
    planned = await steps.previewSourceDelete()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === CLAUDE_DELETE_REFUSED) {
      throw new Error("Can't move these messages: Claude could not continue this chat after they are removed. Use Copy instead.")
    }
    throw new Error(transferErrorMessage(error, 'Could not check whether these messages can be moved.'))
  }
  const selected = new Set(sourceIds.map(String))
  if (planned.some(id => !selected.has(String(id)))) {
    throw new Error('Moving these messages would also delete launch context that is not selected. Select it too, or use Copy.')
  }

  const copies = await steps.copy()
  try {
    await steps.deleteSource()
  } catch (error) {
    const reason = transferErrorMessage(error, 'the messages could not be removed from this chat')
    try {
      await steps.deleteCopies(copies.map(row => String(row.id)))
    } catch {
      throw new Error(`The messages were copied, but could not be removed from this chat: ${reason}`)
    }
    throw new Error(`Nothing was moved: ${reason}`)
  }
}

export interface NewChatSteps<C extends { id: string | number }> {
  create: () => Promise<C>
  /** Set the workspace folder, when the source chat has one. */
  setCwd?: (conversation: C) => Promise<void>
  copy: (conversation: C) => Promise<unknown>
  remove: (conversation: C) => Promise<void>
}

/** Create, configure and fill a chat; any failure after creation deletes it again. */
export async function createChatFromSelection<C extends { id: string | number }>(steps: NewChatSteps<C>): Promise<C> {
  const conversation = await steps.create()
  if (!conversation?.id) throw new Error('Failed to create the new chat.')
  try {
    await steps.setCwd?.(conversation)
    await steps.copy(conversation)
    return conversation
  } catch (error) {
    await steps.remove(conversation).catch(removeError => console.error('Failed to remove the incomplete new chat:', removeError))
    throw new Error(transferErrorMessage(error, 'Failed to create the new chat.'))
  }
}
