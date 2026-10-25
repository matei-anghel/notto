import { isValidNoteId } from '../shared/noteIds'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export interface NoteListItem {
  id: string
  name: string
  mtime: number
  size: number
  preview: string
  createdAt: number
}

export interface CreateNoteParams {
  title?: string
  summary?: string
  transcript?: string
  notes?: string
}

interface NotesRepositoryOptions {
  userDataDir: string
  sendProgress: (message: string) => void
  hooks?: {
    onDelete?: (id: string) => Promise<void> | void
    onRename?: (id: string, nextId: string) => Promise<void> | void
  }
}

const NOTE_EXT = '.txt'
const NOTE_PREVIEW_LENGTH = 160

export class NotesRepository {
  private readonly userDataDir: string
  private readonly sendProgress: (message: string) => void
  private readonly hooks?: NotesRepositoryOptions['hooks']
  private readonly metadataCache = new Map<string, { mtime: number; size: number; preview: string }>()

  constructor(options: NotesRepositoryOptions) {
    this.userDataDir = options.userDataDir
    this.sendProgress = options.sendProgress
    this.hooks = options.hooks
  }

  public getNotesDir(): string {
    return path.join(this.userDataDir, 'notes')
  }

  public async ensureDir(): Promise<void> {
    await fsp.mkdir(this.getNotesDir(), { recursive: true })
  }

  public isValidId(id: string): boolean {
    return isValidNoteId(id)
  }

