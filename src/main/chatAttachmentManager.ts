import { app, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import readExcelFile from 'read-excel-file/node'
import { XMLParser } from 'fast-xml-parser'
import { CHAT_ATTACHMENT_LIMITS, summarizeAttachmentText, trimAttachmentText, type ChatAttachment, type ChatAttachmentKind } from '../shared/chatAttachments'

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx'])

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

type ExtractionResult = {
  promptText: string
  historySummary: string
  warnings: string[]
  imageDataUrls: string[]
  mimeType: string
  kind: ChatAttachmentKind
}

function sanitizeName(name: string): string {
  return (name || 'attachment').replace(/[^\w.\- ]+/g, '_').trim() || 'attachment'
}

function getAttachmentBaseDir(): string {
  return path.join(app.getPath('userData'), 'attachments')
}

async function ensureAttachmentDir(): Promise<string> {
  const dir = getAttachmentBaseDir()
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

function extensionOf(filePath: string): string {
  return path.extname(filePath || '').toLowerCase()
}

function guessMimeType(filePath: string): string {
  return MIME_BY_EXTENSION[extensionOf(filePath)] || 'application/octet-stream'
}

function guessKind(filePath: string): ChatAttachmentKind {
  const ext = extensionOf(filePath)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet'
  if (ext === '.pptx') return 'presentation'
  return 'document'
}

function buildBlockedAttachment(filePath: string, size: number, warning: string): ChatAttachment {
  return {
    id: `attachment_${randomUUID()}`,
    name: path.basename(filePath || 'attachment'),
    mimeType: guessMimeType(filePath),
    size,
    kind: guessKind(filePath),
    storagePath: '',
    promptText: '',
    historySummary: '',
    imageDataUrls: [],
    warnings: [warning],
    blocked: true
  }
}

async function copyToStaging(sourcePath: string): Promise<string> {
  const dir = await ensureAttachmentDir()
  const targetPath = path.join(dir, `${Date.now()}_${randomUUID()}_${sanitizeName(path.basename(sourcePath))}`)
  await fsp.copyFile(sourcePath, targetPath)
  return targetPath
}

async function extractImageAttachment(storagePath: string): Promise<ExtractionResult> {
  const buffer = await fsp.readFile(storagePath)
  const mimeType = guessMimeType(storagePath)
  return {
    promptText: '',
    historySummary: 'Image attachment',
    warnings: [],
    imageDataUrls: [`data:${mimeType};base64,${buffer.toString('base64')}`],
    mimeType,
    kind: 'image'
  }
}

async function extractTextAttachment(storagePath: string): Promise<ExtractionResult> {
  const rawText = await fsp.readFile(storagePath, 'utf8')
  const promptText = trimAttachmentText(rawText, CHAT_ATTACHMENT_LIMITS.maxTextFileChars)
  const warnings = promptText.length < rawText.trim().length ? ['Text truncated to fit prompt budget.'] : []
  return {
    promptText,
    historySummary: summarizeAttachmentText(promptText || 'Text attachment'),
    warnings,
    imageDataUrls: [],
    mimeType: guessMimeType(storagePath),
    kind: 'document'
  }
}

async function extractDocxAttachment(storagePath: string): Promise<ExtractionResult> {
  const result = await mammoth.extractRawText({ path: storagePath })
  const promptText = trimAttachmentText(result.value || '', CHAT_ATTACHMENT_LIMITS.maxTextFileChars)
  const warnings = (result.messages || []).map((message) => message.message)
  if (promptText.length < (result.value || '').trim().length) {
    warnings.push('DOCX text truncated to fit prompt budget.')
  }
  return {
    promptText,
    historySummary: summarizeAttachmentText(promptText || 'DOCX attachment'),
    warnings,
    imageDataUrls: [],
    mimeType: guessMimeType(storagePath),
    kind: 'document'
  }
}

function normalizeSpreadsheetCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return ''
}

async function extractSpreadsheetAttachment(storagePath: string): Promise<ExtractionResult> {
  const workbook = await readExcelFile(storagePath)
  const warnings: string[] = []
  const sections: string[] = []
  const sheets = workbook.slice(0, CHAT_ATTACHMENT_LIMITS.maxSpreadsheetSheets)

  if (workbook.length > sheets.length) {
    warnings.push(`Only the first ${CHAT_ATTACHMENT_LIMITS.maxSpreadsheetSheets} sheets were included.`)
  }

  for (const { sheet: sheetName, data } of sheets) {
    const rows = (Array.isArray(data) ? data : [])
      .map((row) => Array.isArray(row) ? row.map(normalizeSpreadsheetCell) : [])
      .filter((row) => row.some((cell) => cell))

    if (rows.length === 0) continue

    const limitedRows = rows.slice(0, CHAT_ATTACHMENT_LIMITS.maxSpreadsheetRowsPerSheet)
    if (rows.length > limitedRows.length) {
      warnings.push(`Sheet "${sheetName}" was limited to ${CHAT_ATTACHMENT_LIMITS.maxSpreadsheetRowsPerSheet} rows.`)
    }

    const formattedRows = limitedRows.map((row, index) => `${index === 0 ? 'Header' : `Row ${index}`}: ${row.join(' | ')}`)
    sections.push(`Sheet: ${sheetName}\n${formattedRows.join('\n')}`)
  }

  const promptText = trimAttachmentText(sections.join('\n\n'), CHAT_ATTACHMENT_LIMITS.maxTextFileChars)
  if (promptText.length < sections.join('\n\n').trim().length) {
    warnings.push('Spreadsheet text truncated to fit prompt budget.')
  }

  return {
    promptText,
    historySummary: summarizeAttachmentText(promptText || 'Spreadsheet attachment'),
    warnings,
    imageDataUrls: [],
    mimeType: guessMimeType(storagePath),
    kind: 'spreadsheet'
  }
}

async function loadPdfJs() {
  return await import('pdfjs-dist/legacy/build/pdf.mjs')
}

function getPdfStandardFontUrl(): string | undefined {
  try {
    const packagePath = require.resolve('pdfjs-dist/package.json')
    const directory = path.dirname(packagePath)
    return path.join(directory, 'standard_fonts') + '/'
  } catch {
    return undefined
  }
}

async function extractPdfAttachment(storagePath: string): Promise<ExtractionResult> {
  const rawBuffer = await fsp.readFile(storagePath)
  const warnings: string[] = []
  const sections: string[] = []
  let loadingTask: any

  try {
    const pdfjs = await loadPdfJs()
    const data = new Uint8Array(rawBuffer)
    const standardFontDataUrl = getPdfStandardFontUrl()
    loadingTask = pdfjs.getDocument({
      data,
      ...(standardFontDataUrl ? { standardFontDataUrl } : {})
    })
    const document = await loadingTask.promise
    const pageCount = Math.min(document.numPages, CHAT_ATTACHMENT_LIMITS.maxPdfPages)

    if (document.numPages > pageCount) {
      warnings.push(`Only the first ${CHAT_ATTACHMENT_LIMITS.maxPdfPages} pages were included.`)
    }

    let lowTextPages = 0

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const pageText = (textContent.items || [])
        .map((item: any) => typeof item?.str === 'string' ? item.str : '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (pageText.length < 5) {
        lowTextPages += 1
        continue
      }

      sections.push(`Page ${pageNumber}: ${pageText}`)
    }

    if (lowTextPages > 0) {
      warnings.push(`Detected ${lowTextPages} low-text PDF page(s). Image fallback is not available in this build, so those pages may be underrepresented.`)
    }
  } catch (error: any) {
    warnings.push(`PDF parser fallback used: ${error?.message || 'Unable to initialize pdfjs.'}`)
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => {})
  }

  if (sections.length === 0) {
    const fallbackText = rawBuffer
      .toString('latin1')
      .match(/\((?:\\.|[^\\)])*\)\s*Tj/g)?.map((token) => token.replace(/\)\s*Tj$/, '').replace(/^\(/, '')) || []
    const decodedFallback = fallbackText
      .map((token) => token.replace(/\\([()\\])/g, '$1').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (decodedFallback) {
      sections.push(`Recovered text: ${decodedFallback}`)
      warnings.push('Recovered PDF text using a limited fallback parser.')
    } else {
      warnings.push('Detected low-text PDF content. Image fallback is not available in this build, so some pages may be underrepresented.')
    }
  }

  const promptText = trimAttachmentText(sections.join('\n\n'), CHAT_ATTACHMENT_LIMITS.maxTextFileChars)
  if (promptText.length < sections.join('\n\n').trim().length) {
    warnings.push('PDF text truncated to fit prompt budget.')
  }

  return {
    promptText,
    historySummary: summarizeAttachmentText(promptText || 'PDF attachment'),
    warnings,
    imageDataUrls: [],
    mimeType: guessMimeType(storagePath),
    kind: 'pdf'
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function collectSlideText(value: any, output: string[]): void {
  if (!value) return
  if (Array.isArray(value)) {
    value.forEach((item) => collectSlideText(item, output))
    return
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      if (key === 'a:t') {
        collectSlideText(child, output)
      } else if (!key.startsWith('@_')) {
        collectSlideText(child, output)
      }
    })
    return
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text) output.push(text)
  }
}

