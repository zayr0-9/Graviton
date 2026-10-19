import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

// Banners are inserted after esbuild's symbol renaming. Do not declare an
// imported createRequire binding here: bundled source may already import it.
export const nodeEsmBanner = "const require = (await import('node:module')).createRequire(import.meta.url);"

export function assertNodeSyntax(file) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: fs.readFileSync(file, 'utf8'),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Invalid emitted module ${file}:\n${result.stderr || result.stdout}`)
}
