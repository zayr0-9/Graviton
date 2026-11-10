import { describe, expect, it, vi } from 'vitest'
import { createChatFromSelection, moveSelection, type MoveSelectionSteps } from './transferSelection'

const moveSteps = (overrides: Partial<MoveSelectionSteps> = {}): MoveSelectionSteps => ({
  previewSourceDelete: vi.fn(async () => ['a', 'b']),
  copy: vi.fn(async () => [{ id: 'copy-a' }, { id: 'copy-b' }]),
  deleteSource: vi.fn(async () => {}),
  deleteCopies: vi.fn(async () => {}),
  ...overrides,
})

describe('moveSelection', () => {
  it('checks the source delete, copies, then deletes the source', async () => {
    const order: string[] = []
    const steps = moveSteps({
      previewSourceDelete: vi.fn(async () => { order.push('preview'); return ['a', 'b'] }),
      copy: vi.fn(async () => { order.push('copy'); return [{ id: 'copy-a' }] }),
      deleteSource: vi.fn(async () => { order.push('delete') }),
    })
    await moveSelection(['a', 'b'], steps)
    expect(order).toEqual(['preview', 'copy', 'delete'])
    expect(steps.deleteCopies).not.toHaveBeenCalled()
  })

  it('copies nothing when Claude would refuse the source delete', async () => {
    const steps = moveSteps({ previewSourceDelete: vi.fn(async () => { throw { message: 'Claude can only continue…', code: 'claude_delete_refused' } }) })
    await expect(moveSelection(['a'], steps)).rejects.toThrow('Use Copy instead')
    expect(steps.copy).not.toHaveBeenCalled()
  })

  it('passes other refusals through, and copies nothing', async () => {
    const steps = moveSteps({ previewSourceDelete: vi.fn(async () => { throw { message: 'Wait for this branch run to finish before deleting its messages.' } }) })
    await expect(moveSelection(['a'], steps)).rejects.toThrow('Wait for this branch run to finish')
    expect(steps.copy).not.toHaveBeenCalled()
  })

  it('refuses a move whose delete would also remove unselected rows', async () => {
    const steps = moveSteps({ previewSourceDelete: vi.fn(async () => ['a', 'launch-context']) })
    await expect(moveSelection(['a'], steps)).rejects.toThrow('launch context that is not selected')
    expect(steps.copy).not.toHaveBeenCalled()
  })

  it('removes the copies again when the source delete fails after copying', async () => {
    const steps = moveSteps({ deleteSource: vi.fn(async () => { throw 'Server said no' }) })
    await expect(moveSelection(['a', 'b'], steps)).rejects.toThrow('Nothing was moved: Server said no')
    expect(steps.deleteCopies).toHaveBeenCalledWith(['copy-a', 'copy-b'])
  })

  it('says so when the copies cannot be removed either', async () => {
    const steps = moveSteps({
      deleteSource: vi.fn(async () => { throw 'Server said no' }),
      deleteCopies: vi.fn(async () => { throw new Error('offline') }),
    })
    await expect(moveSelection(['a', 'b'], steps)).rejects.toThrow('The messages were copied, but could not be removed from this chat: Server said no')
  })

  it('leaves both chats unchanged when the copy itself fails', async () => {
    const steps = moveSteps({ copy: vi.fn(async () => { throw 'Claude messages can only be copied up to a summary.' }) })
    await expect(moveSelection(['a', 'b'], steps)).rejects.toBe('Claude messages can only be copied up to a summary.')
    expect(steps.deleteSource).not.toHaveBeenCalled()
  })
})

describe('createChatFromSelection', () => {
  const conversation = { id: 'new-chat' }

  it('creates, sets the folder and copies, deleting nothing', async () => {
    const steps = { create: vi.fn(async () => conversation), setCwd: vi.fn(async () => {}), copy: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    await expect(createChatFromSelection(steps)).resolves.toBe(conversation)
    expect(steps.setCwd).toHaveBeenCalledWith(conversation)
    expect(steps.copy).toHaveBeenCalledWith(conversation)
    expect(steps.remove).not.toHaveBeenCalled()
  })

  it('deletes the new chat and shows the server reason when the copy is refused', async () => {
    const steps = { create: vi.fn(async () => conversation), copy: vi.fn(async () => { throw 'Run /compact first.' }), remove: vi.fn(async () => {}) }
    await expect(createChatFromSelection(steps)).rejects.toThrow('Run /compact first.')
    expect(steps.remove).toHaveBeenCalledWith(conversation)
  })

  it('deletes the new chat when its workspace folder cannot be set, before copying', async () => {
    const steps = { create: vi.fn(async () => conversation), setCwd: vi.fn(async () => { throw new Error('bad folder') }),
      copy: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    await expect(createChatFromSelection(steps)).rejects.toThrow('bad folder')
    expect(steps.copy).not.toHaveBeenCalled()
    expect(steps.remove).toHaveBeenCalledWith(conversation)
  })

  it('deletes nothing when the chat was never created', async () => {
    const steps = { create: vi.fn(async () => { throw new Error('create failed') }), copy: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    await expect(createChatFromSelection(steps)).rejects.toThrow('create failed')
    expect(steps.remove).not.toHaveBeenCalled()
  })

  it('still reports the original failure when removing the new chat fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const steps = { create: vi.fn(async () => conversation), copy: vi.fn(async () => { throw 'copy refused' }),
      remove: vi.fn(async () => { throw new Error('remove failed') }) }
    await expect(createChatFromSelection(steps)).rejects.toThrow('copy refused')
    error.mockRestore()
  })
})