  public async list(): Promise<NoteListItem[]> {
    await this.ensureDir()
    const dir = this.getNotesDir()
    const files = await fsp.readdir(dir)
    const txtFiles = files.filter((file) => file.toLowerCase().endsWith(NOTE_EXT))
    const stats = await Promise.all(txtFiles.map(async (file) => {
      const stat = await fsp.stat(path.join(dir, file))
      return { file, stat, createdAt: this.getCreatedAt(file, stat) }
    }))

    stats.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
      return b.stat.mtimeMs - a.stat.mtimeMs
    })

    const seen = new Set<string>()
    const items: NoteListItem[] = []

    for (const { file, stat, createdAt } of stats) {
      const cache = this.metadataCache.get(file)
      let preview = cache?.preview ?? 'Empty note'

      if (!cache || cache.mtime !== stat.mtimeMs || cache.size !== stat.size) {
        try {
          const text = await fsp.readFile(path.join(dir, file), 'utf8')
          preview = this.buildPreview(text)
        } catch (error: any) {
          preview = 'Unable to load preview'
          this.sendProgress(`Failed to cache preview for note ${file}: ${error?.message ?? String(error)}`)
        }
        this.metadataCache.set(file, { mtime: stat.mtimeMs, size: stat.size, preview })
      }

      items.push({ id: file, name: file, mtime: stat.mtimeMs, size: stat.size, preview, createdAt })
      seen.add(file)
    }

    for (const key of Array.from(this.metadataCache.keys())) {
      if (!seen.has(key)) {
        this.metadataCache.delete(key)
      }
    }

    return items
  }

  public async read(id: string): Promise<string> {
    await this.ensureDir()
    if (!this.isValidId(id)) throw new Error('Invalid note id')
    return await fsp.readFile(path.join(this.getNotesDir(), id), 'utf8')
  }

  public async save(id: string, text: string): Promise<void> {
    await this.ensureDir()
    if (!this.isValidId(id)) throw new Error('Invalid note id')
    const filePath = path.join(this.getNotesDir(), id)
    // A debounced autosave can land after the note was deleted or renamed; never recreate it.
    if (!fs.existsSync(filePath)) throw new Error('Note file does not exist')
    await fsp.writeFile(filePath, text ?? '', 'utf8')
    await this.refreshMetadata(id, text ?? '')
  }

  public async delete(id: string): Promise<void> {
    await this.ensureDir()
    if (!this.isValidId(id)) throw new Error('Invalid note id')

    const filePath = path.join(this.getNotesDir(), id)
    if (!fs.existsSync(filePath)) throw new Error('Note file does not exist')

    await fsp.unlink(filePath)
    this.metadataCache.delete(id)
    await this.safeHookDelete(id)
  }

  public async rename(id: string, nextId: string): Promise<void> {
    await this.ensureDir()
    if (!this.isValidId(id) || !this.isValidId(nextId)) throw new Error('Invalid note id')

    const currentPath = path.join(this.getNotesDir(), id)
    const nextPath = path.join(this.getNotesDir(), nextId)
    // fs.rename silently replaces an existing file. Only allow that when it is the same note
    // (a case-only rename on case-insensitive Windows/macOS file systems).
    const isSameFile = currentPath.toLowerCase() === nextPath.toLowerCase()
    if (!isSameFile && fs.existsSync(nextPath)) throw new Error('A note with that name already exists')
    await fsp.rename(currentPath, nextPath)

    const cached = this.metadataCache.get(id)
    this.metadataCache.delete(id)

    let renamedContent = ''
    try {
      renamedContent = await fsp.readFile(nextPath, 'utf8')
      const stat = await fsp.stat(nextPath)
      this.metadataCache.set(nextId, {
        mtime: stat.mtimeMs,
        size: stat.size,
        preview: cached?.preview ?? this.buildPreview(renamedContent)
      })
    } catch (error: any) {
      this.sendProgress(`Failed to refresh metadata after renaming note ${id}: ${error?.message ?? String(error)}`)
    }

    await this.safeHookRename(id, nextId)
  }

  public async create(params: CreateNoteParams): Promise<{ id: string; content: string }> {
    await this.ensureDir()
    const dir = this.getNotesDir()
    const basename = this.buildTimestampBase(true)
    const safeTitle = (params.title || 'Quick Note').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Quick Note'

    let filename = `${basename} - ${safeTitle}.txt`
    let filePath = path.join(dir, filename)
    let counter = 2
    while (fs.existsSync(filePath)) {
      filename = `${basename} - ${safeTitle} (${counter++}).txt`
      filePath = path.join(dir, filename)
    }

    const content = `# ${params.title || 'Quick Note'}\n\n${params.summary ? params.summary + '\n\n' : ''}${params.notes ? '---\n\n## 📌 Your Notes\n\n' + params.notes + '\n\n' : ''}${params.transcript ? '---\n\n## 📜 Transcript\n\n' + params.transcript : ''}\n`
    await fsp.writeFile(filePath, content, 'utf8')
    await this.refreshMetadata(filename, content)
    return { id: filename, content }
  }

  public async syncStandaloneNote(currentId: string | null, content: string): Promise<string | null> {
    const trimmedContent = (content ?? '').trim()

    if (trimmedContent.length > 0) {
      // The quick note may have been deleted from the notes list while this window kept typing.
      if (!currentId || !fs.existsSync(path.join(this.getNotesDir(), currentId))) {
        const nextId = await this.createStandaloneNote(content)
        this.sendProgress(`Auto-saved quick note: ${nextId}`)
        return nextId
      }

      await this.save(currentId, content)
      return currentId
    }

    if (!currentId) return null

    const filePath = path.join(this.getNotesDir(), currentId)
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath)
      this.metadataCache.delete(currentId)
      this.sendProgress(`Deleted quick note: ${currentId}`)
    }
    return null
  }

  private async createStandaloneNote(content: string): Promise<string> {
    await this.ensureDir()
    const dir = this.getNotesDir()
    const basename = this.buildTimestampBase(false)
    let filename = `${basename} - Quick Note.txt`
    let filePath = path.join(dir, filename)
    let counter = 2
    while (fs.existsSync(filePath)) {
      filename = `${basename} - Quick Note (${counter++}).txt`
      filePath = path.join(dir, filename)
    }

    await fsp.writeFile(filePath, content, 'utf8')
    await this.refreshMetadata(filename, content)
    return filename
  }

  private buildTimestampBase(includeSeconds: boolean): string {
    const ts = new Date()
    const pad = (n: number, width = 2) => String(n).padStart(width, '0')
    const seconds = includeSeconds ? pad(ts.getSeconds()) : ''
    return `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}${pad(ts.getMinutes())}${seconds}`
  }

  private async refreshMetadata(id: string, text: string): Promise<void> {
    try {
      const stat = await fsp.stat(path.join(this.getNotesDir(), id))
      this.metadataCache.set(id, { mtime: stat.mtimeMs, size: stat.size, preview: this.buildPreview(text) })
    } catch (error: any) {
      this.sendProgress(`Failed to refresh metadata for note ${id}: ${error?.message ?? String(error)}`)
    }
  }

  private buildPreview(text: string): string {
    try {
      const normalized = text ?? ''
      const summaryMatch = normalized.match(/\*\*Summary\*\*\s*\n+([\s\S]*?)(?=\n---|\n\*\*[A-Za-z]|\n##|\n$)/i)
      if (summaryMatch?.[1]) {
        const summaryText = summaryMatch[1].replace(/\\r?\\n/g, ' ').replace(/\s+/g, ' ').trim()
        if (summaryText) {
          return summaryText.length > NOTE_PREVIEW_LENGTH ? `${summaryText.slice(0, NOTE_PREVIEW_LENGTH)}...` : summaryText
        }
      }

      const withoutNewlines = normalized.replace(/\r?\n/g, ' ')
      const withoutMarkdown = withoutNewlines
        .replace(/#{1,6}\s*/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]\([^)]*\)/g, '$1')
        .replace(/>\s+/g, '')
      const compact = withoutMarkdown.replace(/\s+/g, ' ').trim()
      if (!compact) return 'Empty note'
      return compact.length > NOTE_PREVIEW_LENGTH ? `${compact.slice(0, NOTE_PREVIEW_LENGTH)}...` : compact
    } catch {
      return 'Empty note'
    }
  }

  private parseTimestampFromName(file: string): number | null {
    try {
      const base = file.replace(/\.txt$/i, '')
      const match = base.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(\d{2})?(?:\s*-\s*|$)/)
      if (!match) return null
      const [, year, month, day, hour, minute, second] = match
      const date = new Date(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        second ? parseInt(second, 10) : 0
      )
      const time = date.getTime()
      return Number.isFinite(time) ? time : null
    } catch {
      return null
    }
  }

  private getCreatedAt(file: string, stat: fs.Stats): number {
    const parsed = this.parseTimestampFromName(file)
    if (parsed) return parsed
    if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) return stat.birthtimeMs
    return stat.mtimeMs
  }

  private async safeHookDelete(id: string): Promise<void> {
    try {
      await this.hooks?.onDelete?.(id)
    } catch (error: any) {
      this.sendProgress(`Failed running delete hook for note ${id}: ${error?.message ?? String(error)}`)
    }
  }

  private async safeHookRename(id: string, nextId: string): Promise<void> {
    try {
      await this.hooks?.onRename?.(id, nextId)
    } catch (error: any) {
      this.sendProgress(`Failed running rename hook for note ${id}: ${error?.message ?? String(error)}`)
    }
  }}
