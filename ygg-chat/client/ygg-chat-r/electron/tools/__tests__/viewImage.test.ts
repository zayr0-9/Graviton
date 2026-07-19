import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { viewImage } from '../viewImage.js'

const tempDirs: string[] = []

async function createPngFixture(): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-view-image-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'fixture.png')
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  await fs.writeFile(filePath, pngHeader)
  return { dir, filePath }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('viewImage', () => {
  it('returns compact persisted metadata and exactly one ephemeral image payload', async () => {
    const { dir, filePath } = await createPngFixture()
    const result = await viewImage(filePath, { cwd: dir, detail: 'high' })

    expect(result.persistedContent).toMatchObject({
      success: true,
      path: filePath,
      mimeType: 'image/png',
      detail: 'high',
      sizeBytes: 9,
    })
    expect(result.displayContent).toContain('[Image: image/png')
    expect(JSON.stringify(result.persistedContent)).not.toContain('base64')
    expect(JSON.stringify(result.persistedContent)).not.toContain('data:image')
    expect(result.modelContent).toHaveLength(1)
    expect(result.modelContent[0].image_url).toMatch(/^data:image\/png;base64,/)

    const serialized = JSON.stringify(result)
    expect(serialized.match(/data:image\/png;base64,/g)).toHaveLength(1)
    expect((result as any).image_url).toBeUndefined()
    expect((result as any).content).toBeUndefined()
  })

  it('rejects files outside the workspace', async () => {
    const { filePath } = await createPngFixture()
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-view-image-workspace-'))
    tempDirs.push(otherDir)

    await expect(viewImage(filePath, { cwd: otherDir })).rejects.toThrow('outside the workspace')
  })
})
