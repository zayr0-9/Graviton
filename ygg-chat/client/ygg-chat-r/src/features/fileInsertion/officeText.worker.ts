import { Inflate, unzipSync } from 'fflate'
import mammoth from 'mammoth'
import readWorkbook from 'read-excel-file/web-worker'
import { Parser } from 'saxen'
import type { OfficeRequest, OfficeResponse } from './officeText'
import { FileInsertionError } from './fileInsertionError'

// These limits apply to declared and actual decompressed bytes, before Office parsers run.
function checkOfficeArchive(data: ArrayBuffer) {
  const zip = new DataView(data)
  const invalid = () => new FileInsertionError('Invalid or unsupported Office archive.')
  let end = zip.byteLength - 22
  for (; end >= Math.max(0, zip.byteLength - 65_557); end--) {
    if (zip.getUint32(end, true) === 0x06054b50 && end + 22 + zip.getUint16(end + 20, true) === zip.byteLength) break
  }
  if (end < Math.max(0, zip.byteLength - 65_557)) throw invalid()
  const count = zip.getUint16(end + 10, true)
  const start = zip.getUint32(end + 16, true)
  const size = zip.getUint32(end + 12, true)
  if (zip.getUint32(end + 4, true) !== 0 || zip.getUint16(end + 8, true) !== count || start + size !== end) throw invalid()
  const tooLarge = () => new FileInsertionError('Office archive is too large to unpack. Try a smaller file.')
  if (count > 2_000) throw tooLarge()
  let offset = start
  let unpacked = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.getUint32(offset, true) !== 0x02014b50) throw invalid()
    const compressed = zip.getUint32(offset + 20, true)
    const bytes = zip.getUint32(offset + 24, true)
    const method = zip.getUint16(offset + 10, true)
    const local = zip.getUint32(offset + 42, true)
    unpacked += bytes
    if (bytes > 16 * 1024 * 1024 || unpacked > 32 * 1024 * 1024) throw tooLarge()
    if (local + 30 > start || zip.getUint32(local, true) !== 0x04034b50 || (zip.getUint16(offset + 8, true) & 1) !== 0) throw invalid()
    const payload = local + 30 + zip.getUint16(local + 26, true) + zip.getUint16(local + 28, true)
    if (payload + compressed > start) throw invalid()
    if (method === 0) {
      if (compressed !== bytes) throw invalid()
    } else if (method === 8) {
      // Count actual output in small chunks. A lying directory must not bypass the budget.
      let decoded = 0
      const inflate = new Inflate(chunk => {
        decoded += chunk.length
        if (decoded > bytes) throw invalid()
      })
      const input = new Uint8Array(data, payload, compressed)
      for (let i = 0; i < compressed; i += 4096) {
        inflate.push(input.subarray(i, i + 4096), i + 4096 >= compressed)
      }
      if (decoded !== bytes) throw invalid()
    } else {
      throw invalid()
    }
    offset += 46 + zip.getUint16(offset + 28, true) + zip.getUint16(offset + 30, true) + zip.getUint16(offset + 32, true)
  }
  if (offset !== end) throw invalid()
}

// The XLSX parser materializes gaps between cells and rows. Bound that shape before parsing it.
function checkWorksheetShape(data: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(data), { filter: file => /\.xml$/i.test(file.name) })
  const decoder = new TextDecoder()
  const tooLarge = () => new FileInsertionError('Worksheet is too large to insert. Try exporting a smaller range as CSV.')
  let totalCells = 0
  for (const bytes of Object.values(files)) {
    let isWorksheet = false
    let rows = 0
    let columns = 0
    const parser = new Parser()
    parser.on('openTag', (tag, attr, decode) => {
      const local = tag.split(':').pop()
      if (local === 'worksheet') isWorksheet = true
      if (!isWorksheet) return
      if (local === 'row') {
        const row = attr().r
        const index = row ? Number(decode(row)) : rows + 1
        if (!Number.isSafeInteger(index) || index < 1 || index > 20_000) throw tooLarge()
        rows = Math.max(rows, index)
      } else if (local === 'c') {
        const ref = attr().r
        if (!ref) throw new FileInsertionError('This worksheet is missing cell addresses. Save it again in Excel or export as CSV.')
        const match = /^([A-Z]{1,3})([1-9]\d{0,4})$/.exec(decode(ref))
        if (!match) throw tooLarge()
        const column = [...match[1]].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0)
        const row = Number(match[2])
        if (column > 512 || row > 20_000) throw tooLarge()
        columns = Math.max(columns, column)
        rows = Math.max(rows, row)
      }
      if (Math.max(1, columns) * rows + totalCells > 200_000) throw tooLarge()
    })
    parser.on('error', () => { throw new FileInsertionError('Invalid worksheet XML.') })
    parser.parse(decoder.decode(bytes))
    totalCells += Math.max(1, columns) * rows
  }
}

const tsvCell = (cell: string | number | boolean | Date | null): string => {
  if (cell == null) return ''
  const text = cell instanceof Date ? cell.toISOString() : String(cell)
  return /[\t\r\n"]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function extract({ kind, data, maxChars }: OfficeRequest): Promise<string> {
  checkOfficeArchive(data)
  const tooMuchText = () => new FileInsertionError('Too much text to insert. Try a smaller excerpt.')
  if (kind === 'docx') {
    // Raw text only; Mammoth's default disallows external file access.
    const { value } = await mammoth.extractRawText({ arrayBuffer: data })
    if (value.length > maxChars) throw tooMuchText()
    return value.trim()
  }

  checkWorksheetShape(data)
  const sheets = await readWorkbook(data, { trim: false, parseNumber: value => value })
  const lines: string[] = []
  let remaining = maxChars
  const add = (line: string) => {
    remaining -= line.length + 1
    if (remaining < 0) throw tooMuchText()
    lines.push(line)
  }
  for (const { sheet, data: rows } of sheets) {
    if (!rows.length) continue
    if (lines.length) add('')
    add(`Sheet: ${sheet.replace(/[\r\n]/g, ' ')}`)
    for (const row of rows) {
      let end = row.length
      while (end > 0 && row[end - 1] == null) end--
      add(row.slice(0, end).map(tsvCell).join('\t'))
    }
  }
  return lines.join('\n')
}

self.onmessage = async (event: MessageEvent<OfficeRequest>) => {
  try {
    self.postMessage({ text: await extract(event.data) } satisfies OfficeResponse)
  } catch (error) {
    self.postMessage({ error: error instanceof FileInsertionError ? error.message : 'Could not read this Office file.' } satisfies OfficeResponse)
  }
}
