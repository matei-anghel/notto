const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const JSZip = require('jszip')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notto-attachments-'))

function createPdfStream(text, compressed = false) {
  const content = text
    ? `BT\n/F1 18 Tf\n50 100 Td\n(${text.replace(/[()\\]/g, '\\$&')}) Tj\nET`
    : ''
  const stream = compressed ? require('node:zlib').deflateSync(Buffer.from(content)) : Buffer.from(content)
  const objects = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj'),
    Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), stream, Buffer.from('\nendstream\nendobj')]),
    Buffer.from('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj')
  ]
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let length = parts[0].length
  for (const object of objects) {
    offsets.push(length)
    parts.push(object, Buffer.from('\n'))
    length += object.length + 1
  }
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) trailer += `${String(offset).padStart(10, '0')} 00000 n \n`
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`
  return Buffer.concat([...parts, Buffer.from(trailer)])
}

async function createDocx(filePath, text) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
      </w:body>
    </w:document>`)
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

async function createPptx(filePath, slideText) {
  const zip = new JSZip()
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s2son8AAAAASUVORK5CYII=', 'base64')

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
      <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    </Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
    </Relationships>`)
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
    </p:presentation>`)
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
      <p:cSld>
        <p:spTree>
          <p:sp>
            <p:txBody>
              <a:p><a:r><a:t>${slideText}</a:t></a:r></a:p>
            </p:txBody>
          </p:sp>
        </p:spTree>
      </p:cSld>
    </p:sld>`)
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
    </Relationships>`)
  zip.file('ppt/media/image1.png', pngBuffer)

  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function toExcelColumnName(index) {
  let result = ''
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    current = Math.floor((current - 1) / 26)
  }
  return result
}

async function createXlsx(filePath, rows, sheetName = 'Sheet1') {
  const zip = new JSZip()
  const sharedStrings = []
  const sharedStringIndex = new Map()

  function getSharedStringId(value) {
    const key = String(value)
    if (!sharedStringIndex.has(key)) {
      sharedStringIndex.set(key, sharedStrings.length)
      sharedStrings.push(key)
    }
    return sharedStringIndex.get(key)
  }

  const sheetXmlRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const ref = `${toExcelColumnName(columnIndex)}${rowIndex + 1}`
      if (typeof value === 'number') {
        return `<c r="${ref}"><v>${value}</v></c>`
      }
      const stringId = getSharedStringId(value ?? '')
      return `<c r="${ref}" t="s"><v>${stringId}</v></c>`
    }).join('')

    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).join('')

  const sheetRef = rows.length > 0 && rows[0].length > 0
    ? `A1:${toExcelColumnName(rows[0].length - 1)}${rows.length}`
    : 'A1:A1'

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>
        <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
      </sheets>
    </workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
    </Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="${sheetRef}"/>
      <sheetData>${sheetXmlRows}</sheetData>
    </worksheet>`)
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
      ${sharedStrings.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('')}
    </sst>`)

  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

const originalLoad = Module._load
Module._load = function mockElectron(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          assert.equal(name, 'userData')
          return tempRoot
        }
      },
      dialog: {
        async showOpenDialog() {
          return { canceled: true, filePaths: [] }
        }
      }
    }
  }

  return originalLoad.call(this, request, parent, isMain)
}

const { prepareChatAttachments } = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'chatAttachmentManager.ts'))
Module._load = originalLoad

test('prepareChatAttachments extracts plain text files', async () => {
  const filePath = path.join(tempRoot, 'plain.txt')
  fs.writeFileSync(filePath, 'Quarter goals\nShip desktop attachments')

  const result = await prepareChatAttachments([filePath])
  assert.equal(result.ok, true)
  assert.equal(result.attachments.length, 1)
  assert.match(result.attachments[0].promptText, /Ship desktop attachments/)
  assert.equal(result.attachments[0].kind, 'document')
})

