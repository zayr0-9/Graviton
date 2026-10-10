import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertModelImageBudget, createModelImageHydrator } from '../modelImageHistory.js'
import { toCodexMessages } from '../../providers/codex/codexRequestItems.js'

let root: string
const bytes = Buffer.from('image-fixture')
const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
let attachment: any
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'model-images-'))
  await mkdir(path.join(root, 'user_images'))
  attachment = { id: 'a', mime_type: 'image/png', file_path: path.join(root, 'user_images/a.png'),
    sha256: createHash('sha256').update(bytes).digest('hex') }
  await writeFile(attachment.file_path, bytes)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function setup() {
  const all = vi.fn((id: string) => id === 'user' ? [attachment] : [])
  return { all, hydrate: createModelImageHydrator(path.join(root, 'chat.db'), { getAttachmentsByMessageId: { all } }) }
}

describe('durable model image history', () => {
  it('rehydrates images on their owning user row, including subsequent tool turns and reloads', async () => {
    const { hydrate } = setup()
    const original = [{ id: 'user', role: 'user', content: 'look' },
      { id: 'mode', role: 'user', content: '<system-reminder>Agent mode</system-reminder>' }]
    const history = await hydrate(original)
    expect(history[0].attachments).toEqual([{ dataUrl }])
    expect(history[1]).toEqual(original[1])
    expect(original[0]).not.toHaveProperty('attachments')
    const call = (rows: any[]) => toCodexMessages({ history: rows, userContent: '', modelName: 'test' } as any)
    const first = call(history)
    const next = call([...history, { role: 'assistant', content: 'tool finished' }])
    expect(first[0].contentParts).toContainEqual({ type: 'input_image', image_url: dataUrl })
    expect(next[0].contentParts).toEqual(first[0].contentParts)
    expect(next[1].contentParts).not.toContainEqual({ type: 'input_image', image_url: dataUrl })
    expect(await setup().hydrate(original)).toEqual(history)
  })

  it('only queries selected user rows, not sibling/assistant content', async () => {
    const { hydrate, all } = setup()
    await hydrate([{ id: 'user', role: 'user', content: 'look' }, { id: 'assistant', role: 'assistant' }])
    expect(all.mock.calls).toEqual([['user']])
  })

  it('deduplicates first-request data and linked attachments', async () => {
    const { hydrate } = setup()
    const [row] = await hydrate([{ id: 'user', role: 'user' }], 'user', [{ attachmentId: 'a', dataUrl }])
    expect(row.artifacts).toEqual([dataUrl])
  })

  it('rejects missing, changed, or unmanaged files instead of dropping the image', async () => {
    const { hydrate } = setup()
    await writeFile(attachment.file_path, 'changed')
    await expect(hydrate([{ id: 'user', role: 'user' }])).rejects.toThrow('Reattach')
    attachment.file_path = path.join(root, 'missing.png')
    await expect(hydrate([{ id: 'user', role: 'user' }])).rejects.toThrow('Reattach')
    attachment.file_path = path.join(root, 'outside.png')
    await writeFile(attachment.file_path, bytes)
    await expect(hydrate([{ id: 'user', role: 'user' }])).rejects.toThrow('Reattach')
  })

  it('rejects symlink escapes and does not fetch stored URLs', async () => {
    const { hydrate } = setup()
    const outside = path.join(root, 'outside.png')
    await writeFile(outside, bytes)
    const link = path.join(root, 'user_images/escape.png')
    await symlink(outside, link)
    attachment.file_path = link
    await expect(hydrate([{ id: 'user', role: 'user' }])).rejects.toThrow('Reattach')
    attachment.file_path = null
    attachment.url = 'http://127.0.0.1/private'
    await expect(hydrate([{ id: 'user', role: 'user' }])).rejects.toThrow('Reattach')
  })

  it('counts already accepted history when admitting queued images', () => {
    const url = `data:image/png;base64,${Buffer.alloc(17 * 1024 * 1024).toString('base64')}`
    const history = [1, 2, 3].map(id => ({ id, role: 'user', artifacts: [url] }))
    expect(() => assertModelImageBudget(history)).not.toThrow()
    expect(() => assertModelImageBudget([...history, { role: 'user', artifacts: [url] }])).toThrow('64 MB')
  })

  it('enforces per-image and aggregate limits', async () => {
    const { hydrate } = setup()
    const large = `data:image/png;base64,${Buffer.alloc(21 * 1024 * 1024).toString('base64')}`
    await expect(hydrate([{ id: 'new', role: 'user' }], 'new', [{ dataUrl: large }])).rejects.toThrow('20 MB')
    const images = [0, 1, 2, 3].map(n => ({ dataUrl: `data:image/png;base64,${Buffer.alloc(17 * 1024 * 1024, n).toString('base64')}` }))
    await expect(hydrate([{ id: 'new', role: 'user' }], 'new', images)).rejects.toThrow('64 MB')
  })
})
