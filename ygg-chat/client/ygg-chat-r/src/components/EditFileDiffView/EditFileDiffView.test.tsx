import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditFileDiffView, type EditFileArgs, type EditFileResult } from './EditFileDiffView'
import { EditToolDiffView } from './EditToolDiffView'

const harness = vi.hoisted(() => ({
  expanded: false,
  mode: 'inline',
  enabled: false,
  dark: false,
}))
// Exercise the existing local disclosure/view states without a DOM-test dependency.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(
      initial === false ? harness.expanded : initial === 'inline' ? harness.mode : initial
    ),
  }
})
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return {
    ...actual,
    useCustomChatTheme: () => ({
      enabled: harness.enabled,
      theme: {
        colors: {
          toolJobsPrimaryText: { light: '#111111', dark: '#eeeeee' },
          toolJobsMutedText: { light: '#555555', dark: '#aaaaaa' },
          toolJobsCodeBg: { light: '#f0f0f0', dark: '#252525' },
          toolJobsCodeText: { light: '#333333', dark: '#cccccc' },
          toolJobsStatusCompletedText: { light: '#227744', dark: '#99ccaa' },
          toolJobsStatusFailedText: { light: '#994444', dark: '#dd9999' },
          composerToggleActiveBg: { light: '#dddddd', dark: '#333333' },
          composerToggleActiveText: { light: '#222222', dark: '#dddddd' },
          toolJobsErrorBg: { light: '#fff1f2', dark: '#441111' },
          toolJobsErrorBorder: { light: '#fecdd3', dark: '#9f1239' },
          toolJobsErrorText: { light: '#be123c', dark: '#fda4af' },
        },
      },
    }),
    useHtmlDarkMode: () => harness.dark,
  }
})

beforeEach(() => {
  harness.expanded = false
  harness.mode = 'inline'
  harness.enabled = false
  harness.dark = false
})

const appendArgs: EditFileArgs = {
  path: '/project/.gitignore', operation: 'append',
  content: '\n# Local skills and design previews\n/.claude/skills/\n/design-previews/\n',
}
const appendResult: EditFileResult = {
  success: true,
  lineInfo: { oldStartLine: 95, oldEndLine: 94, oldLineCount: 0,
    newStartLine: 95, newEndLine: 98, newLineCount: 4, scope: 'append' },
}
const replacementArgs: EditFileArgs = {
  path: '/project/file.ts', operation: 'replace',
  searchPattern: 'const keep = true\nconst value = 1\n',
  replacement: 'const keep = true\nconst value = 2\n',
}
const renderEdit = (args = appendArgs, result: EditFileResult | string = appendResult) =>
  renderToStaticMarkup(<EditFileDiffView args={args} result={result} />)

