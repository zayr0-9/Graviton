import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { editorContentHash, saveEditorFile } from '../editorFileStore.js'

it('serializes concurrent saves, including aliases, and keeps the losing edits out of the file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'graviton-save-'))
  try {
    const file = path.join(root, 'file'); const alias = path.join(root, 'alias')
    await writeFile(file, 'original'); await symlink(file, alias)
    const hash = editorContentHash('original')
    const results = await Promise.allSettled([saveEditorFile(file, 'first', hash), saveEditorFile(alias, 'second', hash)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(['first', 'second']).toContain(await readFile(file, 'utf8'))
    await expect(saveEditorFile(file, 'overwrite', hash)).rejects.toMatchObject({ status: 409 })
    await expect(saveEditorFile(file, 'overwrite', undefined)).rejects.toMatchObject({ status: 428 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