function bufferToDataUrl(buffer: Buffer, fileName: string): string {
  return `data:${guessMimeType(fileName)};base64,${buffer.toString('base64')}`
}

async function extractPptxAttachment(storagePath: string): Promise<ExtractionResult> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const zip = await JSZip.loadAsync(await fsp.readFile(storagePath))
  const warnings: string[] = []
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, CHAT_ATTACHMENT_LIMITS.maxPptSlides)

  if (Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length > slideFiles.length) {
    warnings.push(`Only the first ${CHAT_ATTACHMENT_LIMITS.maxPptSlides} slides were included.`)
  }

  const slideSections: string[] = []
  const imageDataUrls: string[] = []

  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)?.async('text')
    if (!xml) continue

    const parsed = parser.parse(xml)
    const textParts: string[] = []
    collectSlideText(parsed, textParts)
    const slideText = textParts.join(' ').replace(/\s+/g, ' ').trim()
    const slideNumber = Number(slideFile.match(/slide(\d+)\.xml/i)?.[1] || '0')

    if (slideText) {
      slideSections.push(`Slide ${slideNumber}: ${slideText}`)
    }

    const relsFile = slideFile.replace('slides/', 'slides/_rels/') + '.rels'
    const relsXml = await zip.file(relsFile)?.async('text')
    if (!relsXml) continue

    const relsParsed = parser.parse(relsXml)
    const relationships = asArray(relsParsed?.Relationships?.Relationship)
    for (const relationship of relationships) {
      const target = relationship?.['@_Target']
      const type = relationship?.['@_Type']
      if (!target || typeof target !== 'string') continue
      if (typeof type === 'string' && !type.includes('/image')) continue

      const normalizedTarget = target.replace(/^\.\.\//, '')
      const mediaPath = normalizedTarget.startsWith('ppt/')
        ? normalizedTarget
        : path.posix.join(path.posix.dirname(slideFile), normalizedTarget)
          .replace(/^ppt\/slides\//, 'ppt/')
      const mediaFile = zip.file(mediaPath)
      if (!mediaFile) continue
      const buffer = await mediaFile.async('nodebuffer')
      const maxVisualAssets = CHAT_ATTACHMENT_LIMITS.maxVisualAssetsPerRequest
      if (maxVisualAssets === null || imageDataUrls.length < maxVisualAssets) {
        imageDataUrls.push(bufferToDataUrl(buffer, mediaPath))
      }
    }
  }

  const promptText = trimAttachmentText(slideSections.join('\n\n'), CHAT_ATTACHMENT_LIMITS.maxTextFileChars)
  if (promptText.length < slideSections.join('\n\n').trim().length) {
    warnings.push('Presentation text truncated to fit prompt budget.')
  }
  const maxVisualAssets = CHAT_ATTACHMENT_LIMITS.maxVisualAssetsPerRequest
  if (maxVisualAssets !== null && imageDataUrls.length >= maxVisualAssets) {
    warnings.push(`Only the first ${maxVisualAssets} embedded slide images were included.`)
  }

  return {
    promptText,
    historySummary: summarizeAttachmentText(promptText || 'Presentation attachment'),
    warnings,
    imageDataUrls,
    mimeType: guessMimeType(storagePath),
    kind: 'presentation'
  }
}

