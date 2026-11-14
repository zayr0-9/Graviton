import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppMarkdown } from './AppMarkdown'
import { MarkdownLink } from '../MarkdownLink/MarkdownLink'


const SRC_ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\.(tsx?|jsx?)$/.test(name) ? [path] : []
  })
}

describe('AppMarkdown', () => {
  it('renders links through MarkdownLink with the shared sanitizer, even when a surface passes its own components', () => {
    const Pre = (props: { children?: React.ReactNode }) => <pre data-custom>{props.children}</pre>
    const html = renderToStaticMarkup(
      <AppMarkdown components={{ pre: Pre }}>
        {'[edit](vscode://file/tmp/a.ts:3) [bad](javascript:alert(1))\n\n```\ncode\n```'}
      </AppMarkdown>
    )
    expect(html).toContain('href="vscode://file/tmp/a.ts:3"')
    expect(html).toContain('href=""')
    expect(html).toContain('data-custom')
    expect(html).toContain('text-blue-600')
  })

  it('overrides a surface-supplied anchor renderer', () => {
    const RawAnchor = () => <a data-raw href='x'>raw</a>
    const html = renderToStaticMarkup(<AppMarkdown components={{ a: RawAnchor }}>{'[x](https://example.com)'}</AppMarkdown>)
    expect(html).not.toContain('data-raw')
    expect(MarkdownLink).toBeTypeOf('function')
  })

  it('is the only module that renders react-markdown directly', () => {
    const offenders = sourceFiles(SRC_ROOT)
      // A default or namespace value import is a renderer; `import type` and named helpers are fine.
      .filter(file => /^import\s+(?!type\b)(?:\w+\s*(?:,|\s+from)|\*\s+as)[^\n]*['"]react-markdown['"]/m.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC_ROOT, file))
      .filter(file => file !== join('components', 'MarkdownContent', 'AppMarkdown.tsx'))
    // Raw ReactMarkdown renders bare <a> tags, which navigate the Electron window itself.
    expect(offenders).toEqual([])
  })
})
