import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

export const editorContentHash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')
const writers = new Map<string, Promise<void>>()

/** Serialize host editor writes by canonical path. External tools/programs do not
 * participate in this lock; the compare immediately before write is best effort. */
export async function saveEditorFile(filePath: string, content: string, expectedHash: unknown): Promise<string> {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw Object.assign(new Error('Reload the file before saving; a content revision is required.'), { status: 428 })
  }
  const canonical = await fs.realpath(filePath)
  const previous = writers.get(canonical) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => turn)
  writers.set(canonical, tail)
  await previous
  try {
    const current = await fs.readFile(canonical, 'utf8')
    if (editorContentHash(current) !== expectedHash) {
      throw Object.assign(new Error('This file changed on the host. Your edits are preserved; reload or compare before saving.'), { status: 409 })
    }
    await fs.writeFile(canonical, content, 'utf8')
    return editorContentHash(content)
  } finally {
    release()
    if (writers.get(canonical) === tail) writers.delete(canonical)
  }
}
