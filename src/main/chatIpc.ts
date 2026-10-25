import { BrowserWindow, clipboard, ipcMain } from 'electron'
import { IPC } from '../shared/ipcChannels'
import { NotesRepository } from './notesRepository'
import { openChatFilePicker, prepareChatAttachments } from './chatAttachmentManager'
import { serializeAttachmentContext, type ChatAttachment, type ChatAttachmentKind } from '../shared/chatAttachments'
import { AiNotConfiguredError, chatCompletion, type ChatMessage } from './ai/aiClient'
import { buildChatOverlaySystemPrompt } from '../shared/chatOverlaySystemPrompt'
import { rankNotes } from '../shared/noteSearch'

interface ChatSendParams {
  messages: any[]
  stream?: boolean
  manualNoteIds?: string[]
  /** With no manually selected notes, search all notes for ones relevant to the question. */
  searchAllNotes?: boolean
}

// Chat with Notes search: how many recent notes are searched and how much of them is sent.
const MAX_SEARCHED_NOTES = 500
const MAX_MATCHED_NOTES = 5
const FALLBACK_RECENT_NOTES = 3
const MAX_NOTE_CHARS = 15_000
const MAX_NOTES_CONTEXT_CHARS = 60_000

interface ChatIpcDependencies {
  notesRepository: NotesRepository
  getPrefs: () => any
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
  getChatWindow: () => BrowserWindow | null
  hideChatOverlayWindow: () => void
  toggleChatWindow: () => void
  resizeChatWindow: (height: number) => void
  getLastTranscriptText: () => string
  getActiveChatAbortController: () => AbortController | null
  setActiveChatAbortController: (controller: AbortController | null) => void
}

function mapMessagesForProvider(rawMessages: any[]): ChatMessage[] {
  const lastUserMessageIndex = Array.isArray(rawMessages)
    ? rawMessages.map((message: any, index: number) => message?.role === 'user' ? index : -1).filter((index) => index >= 0).pop() ?? -1
    : -1

  return Array.isArray(rawMessages)
    ? rawMessages.map((m: any, index: number) => {
      const attachments = Array.isArray(m.attachments) ? m.attachments as ChatAttachment[] : []
      const attachmentContext = serializeAttachmentContext(attachments, {
        mode: index === lastUserMessageIndex ? 'current' : 'history'
      })
      const textContent = [m.content || '', attachmentContext.text].filter(Boolean).join('\n\n').trim()
      const imageUrls: string[] = []
      if (Array.isArray(m.screenshotDataUrls) && m.screenshotDataUrls.length > 0) {
        imageUrls.push(...m.screenshotDataUrls)
      }
      if (Array.isArray(m.screenshots) && m.screenshots.length > 0) {
        m.screenshots.forEach((shot: any) => {
          if (shot?.base64Data) {
            imageUrls.push(`data:image/png;base64,${shot.base64Data}`)
          }
        })
      }
      if (Array.isArray(m.files) && m.files.length > 0) {
        m.files.forEach((file: any) => {
          if (file?.dataUrl && file.type?.startsWith('image/')) {
            imageUrls.push(file.dataUrl)
          }
        })
      }
      if (attachmentContext.imageDataUrls.length > 0) {
        imageUrls.push(...attachmentContext.imageDataUrls)
      }

      if (imageUrls.length > 0) {
        return {
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: [
            ...(textContent ? [{ type: 'text' as const, text: textContent }] : []),
            ...imageUrls.map((url: string) => ({
              type: 'image_url' as const,
              image_url: { url }
            }))
          ]
        }
      }

      return {
        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
        content: textContent
      }
    })
    : []
}

function normalizeIncomingAttachment(raw: any): ChatAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const kind = typeof raw.kind === 'string' ? raw.kind as ChatAttachmentKind : 'document'
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : 'Attachment',
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
    size: typeof raw.size === 'number' ? raw.size : 0,
    kind,
    storagePath: typeof raw.storagePath === 'string' ? raw.storagePath : '',
    promptText: typeof raw.promptText === 'string' ? raw.promptText : '',
    historySummary: typeof raw.historySummary === 'string' ? raw.historySummary : '',
    imageDataUrls: Array.isArray(raw.imageDataUrls) ? raw.imageDataUrls.filter((url: unknown) => typeof url === 'string') : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((warning: unknown) => typeof warning === 'string') : [],
    blocked: !!raw.blocked
  }
}