async function extractAttachmentData(storagePath: string): Promise<ExtractionResult> {
  const ext = extensionOf(storagePath)
  if (IMAGE_EXTENSIONS.has(ext)) return await extractImageAttachment(storagePath)
  if (ext === '.txt' || ext === '.md') return await extractTextAttachment(storagePath)
  if (ext === '.docx') return await extractDocxAttachment(storagePath)
  if (SPREADSHEET_EXTENSIONS.has(ext)) return await extractSpreadsheetAttachment(storagePath)
  if (ext === '.pdf') return await extractPdfAttachment(storagePath)
  if (ext === '.pptx') return await extractPptxAttachment(storagePath)
  throw new Error('Unsupported file type')
}

export async function openChatFilePicker() {
  const result = await dialog.showOpenDialog({
    title: 'Add files to chat',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported files', extensions: Array.from(SUPPORTED_EXTENSIONS).map((ext) => ext.replace(/^\./, '')) },
      { name: 'All files', extensions: ['*'] }
    ]
  })

  if (result.canceled) {
    return { ok: true, filePaths: [] as string[] }
  }

  return { ok: true, filePaths: result.filePaths || [] }
}

export async function prepareChatAttachments(filePaths: string[]): Promise<{ ok: boolean; attachments: ChatAttachment[]; message?: string }> {
  const uniquePaths = Array.isArray(filePaths)
    ? filePaths.filter((filePath, index, all) => typeof filePath === 'string' && filePath.trim() && all.indexOf(filePath) === index)
    : []
  const normalized: string[] = []
  let fileAttachmentCount = 0
  let skippedFileAttachmentCount = 0

  for (const filePath of uniquePaths) {
    if (IMAGE_EXTENSIONS.has(extensionOf(filePath))) {
      normalized.push(filePath)
      continue
    }

    if (fileAttachmentCount < CHAT_ATTACHMENT_LIMITS.maxFileAttachmentsPerSend) {
      normalized.push(filePath)
      fileAttachmentCount += 1
    } else {
      skippedFileAttachmentCount += 1
    }
  }

  const attachments: ChatAttachment[] = []

  if (skippedFileAttachmentCount > 0) {
    attachments.push(buildBlockedAttachment('Too many files', 0, `Only ${CHAT_ATTACHMENT_LIMITS.maxFileAttachmentsPerSend} non-image files can be attached per send. Image uploads are unlimited.`))
  }

  for (const filePath of normalized) {
    try {
      const stat = await fsp.stat(filePath)
      const ext = extensionOf(filePath)
      if (!stat.isFile()) {
        attachments.push(buildBlockedAttachment(filePath, 0, 'Only files can be attached.'))
        continue
      }
      if (stat.size > CHAT_ATTACHMENT_LIMITS.maxFileBytes) {
        attachments.push(buildBlockedAttachment(filePath, stat.size, 'File exceeds the 10MB limit.'))
        continue
      }
      if (ext === '.xls') {
        attachments.push(buildBlockedAttachment(filePath, stat.size, 'Legacy .xls files are no longer supported. Save the spreadsheet as .xlsx and attach it again.'))
        continue
      }
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        attachments.push(buildBlockedAttachment(filePath, stat.size, 'Unsupported file type.'))
        continue
      }

      const storagePath = await copyToStaging(filePath)
      const extracted = await extractAttachmentData(storagePath)

      const maxVisualAssets = CHAT_ATTACHMENT_LIMITS.maxVisualAssetsPerRequest
      attachments.push({
        id: `attachment_${randomUUID()}`,
        name: path.basename(filePath),
        mimeType: extracted.mimeType,
        size: stat.size,
        kind: extracted.kind,
        storagePath,
        promptText: extracted.promptText,
        historySummary: summarizeAttachmentText(extracted.historySummary || extracted.promptText || path.basename(filePath)),
        imageDataUrls: maxVisualAssets === null ? extracted.imageDataUrls : extracted.imageDataUrls.slice(0, maxVisualAssets),
        warnings: extracted.warnings
      })
    } catch (error: any) {
      attachments.push(buildBlockedAttachment(filePath, 0, error?.message || 'Failed to process file.'))
    }
  }

  return { ok: true, attachments }
}

export async function removePreparedAttachment(storagePath: string): Promise<void> {
  if (!storagePath) return
  try {
    const baseDir = path.resolve(getAttachmentBaseDir())
    const candidate = path.resolve(storagePath)
    if (!candidate.startsWith(baseDir)) return
    if (fs.existsSync(candidate)) {
      await fsp.unlink(candidate)
    }
  } catch {
    // Ignore cleanup failures.
  }
}
