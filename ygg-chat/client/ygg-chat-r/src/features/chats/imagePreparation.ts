import type { ImageDraft, ImageDraftTarget } from './chatTypes'
import { chatSliceActions } from './chatSlice'
import { localApi } from '../../utils/api'

// Preparation belongs to a draft owner, not the currently focused textarea. Register
// before FileReader starts so submit cannot race the read or local persistence.
const preparations = new Map<string, Set<Promise<void>>>()
const targetKey = (target: ImageDraftTarget) => target.kind === 'composer' ? 'composer' : `branch:${target.messageId}`
const sessionKey = (target: ImageDraftTarget, conversationId: unknown, generation: number) => JSON.stringify([conversationId, generation, targetKey(target)])

export function prepareImageFiles(files: File[], target: ImageDraftTarget) {
  return (dispatch: any, getState: any): Promise<void> => {
    const key = targetKey(target)
    const conversationId = getState().chat.conversation.currentConversationId
    dispatch(chatSliceActions.imageDraftTargetSet(target))
    dispatch(chatSliceActions.imagePreparationStarted({ target }))
    const generation = getState().chat.composition.imagePreparationGeneration
    const current = () => {
      const state = getState().chat
      return state.composition.imagePreparationGeneration === generation &&
        state.conversation.currentConversationId === conversationId &&
        state.composition.imageDraftTarget && targetKey(state.composition.imageDraftTarget) === key
    }
    const pending = (async () => {
      try {
        const drafts = await Promise.all(files.map(async file => ({
          dataUrl: await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(new Error('Could not read attached image'))
            reader.readAsDataURL(file)
          }),
          name: file.name || 'pasted-image', type: file.type, size: file.size,
        })))
        const result = await localApi.post<{ attachments: Array<{ id: string; file_path: string; sha256: string }> }>(
          '/local/attachments/prepare-base64', { attachments: drafts }
        )
        if (result.attachments?.length !== drafts.length) throw new Error('Image preparation returned an incomplete result')
        if (!current()) return
        const prepared: ImageDraft[] = drafts.map((draft, index) => ({ ...draft,
          attachmentId: result.attachments[index].id, filePath: result.attachments[index].file_path,
          sha256: result.attachments[index].sha256,
        }))
        dispatch(chatSliceActions.imageDraftsAppended({ target, drafts: prepared }))
      } catch {
        if (current()) {
          dispatch(chatSliceActions.imagePreparationFailed({ error: 'Could not prepare image. Attach it again before sending.' }))
        }
      } finally {
        if (current()) dispatch(chatSliceActions.imagePreparationFinished())
      }
    })()
    const session = sessionKey(target, conversationId, generation)
    const tasks = preparations.get(session) ?? new Set<Promise<void>>()
    tasks.add(pending)
    preparations.set(session, tasks)
    void pending.finally(() => { tasks.delete(pending); if (!tasks.size && preparations.get(session) === tasks) preparations.delete(session) })
    return pending
  }
}

export function waitForImagePreparation(target: ImageDraftTarget) {
  return async (_dispatch: any, getState: any): Promise<void> => {
    const key = targetKey(target)
    const before = getState().chat
    const conversationId = before.conversation.currentConversationId
    const generation = before.composition.imagePreparationGeneration
    const session = sessionKey(target, conversationId, generation)
    while (preparations.get(session)?.size) {
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          const state = getState().chat
          if (state.conversation.currentConversationId !== conversationId || state.composition.imagePreparationGeneration !== generation) {
            clearInterval(timer)
            reject(new Error('Image draft changed before submission'))
          }
        }, 50)
        void Promise.all([...preparations.get(session)!]).then(() => { clearInterval(timer); resolve() }, error => { clearInterval(timer); reject(error) })
      })
    }
    const after = getState().chat
    if (after.conversation.currentConversationId !== conversationId ||
        after.composition.imagePreparationGeneration !== generation) throw new Error('Image draft changed before submission')
    if (after.composition.imageDraftTarget && targetKey(after.composition.imageDraftTarget) === key &&
        after.composition.imagePreparationError) throw new Error(after.composition.imagePreparationError)
  }
}
