import { describe, expect, it, vi } from 'vitest'
import {
  FILE_INSERTION_MAX_BYTES, FILE_INSERTION_MAX_CHARS, FILE_INSERTION_MAX_FILES,
  findFileProcessor, formatFileInsertion, getFileInsertionAccept, getTransferredFiles,
  insertFileText, mapOutsideFileInsertions, processInsertionFiles, type FileProcessor,
} from './fileInsertion'

const read = (files: File[], processors?: readonly FileProcessor[]) =>
  processInsertionFiles(files, { signal: new AbortController().signal, processors })
const file = (name: string, text = 'data', type = '') => new File([text], name, { type })

describe('file insertion', () => {
  it('matches specific extensions case-insensitively and falls back to MIME', () => {
    expect(findFileProcessor(file('BOOK.XLSX', '', 'application/octet-stream'))?.extensions).toEqual(['.xlsx'])
    expect(findFileProcessor(file('native-paste', '', 'application/pdf'))?.extensions).toEqual(['.pdf'])
    expect(findFileProcessor(file('README.MD', '', 'text/plain'))?.extensions).toContain('.md')
    expect(getFileInsertionAccept()).toContain('.docx')
    expect(getFileInsertionAccept()).not.toMatch(/(?:^|,)\.xls(?:,|$)/)
  })

  it('supports new binary processors without changing the engine', async () => {
    const processor: FileProcessor = {
      extensions: ['.sample'], mimeTypes: [],
      process: async input => `First byte: ${new Uint8Array(await input.arrayBuffer())[0]}`,
    }
    const result = await read([new File([new Uint8Array([42, 0xff])], 'sample.sample')], [processor])
    expect(result.text).toContain('First byte: 42')
    expect(result.errors).toEqual([])
  })

  it('prefers a populated FileList, with an items fallback and no string/path items', () => {
    const a = file('a.md')
    const b = file('b.pdf')
    const transfer = (files: File[]) => ({ files, items: [
      { kind: 'string', getAsFile: () => { throw Error('not a file') } },
      { kind: 'file', getAsFile: () => a },
      { kind: 'file', getAsFile: () => null },
    ] }) as unknown as DataTransfer
    expect(getTransferredFiles(transfer([a, b]))).toEqual([a, b])
    expect(getTransferredFiles(transfer([]))).toEqual([a])
  })

  it('preserves source text and order despite a failed sibling; safely encloses backticks', async () => {
    const result = await read([file('a.MD', '# Heading\r\n```\r\nhello\r\n```'), file('old.xls'), file('b.json', '{"id":12345678901234567890}')])
    expect(result.text).toBe('````\nFile: a.MD\n\n# Heading\n```\nhello\n```\n````\n\n```\nFile: b.json\n\n{"id":12345678901234567890}\n```')
    expect(result.errors).toEqual(['old.xls: Save as .docx or .xlsx and try again.'])
    expect(formatFileInsertion('a.txt', 'one')).toBe('```\nFile: a.txt\n\none\n```')
  })

  it('rejects empty and binary text and decodes BOM-marked UTF-16', async () => {
    const result = await read([
      file('empty.txt', ''),
      new File([new Uint8Array([0xff, 0x00])], 'bad.txt'),
      new File([new Uint8Array([0xff, 0xfe, 0x6f, 0, 0x6b, 0])], 'utf16.txt'),
    ])
    expect(result.text).toContain('\nok\n')
    expect(result.errors).toHaveLength(2)
  })

  it('reports count, input size and aggregate output limits without silently truncating', async () => {
    const tooBig = new File([new Uint8Array(FILE_INSERTION_MAX_BYTES + 1)], 'big.txt')
    const result = await read([tooBig, file('one.txt', 'a'.repeat(FILE_INSERTION_MAX_CHARS - 50)), file('two.txt', 'b'.repeat(100))])
    expect(result.text).toContain('File: one.txt')
    expect(result.text).not.toContain('File: two.txt')
    expect(result.errors.join('\n')).toMatch(/big\.txt:.*10 MB[\s\S]*two\.txt:.*Too much text/)
    expect((await read(Array.from({ length: FILE_INSERTION_MAX_FILES + 1 }, (_, i) => file(`${i}.txt`)))).errors[0]).toContain(`first ${FILE_INSERTION_MAX_FILES}`)
  })

  it('skips reading text that cannot fit the output budget', async () => {
    const large = file('large.csv', 'x'.repeat(4 * FILE_INSERTION_MAX_CHARS + 4))
    const readBytes = vi.spyOn(large, 'arrayBuffer')
    expect((await read([large])).errors[0]).toContain('Too much text')
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('stops at cancellation without converting another file', async () => {
    const controller = new AbortController()
    const process = vi.fn(async () => { controller.abort(); return 'ignored' })
    await expect(processInsertionFiles([file('a.sample'), file('b.sample')], {
      signal: controller.signal, processors: [{ extensions: ['.sample'], mimeTypes: [], process }],
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(process).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite document text when replacing workspace mentions', () => {
    const block = formatFileInsertion('@file.md', 'Sample @file.md\n```\nsource\n```')
    const draft = `See @file.md\n${block}\nThen @file.md`
    expect(mapOutsideFileInsertions(draft, text => text.replaceAll('@file.md', '/workspace/file.md')))
      .toBe(`See /workspace/file.md\n${block}\nThen /workspace/file.md`)
    expect(mapOutsideFileInsertions(`\n${block}\n`, text => text)).toBe(`\n${block}\n`)
  })

  it('replaces the selected range without breaking the surrounding lines or caret', () => {
    expect(insertFileText('Before replace after', 'document', 7, 14)).toEqual({ value: 'Before \ndocument\n after', cursor: 17 })
  })
})
