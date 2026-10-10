import { afterEach, describe, expect, it, vi } from 'vitest'
import chatReducer, { chatSliceActions } from './chatSlice'
import { prepareImageFiles, waitForImagePreparation } from './imagePreparation'
import { localApi } from '../../utils/api'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
  } })
})
vi.mock('../../utils/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/api')>(), localApi: { post: vi.fn() },
}))

const dataUrl = 'data:image/png;base64,aW1hZ2U='
const file = { name: 'a.png', type: 'image/png', size: 5 } as File
function setup() {
  let state = { chat: chatReducer(undefined, { type: '@@init' }) }
  state.chat = { ...state.chat, conversation: { ...state.chat.conversation, currentConversationId: 'c1' } }
  const getState = () => state
  const dispatch: any = (action: any) => typeof action === 'function' ? action(dispatch, getState) :
    (state = { chat: chatReducer(state.chat, action) }, action)
  const readers: any[] = []
  vi.stubGlobal('FileReader', class {
    result = dataUrl
    onload?: () => void
    readAsDataURL() { readers.push(this) }
  })
  return { dispatch, getState, readers }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('image preparation lifecycle', () => {
  it.each([{ kind: 'composer' } as const, { kind: 'branch', messageId: 'u1' } as const])('waits for read AND storage before submitting %j', async target => {
    const { dispatch, getState, readers } = setup()
    let save!: (value: any) => void
    vi.mocked(localApi.post).mockImplementation(() => new Promise(resolve => { save = resolve }))
    const preparation = dispatch(prepareImageFiles([file], target))
    let ready = false
    const wait = dispatch(waitForImagePreparation(target)).then(() => { ready = true })
    expect(getState().chat.composition.imagePreparationPending).toBe(1)
    expect(ready).toBe(false)
    readers[0].onload()
    await vi.waitFor(() => expect(save).toBeTypeOf('function'))
    expect(ready).toBe(false)
    save({ attachments: [{ id: 'a', file_path: '/managed/a.png', sha256: 'hash' }] })
    await preparation
    await wait
    expect(getState().chat.composition.imageDrafts).toEqual([{ dataUrl, name: 'a.png', type: 'image/png', size: 5,
      attachmentId: 'a', filePath: '/managed/a.png', sha256: 'hash' }])
    expect(getState().chat.composition.imagePreparationPending).toBe(0)
  })

  it('keeps errors visible and rejects submit instead of silently sending text', async () => {
    const { dispatch, getState, readers } = setup()
    vi.mocked(localApi.post).mockRejectedValue(new Error('disk unavailable'))
    const preparation = dispatch(prepareImageFiles([file], { kind: 'composer' }))
    readers[0].onload()
    await preparation
    expect(getState().chat.composition.imagePreparationError).toContain('Attach it again')
    await expect(dispatch(waitForImagePreparation({ kind: 'composer' }))).rejects.toThrow('Attach it again')
  })

  it('does not resurrect a cancelled branch draft when its read completes', async () => {
    const { dispatch, getState, readers } = setup()
    vi.mocked(localApi.post).mockResolvedValue({ attachments: [{ id: 'a', file_path: '/managed/a.png', sha256: 'hash' }] })
    const target = { kind: 'branch', messageId: 'u1' } as const
    const preparation = dispatch(prepareImageFiles([file], target))
    const waiting = dispatch(waitForImagePreparation(target))
    const rejected = expect(waiting).rejects.toThrow('draft changed')
    dispatch(chatSliceActions.imageDraftsCleared({ target }))
    readers[0].onload()
    await preparation
    await rejected
    expect(getState().chat.composition.imageDrafts).toEqual([])
    expect(getState().chat.composition.imageDraftTarget).toBeNull()
  })

  it('new conversations do not wait for cancelled reads and cannot resurrect their images', async () => {
    const { dispatch, getState, readers } = setup()
    vi.mocked(localApi.post).mockResolvedValue({ attachments: [{ id: 'a', file_path: '/managed/a.png', sha256: 'hash' }] })
    const pending = dispatch(prepareImageFiles([file], { kind: 'composer' }))
    const waiting = dispatch(waitForImagePreparation({ kind: 'composer' }))
    const rejected = expect(waiting).rejects.toThrow('draft changed')
    dispatch(chatSliceActions.conversationSet('c2'))
    await dispatch(waitForImagePreparation({ kind: 'composer' }))
    await rejected // old FileReader is still unresolved
    expect(getState().chat.composition.imagePreparationPending).toBe(0)
    readers[0].onload()
    await pending
    expect(getState().chat.composition.imageDrafts).toEqual([])
  })

  it('allows text submission after explicitly discarding a failed image', async () => {
    const { dispatch, readers } = setup()
    vi.mocked(localApi.post).mockRejectedValue(new Error('disk'))
    const pending = dispatch(prepareImageFiles([file], { kind: 'composer' }))
    readers[0].onload()
    await pending
    dispatch(chatSliceActions.imageDraftsCleared({ target: { kind: 'composer' } }))
    await expect(dispatch(waitForImagePreparation({ kind: 'composer' }))).resolves.toBeUndefined()
  })

  it('fences an earlier target when another editor starts preparing images', async () => {
    const { dispatch, getState, readers } = setup()
    vi.mocked(localApi.post).mockResolvedValue({ attachments: [{ id: 'a', file_path: '/managed/a.png', sha256: 'hash' }] })
    const older = dispatch(prepareImageFiles([file], { kind: 'branch', messageId: 'old' }))
    const newer = dispatch(prepareImageFiles([file], { kind: 'branch', messageId: 'new' }))
    readers[0].onload()
    await older
    expect(getState().chat.composition.imageDrafts).toEqual([])
    readers[1].onload()
    await newer
    expect(getState().chat.composition.imageDraftTarget).toEqual({ kind: 'branch', messageId: 'new' })
    expect(getState().chat.composition.imageDrafts).toHaveLength(1)
  })
})