describe('inline file edit design', () => {
  it('keeps the existing collapsed default and exposes a keyboard-accessible file row', () => {
    const html = renderEdit()
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Expand edit for .gitignore')
    expect(html).toContain('title="/project/.gitignore"')
    expect(html).toContain('>append</span>')
    expect(html).toContain('>+4</span>')
    expect(html).not.toContain('Local skills and design previews')
  })

  it('renders append lines with one gutter, muted surface, and no table chrome', () => {
    harness.expanded = true
    const html = renderEdit()
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('New line 95')
    expect(html).toContain('New line 98')
    expect(html).toContain('/design-previews/')
    expect(html).toContain('whitespace-pre')
    expect(html).not.toContain('Original line')
    expect(html).not.toMatch(/>old<|>new<|>code</)
    expect(html).not.toContain('border-r')
    expect(html).not.toContain('bg-emerald-100')
    expect(html).not.toContain('Diff view')
  })

  it('preserves original/new numbering and explicit signs for replacements', () => {
    harness.expanded = true
    const html = renderEdit(replacementArgs, { success: true, replacements: 2,
      lineInfo: { oldStartLine: 10, oldEndLine: 11, oldLineCount: 2,
        newStartLine: 10, newEndLine: 11, newLineCount: 2, scope: 'first_of_many' } })
    expect(html).toContain('Original line 11')
    expect(html).toContain('New line 11')
    expect(html).toContain('New line 10')
    expect(html).toContain('>+1</span>')
    expect(html).toContain('>−1</span>')
    expect(html).toContain('>−</span>')
    expect(html).toContain('>+</span>')
    expect(html).toContain('2 replacements')
    expect(html).not.toContain('line-through')
    expect(html).toContain('aria-label="Inline diff (git-style merged)" aria-pressed="true"')
  })

  it('keeps the three view modes in the header as sibling buttons, not a separate toolbar row', () => {
    harness.expanded = true
    const html = renderEdit(replacementArgs, { success: true })
    expect(html).toContain('class="flex min-h-8 min-w-0 items-center" data-edit-header="true"')
    expect(html).toMatch(/<\/button><div class="t-resize edit-view-slot" data-open="true" aria-hidden="false"><div class="edit-view-controls flex items-center gap-0\.5" role="group" aria-label="Diff view">/)
    expect(html).toContain('aria-label="Split view (side-by-side)"')
    expect(html).toContain('aria-label="Unified view (stacked)"')
    expect(html).not.toContain('justify-end gap-1 py-1')
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/)
  })

  it('keeps closed view controls mounted for the width transition but inert and hidden', () => {
    const html = renderEdit(replacementArgs, { success: true })
    expect(html).toContain('class="t-resize edit-view-slot" data-open="false" inert="" aria-hidden="true"')
    expect(html).toContain('aria-label="Split view (side-by-side)"')
    expect(html).not.toContain('const value =')
  })

  it('limits layout motion to the control slot and disables motion when requested', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    expect(css).toContain(".edit-view-slot[data-open='true'] {\n  width: 92px;")
    expect(css).toContain('--resize-dur: var(--edit-reveal-duration)')
    expect(css).toContain('--edit-reveal-duration: 400ms')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.edit-view-slot,\s*\.edit-view-controls \{\s*transition: none !important;/)
    expect(css).toContain('.edit-batch-reveal { animation: none !important; }')
    expect(css).toContain('.edit-diff-animations-disabled .edit-view-slot')
  })

  it.each(['unified', 'split'])('preserves the %s alternative without heavy diff surfaces', mode => {
    harness.expanded = true
    harness.mode = mode
    const html = renderEdit(replacementArgs, { success: true })
    expect(html.replace(/<[^>]*>/g, '')).toContain('const value =')
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('bg-red-100')
    expect(html).not.toContain('shadow-sm')
    expect(html).not.toContain('transition-all')
    if (mode === 'split') {
      expect(html).toContain('>Original</span>')
      expect(html).toContain('>Replacement</span>')
    }
  })

  it('handles empty changes and Windows filenames', () => {
    const html = renderEdit({ path: 'C:\\project\\file.ts', searchPattern: 'same', replacement: 'same' }, {})
    expect(html).toContain('Expand edit for file.ts')
    expect(html).not.toContain('>+0<')
    expect(html).not.toContain('>−0<')
  })

  it('preserves full failure messages and non-exact match strategy', () => {
    harness.expanded = true
    const html = renderEdit(replacementArgs, JSON.stringify({
      success: false, message: 'No match found. Check the file contents.', matchStrategy: 'whitespace',
    }))
    expect(html).toContain('No match found. Check the file contents.')
    expect(html).toContain('whitespace-pre-wrap break-words')
    expect(html).toContain('whitespace</span>')
  })

  it.each([false, true])('resolves custom theme colors in dark mode = %s', dark => {
    harness.enabled = true
    harness.dark = dark
    harness.expanded = true
    const html = renderEdit()
    expect(html).toContain(`--edit-surface:${dark ? '#252525' : '#f0f0f0'}`)
    expect(html).toContain(`--edit-added:${dark ? '#99ccaa' : '#227744'}`)
    expect(html).toContain(`--edit-muted:${dark ? '#aaaaaa' : '#555555'}`)
    expect(html).toContain(`color:${dark ? '#eeeeee' : '#111111'}`)
    expect(html).toContain(`--edit-primary:${dark ? '#eeeeee' : '#111111'}`)
  })

  it('pairs custom code backgrounds with readable foregrounds in alternative views', () => {
    harness.enabled = true
    harness.expanded = true
    harness.mode = 'split'
    const html = renderEdit(replacementArgs, { success: true })
    expect(html).toContain('--edit-code-text:#333333')
    expect(html).toContain('[&amp;_code_span]:!text-[color:var(--edit-code-text)]')
    expect(html).toContain('preview: 1 added and 1 removed lines')
  })

  it('uses explicit light/dark filename and active-control colors with custom themes disabled', () => {
    harness.dark = true
    harness.expanded = true
    const html = renderEdit(replacementArgs, { success: true })
    expect(html).not.toContain('--edit-surface:')
    expect(html).toContain('text-[color:var(--edit-primary,#383936)] dark:text-[color:var(--edit-primary,#dedfd9)]')
    expect(html).toContain('text-[color:var(--edit-active-text,#383936)] dark:text-[color:var(--edit-active-text,#dedfd9)]')
  })

  it('also applies to multi_edit items without changing batch result semantics', () => {
    harness.expanded = true
    const html = renderToStaticMarkup(<EditToolDiffView toolName='multi_edit'
      args={{ edits: [appendArgs, replacementArgs] }}
      result={{ success: false, applied: 1, failed: 1, results: [appendResult, { success: false, message: 'No match' }] }} />)
    expect(html).toContain('2 edits')
    expect(html).toContain('applied 1')
    expect(html).toContain('failed 1')
    expect(html).toContain('Collapse edit for .gitignore')
    expect(html).toContain('Collapse edit for file.ts')
    expect(html).toContain('No match')
    expect(html).toContain('space-y-1 edit-batch-reveal')
    expect(html).toContain('aria-label="Edit 1"')
    expect(html).toContain('aria-label="Edit 2"')
    expect(html).not.toContain('edit 1</div>')
    expect(html).not.toContain('edit 2</div>')
    expect(html).not.toContain('class="p-1"')
  })
})