function normalizeRawMessages(rawMessages: any[]): any[] {
  if (!Array.isArray(rawMessages)) return []
  return rawMessages.map((message: any) => ({
    ...message,
    attachments: Array.isArray(message?.attachments)
      ? message.attachments.map(normalizeIncomingAttachment).filter(Boolean)
      : []
  }))
}

function noteTitleFromId(noteId: string): string {
  return noteId.replace(/\.txt$/i, '').replace(/^\d{4}-\d{2}-\d{2} \d{4,6} - /, '')
}

/** Text of the latest user turns, used as the search query (follow-ups keep their context). */
function searchQueryFromMessages(rawMessages: any[]): string {
  return rawMessages
    .filter((message: any) => message?.role === 'user' && typeof message.content === 'string')
    .slice(-2)
    .map((message: any) => message.content)
    .join('\n')
}

/** Pick notes for the question: the user's selection, else the best keyword matches, else the newest notes. */
async function selectNotes(deps: ChatIpcDependencies, manualNoteIds: string[], searchQuery: string | null): Promise<Array<{ id: string; reason: string }>> {
  if (manualNoteIds.length > 0 || searchQuery === null) {
    return manualNoteIds.map((id) => ({ id, reason: 'manually selected' }))
  }
  const listed = (await deps.notesRepository.list())
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SEARCHED_NOTES)
  const notes = await Promise.all(listed.map(async (item) => ({
    id: item.id,
    title: noteTitleFromId(item.id),
    text: await deps.notesRepository.read(item.id).catch(() => ''),
    mtime: item.mtime,
  })))
  const matches = rankNotes(searchQuery, notes, MAX_MATCHED_NOTES)
  deps.sendProgress(`Searched ${notes.length} notes, ${matches.length} matched`)
  return matches.length > 0
    ? matches.map((match) => ({ id: match.id, reason: 'matched your question' }))
    : notes.slice(0, FALLBACK_RECENT_NOTES).map((note) => ({ id: note.id, reason: 'most recent' }))
}

async function buildNotesContext(deps: ChatIpcDependencies, manualNoteIds: string[], searchQuery: string | null = null): Promise<{
  notesContent: string
  usedNoteIds: string[]
  sourceMap: Record<string, string>
}> {
  const notesContentParts: string[] = []
  const usedNoteIds = new Set<string>()
  const sourceMap: Record<string, string> = {}
  let remainingChars = MAX_NOTES_CONTEXT_CHARS

  for (const { id: noteId, reason } of await selectNotes(deps, manualNoteIds, searchQuery)) {
    if (remainingChars <= 0) break
    try {
      if (!deps.notesRepository.isValidId(noteId) || usedNoteIds.has(noteId)) continue
      const text = await deps.notesRepository.read(noteId)
      if (!text) continue
      // Manually selected notes are sent whole; searched notes share a size budget.
      const included = reason === 'manually selected' ? text : text.slice(0, Math.min(MAX_NOTE_CHARS, remainingChars))
      remainingChars -= included.length
      notesContentParts.push(`## Note: ${noteTitleFromId(noteId)}\n\n${included}`)
      usedNoteIds.add(noteId)
      sourceMap[noteId] = reason
    } catch (error) {
      console.error(`Failed to read note ${noteId}:`, error)
    }
  }

  return {
    notesContent: notesContentParts.join('\n\n---\n\n'),
    usedNoteIds: Array.from(usedNoteIds),
    sourceMap
  }
}

