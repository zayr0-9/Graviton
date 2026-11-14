import { describe, expect, it } from 'vitest'
import { getPastedImageFiles, readClipboardImageFiles } from './clipboardImages'

const png = new File(['png'], 'shot.png', { type: 'image/png' })
const pdf = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' })

describe('getPastedImageFiles', () => {
  it('reads image items and skips text items', () => {
    const files = getPastedImageFiles({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => png },
      ],
      files: [png],
    })
    expect(files).toEqual([png])
  })

  it('falls back to files when items carry no image', () => {
    expect(getPastedImageFiles({ items: [], files: [pdf, png] })).toEqual([png])
  })

  it('returns nothing for missing clipboard data', () => {
    expect(getPastedImageFiles(null)).toEqual([])
  })
})

describe('readClipboardImageFiles', () => {
  it('turns clipboard image entries into named files', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const files = await readClipboardImageFiles(
      {
        read: async () => [
          { types: ['text/plain'], getType: async () => new Blob(['text']) },
          { types: ['text/html', 'image/jpeg'], getType: async () => blob },
        ],
      },
      () => 42
    )
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('pasted-image-42-1.jpg')
    expect(files[0].type).toBe('image/jpeg')
  })

  it('rejects when the clipboard API is unavailable', async () => {
    await expect(readClipboardImageFiles(null)).rejects.toThrow(/secure/)
  })

  it('propagates a denied permission', async () => {
    await expect(readClipboardImageFiles({ read: async () => { throw new Error('denied') } })).rejects.toThrow('denied')
  })
})