test('prepareChatAttachments extracts DOCX content', async () => {
  const filePath = path.join(tempRoot, 'notes.docx')
  await createDocx(filePath, 'DOCX roadmap body')

  const result = await prepareChatAttachments([filePath])
  assert.equal(result.ok, true)
  assert.equal(result.attachments[0].kind, 'document')
  assert.match(result.attachments[0].promptText, /DOCX roadmap body/)
})

test('prepareChatAttachments extracts spreadsheet rows', async () => {
  const filePath = path.join(tempRoot, 'plan.xlsx')
  await createXlsx(filePath, [
    ['Task', 'Owner'],
    ['Ship attachments', 'Product'],
    ['Verify persistence', 'QA']
  ], 'Plan')

  const result = await prepareChatAttachments([filePath])
  assert.equal(result.ok, true)
  assert.equal(result.attachments[0].kind, 'spreadsheet')
  assert.match(result.attachments[0].promptText, /Sheet: Plan/)
  assert.match(result.attachments[0].promptText, /Ship attachments/)
})

test('prepareChatAttachments blocks legacy xls spreadsheets', async () => {
  const filePath = path.join(tempRoot, 'legacy.xls')
  fs.writeFileSync(filePath, 'legacy spreadsheet')

  const result = await prepareChatAttachments([filePath])
  assert.equal(result.ok, true)
  assert.equal(result.attachments[0].blocked, true)
  assert.match(result.attachments[0].warnings[0], /no longer supported/i)
})

test('prepareChatAttachments extracts PPTX text and embedded images', async () => {
  const filePath = path.join(tempRoot, 'deck.pptx')
  await createPptx(filePath, 'Slide level update')

  const result = await prepareChatAttachments([filePath])
  assert.equal(result.ok, true)
  assert.equal(result.attachments[0].kind, 'presentation')
  assert.match(result.attachments[0].promptText, /Slide 1: Slide level update/)
  assert.equal(result.attachments[0].imageDataUrls.length, 1)
  assert.match(result.attachments[0].imageDataUrls[0], /^data:image\/png;base64,/)
})

test('prepareChatAttachments allows more than ten image uploads in one send', async () => {
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s2son8AAAAASUVORK5CYII=', 'base64')
  const imagePaths = Array.from({ length: 12 }, (_, index) => path.join(tempRoot, `image-${index}.png`))
  imagePaths.forEach((imagePath) => fs.writeFileSync(imagePath, pngBuffer))

  const result = await prepareChatAttachments(imagePaths)
  assert.equal(result.ok, true)
  assert.equal(result.attachments.length, 12)
  assert.equal(result.attachments.every((attachment) => attachment.kind === 'image' && !attachment.blocked), true)
})

test('prepareChatAttachments extracts PDF text and flags low-text pages', async () => {
  const textPdfPath = path.join(tempRoot, 'text.pdf')
  const blankPdfPath = path.join(tempRoot, 'blank.pdf')
  fs.writeFileSync(textPdfPath, createPdfStream('PDF roadmap update'))
  fs.writeFileSync(blankPdfPath, createPdfStream(''))

  const textResult = await prepareChatAttachments([textPdfPath])
  assert.equal(textResult.ok, true)
  assert.equal(textResult.attachments[0].kind, 'pdf')
  assert.match(textResult.attachments[0].promptText, /PDF roadmap update/)

  const blankResult = await prepareChatAttachments([blankPdfPath])
  assert.equal(blankResult.ok, true)
  assert.ok(blankResult.attachments[0].warnings.some((warning) => warning.includes('low-text PDF')))
})


test('compressed PDFs use the real parser rather than the literal-text fallback', async () => {
  const filePath = path.join(tempRoot, 'compressed.pdf')
  fs.writeFileSync(filePath, createPdfStream('Compressed roadmap update', true))
  const result = await prepareChatAttachments([filePath])
  assert.equal(result.ok, true)
  assert.match(result.attachments[0].promptText, /Compressed roadmap update/)
  assert.equal(result.attachments[0].warnings.some(warning => /fallback/i.test(warning)), false, JSON.stringify(result.attachments[0].warnings))
})