export function registerChatIpcHandlers(deps: ChatIpcDependencies): void {
  ipcMain.handle(IPC.invoke.chat.openFilePicker, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ filePaths: [] })
    }
    try {
      return await openChatFilePicker()
    } catch (e: any) {
      return { ok: false, filePaths: [], message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.chat.prepareAttachments, async (evt, payload: { filePaths?: string[] }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ attachments: [] })
    }
    try {
      return await prepareChatAttachments(Array.isArray(payload?.filePaths) ? payload.filePaths : [])
    } catch (e: any) {
      return { ok: false, attachments: [], message: e?.message ?? String(e) }
    }
  })

  const sendChat = async (evt: Electron.IpcMainInvokeEvent, params: ChatSendParams = { messages: [] }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ streaming: false, text: '' })
    }

    if (!params || !Array.isArray(params.messages) || !params.messages.length) {
      return { ok: false, message: 'Chat messages are required' }
    }

    const rawMessages = normalizeRawMessages(Array.isArray(params?.messages) ? params.messages : [])
    const manualNoteIds = Array.isArray(params?.manualNoteIds)
      ? params.manualNoteIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : []
    const activeAbortController = deps.getActiveChatAbortController()
    if (activeAbortController) {
      activeAbortController.abort()
    }
    const requestController = new AbortController()
    deps.setActiveChatAbortController(requestController)
    const sendChunk = (chunk: string) => {
      requestController.signal.throwIfAborted()
      if (deps.getActiveChatAbortController() === requestController) {
        evt.sender.send(IPC.event.mainToRenderer.chatStreamChunk, chunk)
      }
    }

    try {
      const notesContext = await buildNotesContext(deps, manualNoteIds, params.searchAllNotes ? searchQueryFromMessages(rawMessages) : null)
      const hasNotes = notesContext.notesContent.trim().length > 0
      const messages: ChatMessage[] = [
        { role: 'system', content: buildChatOverlaySystemPrompt(hasNotes ? notesContext.notesContent : undefined) },
        ...mapMessagesForProvider(rawMessages),
      ]
      const result = await chatCompletion({
        messages,
        stream: params.stream !== false,
        signal: requestController.signal,
        onChunk: sendChunk,
      })
      requestController.signal.throwIfAborted()
      if (result.streaming) evt.sender.send(IPC.event.mainToRenderer.chatStreamDone)
      return {
        ...result,
        ...(hasNotes ? { sources: { noteIds: notesContext.usedNoteIds, sourceMap: notesContext.sourceMap } } : {})
      }
    } catch (e: any) {
      if (deps.getActiveChatAbortController() === requestController && !requestController.signal.aborted) {
        try {
          evt.sender.send(IPC.event.mainToRenderer.chatStreamError, e?.message ?? String(e))
        } catch { }
      }
      return { ok: false, message: e?.message ?? String(e), needsSetup: e instanceof AiNotConfiguredError }
    } finally {
      if (deps.getActiveChatAbortController() === requestController) {
        deps.setActiveChatAbortController(null)
      }
    }
  }
  ipcMain.handle(IPC.invoke.chat.send, sendChat)

  ipcMain.handle(IPC.invoke.chat.abort, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    const controller = deps.getActiveChatAbortController()
    if (controller) {
      controller.abort()
      deps.setActiveChatAbortController(null)
      return { ok: true }
    }
    return { ok: false, message: 'No active request' }
  })

  ipcMain.handle(IPC.invoke.chat.withNotes, (evt, params) => sendChat(evt, {
    ...params,
    manualNoteIds: params?.manualNoteIds ?? params?.notesContext,
    stream: false,
  }))

  ipcMain.handle(IPC.invoke.chat.minimize, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const chatWindow = deps.getChatWindow()
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.minimize()
      }
    } catch { }
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.chat.close, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const chatWindow = deps.getChatWindow()
      if (chatWindow && !chatWindow.isDestroyed()) {
        deps.hideChatOverlayWindow()
      }
    } catch { }
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.chat.toggle, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.toggleChatWindow()
    } catch { }
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.chat.getLastTranscript, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult({ text: '' })
    return { ok: true, text: deps.getLastTranscriptText() || '' }
  })

  ipcMain.handle(IPC.invoke.chat.clipboardRead, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ text: '' })
    }
    try {
      return { ok: true, text: clipboard.readText() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.chat.resize, async (evt, height: number) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.resizeChatWindow(height)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
