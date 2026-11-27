const AdmZip = require('adm-zip')

const zip = entries => {
  const archive = new AdmZip()
  for (const [name, xml] of Object.entries(entries)) archive.addFile(name, Buffer.from(xml))
  return archive.toBuffer().toString('base64')
}

const rels = inner => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
const contentTypes = overrides => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`
const docx = zip({
  '[Content_Types].xml': contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
  '_rels/.rels': rels(relationship('rId1', 'officeDocument', 'word/document.xml')),
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Text from Word</w:t></w:r></w:p></w:body></w:document>',
})
const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const workbook = {
  '[Content_Types].xml': contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
  '_rels/.rels': rels(relationship('rId1', 'officeDocument', 'xl/workbook.xml')),
  'xl/workbook.xml': `<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': rels(relationship('rId1', 'worksheet', 'worksheets/sheet1.xml') + relationship('rId2', 'worksheet', 'worksheets/sheet2.xml')),
  'xl/worksheets/sheet1.xml': `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="n"><f>5+7</f><v>12</v></c></row></sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet</t></is></c></row></sheetData></worksheet>`,
}
const xlsx = zip(workbook)
const largeWorksheet = zip({
  ...workbook,
  'xl/worksheets/sheet1.xml': `<worksheet ${ns}><sheetData><row r="1048576"><c r="XFD1048576" t="n"><v>5</v></c></row></sheetData></worksheet>`,
})

function pdfFixture(text) {
  const stream = text ? `BT /F1 14 Tf 72 720 Td (${text}) Tj ET` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const end = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${end}\n%%EOF\n`
  return Buffer.from(pdf).toString('base64')
}

module.exports = { docx, xlsx, largeWorksheet, pdf: pdfFixture('Text from PDF'), emptyPdf: pdfFixture('') }
