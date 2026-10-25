// AI Chat Overlay

import { marked } from 'marked'
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import {
  collectManualNoteIdsFromMessages,
  detectActiveNoteMention,
  extractNoteMentionsFromText,
  filterNoteMentionOptions,
  getNoteMentionOptions,
  insertNoteMentionToken,
  pruneDraftNoteMentions,
  replaceMentionTokensForSend,
  type NoteLike,
  type NoteMention,
  type NoteMentionOption
} from './shared/noteMentions';
import type { ChatAttachment } from './shared/chatAttachments'

// Configure marked with highlight.js
const renderer = new marked.Renderer();

// Override code block renderer to add hljs class
renderer.code = function (code: string, language?: string) {
  const lang = language || '';
  let highlighted: string;

  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(code, { language: lang }).value;
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }

  // Add hljs class for styling
  const langClass = lang ? ` language-${lang}` : '';
  return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
};

marked.setOptions({
  renderer: renderer,
  breaks: true,
  gfm: true
});

// Math expression protection - extract math before markdown parsing to preserve delimiters
interface MathPlaceholder {
  id: string
  content: string
}

function protectMathExpressions(text: string): { protectedText: string; mathExpressions: MathPlaceholder[] } {
  const mathExpressions: MathPlaceholder[] = []
  let placeholderId = 0
  let protectedText = text

  // Protect block math: $$...$$ (must be on separate lines or have newlines)
  protectedText = protectedText.replace(/\$\$([\s\S]*?)\$\$/g, (match, content) => {
    const id = `MATHPLACEHOLDER_BLOCK_${placeholderId++}_END`
    mathExpressions.push({ id, content: `$$${content}$$` })
    // Wrap in backticks so markdown preserves it
    return `\`${id}\``
  })

  // Protect block math: \[...\]
  protectedText = protectedText.replace(/\\\[([\s\S]*?)\\\]/g, (match, content) => {
    const id = `MATHPLACEHOLDER_BLOCK_${placeholderId++}_END`
    mathExpressions.push({ id, content: `\\[${content}\\]` })
    // Wrap in backticks so markdown preserves it
    return `\`${id}\``
  })

  // Protect inline math: \(...\)
  protectedText = protectedText.replace(/\\\(([\s\S]*?)\\\)/g, (match, content) => {
    const id = `MATHPLACEHOLDER_INLINE_${placeholderId++}_END`
    mathExpressions.push({ id, content: `\\(${content}\\)` })
    // Wrap in backticks so markdown preserves it
    return `\`${id}\``
  })

  // Protect inline math: $...$ (single dollar signs, not part of $$)
  // Match $...$ but not $$...$$, and handle escaped dollars
  protectedText = protectedText.replace(/(?<!\$)\$(?!\$)((?:(?!\$).)*?)(?<!\$)\$(?!\$)/g, (match, content) => {
    // Skip if this is already a placeholder
    if (match.includes('MATHPLACEHOLDER_')) return match
    // Skip if content is empty or just whitespace
    if (!content.trim()) return match
    const id = `MATHPLACEHOLDER_INLINE_${placeholderId++}_END`
    mathExpressions.push({ id, content: `$${content}$` })
    // Wrap in backticks so markdown preserves it
    return `\`${id}\``
  })

  return { protectedText, mathExpressions }
}

function restoreMathExpressions(text: string, mathExpressions: MathPlaceholder[]): string {
  let restoredText = text
  // Restore in reverse order to avoid ID conflicts
  for (let i = mathExpressions.length - 1; i >= 0; i--) {
    const math = mathExpressions[i]
    const escapedId = math.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Markdown converts backticks to <code> tags, so look for that pattern
    // Also check for raw placeholder in case it wasn't wrapped
    const patterns = [
      new RegExp(`<code>${escapedId}</code>`, 'gi'),
      new RegExp(`<code[^>]*>${escapedId}</code>`, 'gi'),
      new RegExp(`\`${escapedId}\``, 'g'),
      new RegExp(escapedId, 'g')
    ]
    patterns.forEach(regex => {
      restoredText = restoredText.replace(regex, math.content)
    })
  }
  return restoredText
}

function escapeHtml(value: string): string {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isReadyAttachment(attachment: ChatAttachment | null | undefined): attachment is ChatAttachment {
  return !!attachment && !attachment.blocked
}

function getReadyAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.filter(isReadyAttachment)
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  return attachment.kind === 'image'
}

function getReadyImageAttachments(attachments?: ChatAttachment[]): ChatAttachment[] {
  return getReadyAttachments(attachments ?? attachedFiles).filter(isImageAttachment)
}

function getReadyFileAttachments(attachments?: ChatAttachment[]): ChatAttachment[] {
  return getReadyAttachments(attachments ?? attachedFiles).filter((attachment) => !isImageAttachment(attachment))
}

function getAttachmentIconMarkup(attachment: ChatAttachment): string {
  if (attachment.kind === 'image') {
    return '<rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.5" cy="5.5" r="1.5"/><path d="M14 10l-3-3-4 4-2-2-3 3"/>'
  }
  if (attachment.kind === 'spreadsheet') {
    return '<path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M2 6h12M6 2v12M10 2v12"/>'
  }
  if (attachment.kind === 'presentation') {
    return '<path d="M3 3h10v8H3z"/><path d="M8 11v3"/><path d="M5.5 14h5"/>'
  }
  if (attachment.kind === 'pdf') {
    return '<path d="M9 2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7z"/><path d="M9 2v5h5"/><path d="M4.5 10.5h5"/>'
  }
  return '<path d="M9 2H4a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2V7l-5-5z"/><path d="M9 2v5h5"/>'
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  noteMentions?: NoteMention[]
  attachments?: ChatAttachment[]
}

interface ChatHistory {
  id: string
  messages: Message[]
  timestamp: number
  title: string
  screenshotCount?: number
}

interface AttachedScreenshot {
  id: string
  filePath: string
  timestamp: number
}

let messages: Message[] = []
let currentChatId: string | null = null
let attachedScreenshots: AttachedScreenshot[] = []
let attachedFiles: ChatAttachment[] = []
let clickThroughActive = false
let isCancelRequested = false
let isGenerating = false
let chatRequestVersion = 0
let pendingUserMessageTimestamp: number | null = null
let hasStreamingActivity = false
let cachedNotes: NoteLike[] = []
let noteMentionOptions: NoteMentionOption[] = []
let draftNoteMentions: NoteMention[] = []
let activeMentionOptions: NoteMentionOption[] = []
let activeMentionIndex = 0

let activeStreamUnsub: {
  chunk?: () => void
  done?: () => void
  error?: () => void
} | null = null

const chatContainer = document.getElementById('chat-container') as HTMLElement | null
const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement | null
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null

function applyOverlayHoverable(enabled: boolean) {
  document.body.classList.toggle('chat-overlay-hoverable', enabled)
}

function applyOverlayTextCursor(enabled: boolean) {
  document.body.classList.toggle('chat-overlay-text-cursor', enabled)
}

function applyOverlayMinimal(enabled: boolean) {
  document.body.classList.toggle('chat-overlay-minimal', enabled)
  if (chatInput) {
    chatInput.placeholder = enabled ? '' : 'Ask anything...'
  }
  lastRenderedMessageCount = -1
  renderMessages()
}
const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement | null
const historyBtn = document.getElementById('history-btn') as HTMLButtonElement | null
const historyPanel = document.getElementById('history-panel') as HTMLElement | null
const closeHistoryBtn = document.getElementById('close-history-btn') as HTMLButtonElement | null
const historyList = document.getElementById('history-list') as HTMLElement | null
const screenshotsInline = document.getElementById('screenshots-inline') as HTMLElement | null
const attachedFilesContainer = document.getElementById('attached-files') as HTMLElement | null
const attachFileBtn = document.getElementById('attach-file-btn') as HTMLButtonElement | null
const noteMentionList = document.getElementById('note-mention-list') as HTMLElement | null

const imageModal = document.getElementById('image-modal') as HTMLElement | null
const modalImage = document.getElementById('modal-image') as HTMLImageElement | null

// Scrollbar activity management
if (chatContainer) {
  let scrollTimeout: number | null = null
  chatContainer.addEventListener('scroll', () => {
    chatContainer.classList.add('scrolling')
    if (scrollTimeout) clearTimeout(scrollTimeout)
    scrollTimeout = window.setTimeout(() => {
      chatContainer.classList.remove('scrolling')
    }, 1000)
  }, { passive: true })
}

if (historyList) {
  let historyScrollTimeout: number | null = null
  historyList.addEventListener('scroll', () => {
    historyList.classList.add('scrolling')
    if (historyScrollTimeout) clearTimeout(historyScrollTimeout)
    historyScrollTimeout = window.setTimeout(() => {
      historyList.classList.remove('scrolling')
    }, 1000)
  }, { passive: true })
}

// Load saved messages and model from localStorage
// Migration function
async function migrateLocalStorageToSqlite() {
  try {
    const historyData = localStorage.getItem('chat_history')
    if (!historyData) return

    const history = JSON.parse(historyData)
    if (!Array.isArray(history) || history.length === 0) return

    console.log('Migrating chat history to SQLite...', history.length)

    for (const chat of history) {
      await window.electronAPI.saveChat(chat.id, chat.title, chat.messages)
    }

    localStorage.removeItem('chat_history')
    console.log('Migration complete')
  } catch (e) {
    console.error('Migration failed:', e)
  }
}

async function loadState() {
  try {
    await migrateLocalStorageToSqlite()

    const hasOpenedBefore = localStorage.getItem('chat_has_opened_before')

    if (!hasOpenedBefore) {
      localStorage.setItem('chat_has_opened_before', 'true')
      messages = []
      currentChatId = null
    } else {
      const savedChatId = localStorage.getItem('current_chat_id')
      if (savedChatId) {
        currentChatId = savedChatId
        const result = await window.electronAPI.getChat(savedChatId)
        if (result.ok && result.chat) {
          messages = result.chat.messages
          renderMessages()
        } else {
          const saved = localStorage.getItem('chat_messages')
          if (saved) {
            messages = JSON.parse(saved)
            renderMessages()
          }
        }
      } else {
        const saved = localStorage.getItem('chat_messages')
        if (saved) {
          messages = JSON.parse(saved)
          renderMessages()
        }
      }
    }

  } catch { }
}

function saveState() {
  try {
    localStorage.setItem('chat_messages', JSON.stringify(messages))
    if (currentChatId) {
      localStorage.setItem('current_chat_id', currentChatId)
    }
  } catch { }
}

async function refreshNoteMentionOptions() {
  try {
    const res = await window.electronAPI.notesList()
    cachedNotes = res?.ok && Array.isArray(res.items) ? res.items : []
    noteMentionOptions = getNoteMentionOptions(cachedNotes)
  } catch (error) {
    console.error('Failed to load notes for mentions:', error)
    cachedNotes = []
    noteMentionOptions = []
  }
}

function getOverlayReadyAttachmentCount(): number {
  return attachedScreenshots.length + getReadyAttachments(attachedFiles).length
}

function getOverlayNoteIdsWithDraft(draftMentions: NoteMention[]): string[] {
  return collectManualNoteIdsFromMessages([
    ...messages,
    ...(draftMentions.length > 0 ? [{ role: 'user', noteMentions: draftMentions }] : [])
  ] as Array<{ role?: string; noteMentions?: NoteMention[] }>)
}

function hideNoteMentionList() {
  activeMentionOptions = []
  activeMentionIndex = 0
  if (noteMentionList) {
    noteMentionList.style.display = 'none'
    noteMentionList.innerHTML = ''
  }
}

function renderNoteMentionList() {
  if (!noteMentionList) return

  if (activeMentionOptions.length === 0) {
    noteMentionList.innerHTML = '<div class="note-mention-empty">No matching notes</div>'
    noteMentionList.style.display = 'block'
    return
  }

  noteMentionList.innerHTML = activeMentionOptions.map((option, index) => `
    <button class="note-mention-item${index === activeMentionIndex ? ' active' : ''}" data-index="${index}" type="button">
      <span class="note-mention-title">${escapeHtml(option.label)}</span>
      <span class="note-mention-preview">${escapeHtml(option.preview || 'Empty note')}</span>
    </button>
  `).join('')
  noteMentionList.style.display = 'block'

  noteMentionList.querySelectorAll('.note-mention-item').forEach((element) => {
    element.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const index = Number((element as HTMLElement).dataset.index || '-1')
      const option = activeMentionOptions[index]
      if (option) {
        applySelectedNoteMention(option).catch((error) => console.error('Failed to apply note mention:', error))
      }
    })
  })
}

function updateNoteMentionList() {
  if (!chatInput || !noteMentionList) return

  const activeMention = detectActiveNoteMention(chatInput.value, chatInput.selectionStart ?? chatInput.value.length)
  if (!activeMention) {
    hideNoteMentionList()
    return
  }

  activeMentionOptions = filterNoteMentionOptions(noteMentionOptions, activeMention.query)
  activeMentionIndex = Math.min(activeMentionIndex, Math.max(activeMentionOptions.length - 1, 0))
  renderNoteMentionList()
}

async function applySelectedNoteMention(option: NoteMentionOption) {
  if (!chatInput) return
  const selectionStart = chatInput.selectionStart ?? chatInput.value.length
  const selectionEnd = chatInput.selectionEnd ?? selectionStart
  const inserted = insertNoteMentionToken(chatInput.value, selectionStart, selectionEnd, option)
  if (!inserted) return

  chatInput.value = inserted.text
  chatInput.setSelectionRange(inserted.selectionStart, inserted.selectionEnd)
  draftNoteMentions = pruneDraftNoteMentions(chatInput.value, [...draftNoteMentions, inserted.mention])
  hideNoteMentionList()
  chatInput.dispatchEvent(new Event('input'))
  chatInput.focus()
}

function updateSendButtonState() {
  if (!sendBtn || !chatInput) return

  // During generation, show stop button
  if (isGenerating) {
    sendBtn.classList.add('is-generating')
    sendBtn.classList.remove('has-text')
    return
  }

  sendBtn.classList.remove('is-generating')
  const hasContent = chatInput.value.trim().length > 0 || attachedScreenshots.length > 0 || getReadyAttachments(attachedFiles).length > 0
  if (hasContent) {
    sendBtn.classList.add('has-text')
  } else {
    sendBtn.classList.remove('has-text')
  }
}

// Chat History Management
function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

function getChatTitle(messages: Message[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (firstUserMessage) {
    const content = firstUserMessage.content.trim() || firstUserMessage.attachments?.[0]?.name || ''
    return content.length > 50 ? content.substring(0, 50) + '...' : content
  }
  return 'New Chat'
}

// Function to clean markdown symbols from text for preview
function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '') // Remove bold **
    .replace(/\*/g, '') // Remove italic *
    .replace(/__/g, '') // Remove bold __
    .replace(/_/g, '') // Remove italic _
    .replace(/#{1,6}\s/g, '') // Remove headers #
    .replace(/`/g, '') // Remove code backticks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '') // Remove images
    .replace(/>/g, '') // Remove blockquote >
    .replace(/[-*+]\s/g, '') // Remove list markers
    .replace(/\d+\.\s/g, '') // Remove numbered list markers
    .trim()
}

async function saveCurrentChatToHistory() {
  if (messages.length === 0) return

  try {
    if (!currentChatId) {
      currentChatId = generateChatId()
    }

    const persistedMessages = await Promise.all(messages.map(async (msg) => {
      if ((msg as any).screenshots && (msg as any).screenshots.length > 0) {
        const screenshots = (msg as any).screenshots
        const screenshotData = []
        for (const screenshot of screenshots) {
          try {
            if (!screenshot.base64Data && (!screenshot.filePath || !screenshot.filePath.includes('attachments'))) {
              const result = await window.electronAPI.screenshotGetBase64(screenshot.id)
              if (result.ok && result.base64) {
                screenshotData.push({
                  id: screenshot.id,
                  base64Data: result.base64,
                  timestamp: screenshot.timestamp,
                  filePath: screenshot.filePath
                })
              } else {
                screenshotData.push(screenshot)
              }
            } else {
              screenshotData.push(screenshot)
            }
          } catch (e) {
            console.error('Failed to get screenshot data:', e)
            screenshotData.push(screenshot)
          }
        }
        return { ...msg, screenshots: screenshotData }
      }
      return msg
    }))

    const chatTitle = getChatTitle(messages)

    await window.electronAPI.saveChat(currentChatId, chatTitle, persistedMessages)

    localStorage.setItem('chat_messages', JSON.stringify(messages))
    if (currentChatId) {
      localStorage.setItem('current_chat_id', currentChatId)
    }
  } catch (e) {
    console.error('Failed to save chat history:', e)
  }
}

async function loadChatHistory(): Promise<ChatHistory[]> {
  try {
    const result = await window.electronAPI.getHistory()
    return result.ok && result.chats ? result.chats : []
  } catch {
    return []
  }
}

async function deleteChatFromHistory(chatId: string) {
  try {
    const result = await window.electronAPI.deleteChat(chatId)
    if (!result.ok) {
      console.error('Failed to delete chat:', result.message)
      return
    }

    // If this is the current chat, clear it
    if (currentChatId === chatId) {
      currentChatId = ''
      messages = []
      attachedScreenshots = []
      renderScreenshots()
      saveState()
      renderMessages()
    }

    // Remove from loaded chats array
    loadedChats = loadedChats.filter(chat => chat.id !== chatId)

    // Remove the item from the DOM without refreshing (preserves scroll)
    if (historyList) {
      const items = historyList.querySelectorAll('.history-item')
      items.forEach(item => {
        const titleEl = item.querySelector('.history-item-title')
        if (titleEl && item.addEventListener) {
          // Check if this item's click handler matches the deleted chat
          // We'll use a data attribute approach instead
        }
      })

      // Better approach: find and remove by iterating through loaded chats
      const itemIndex = Array.from(items).findIndex((item, idx) => {
        return loadedChats[idx]?.id === chatId
      })

      // Simpler: just re-render the visible items without resetting scroll
      const scrollTop = historyList.scrollTop

      // Remove all items
      historyList.innerHTML = ''

      // Re-render remaining chats
      loadedChats.forEach(chat => {
        const item = createHistoryItem(chat)
        historyList.appendChild(item)
      })

      // Add loader if needed
      if (hasMoreHistory) {
        const loader = document.createElement('div')
        loader.className = 'history-loader'
        loader.style.padding = '16px'
        loader.style.textAlign = 'center'
        loader.style.color = 'var(--text-secondary)'
        loader.style.fontSize = '12px'
        loader.textContent = 'Scroll for more...'
        historyList.appendChild(loader)
      }

      // Restore scroll position
      historyList.scrollTop = scrollTop

      // Resize window to fit updated history list
      requestAnimationFrame(() => {
        resizeWindowToContent(true)
      })
    }
  } catch (e) {
    console.error('Failed to delete chat from history:', e)
  }
}

async function loadChatFromHistory(chatId: string) {
  try {
    const result = await window.electronAPI.getChat(chatId)
    if (result.ok && result.chat) {
      const chat = result.chat
      // COMPLETELY NEW APPROACH: Constrain container height during measurement
      // Hide history panel immediately
      historyPanel.style.display = 'none'
      historyPanel.style.visibility = 'hidden'

      // Reset state
      previousChatHeight = null
      messages = [...chat.messages]
      currentChatId = chat.id
      draftNoteMentions = []
      hideNoteMentionList()
      lastRenderedMessageCount = 0
      markdownCache.clear()

      // Clear and prepare container
      chatContainer.innerHTML = ''

      // Render the chat content
      renderMessages()
      saveState()

      // Force layout calculation
      void chatContainer.offsetHeight

      // Resize window to fit content
      requestAnimationFrame(() => {
        // Force a resize calculation
        lastResizeHeight = 0
        resizeWindowToContent(true)

        // Double check after a short delay to ensure layout is settled
        setTimeout(() => {
          resizeWindowToContent(true)
        }, 50)
      })
    }
  } catch (e) {
    console.error('Failed to load chat:', e)
  }
}

async function startNewChat() {
  // Resize IMMEDIATELY with fire-and-forget to avoid any wait
  window.electronAPI.chatResize(44).catch(() => { })
  lastResizeHeight = 44

  // Save current chat if needed (async, don't wait)
  if (messages.length > 0) {
    saveCurrentChatToHistory().catch(e => console.error('Failed to save chat history:', e))
  }

  // Clear state FIRST - this ensures UI updates correctly
  messages = []
  currentChatId = null
  lastRenderedMessageCount = 0
  markdownCache.clear()
  localStorage.removeItem('current_chat_id')

  // Disable transition temporarily to get instant height
  const originalTransition = chatInput.style.transition
  chatInput.style.transition = 'none'

  // Clear attachments
  attachedScreenshots = []
  attachedFiles = []
  draftNoteMentions = []
  hideNoteMentionList()
  renderScreenshots()
  renderAttachedFiles()

  // Update UI based on cleared state
  updateNewChatButtonVisibility()
  chatContainer.innerHTML = ''
  saveState()

  // Reset input height instantly with no transition
  chatInput.value = ''
  chatInput.style.height = 'auto'

  // Restore transition
  requestAnimationFrame(() => {
    chatInput.style.transition = originalTransition
    // Double check resize in case layout shifted
    resizeWindowToContent(true)
  })

  // Focus after a brief moment
  setTimeout(() => {
    if (document.hasFocus()) {
      chatInput.focus()
    }
  }, 0)
}

// Helper function to create a history item element
function createHistoryItem(chat: ChatHistory): HTMLElement {
  const item = document.createElement('div')
  item.className = 'history-item'

  const header = document.createElement('div')
  header.className = 'history-item-header'

  const title = document.createElement('div')
  title.className = 'history-item-title'
  const messageCount = chat.messages ? chat.messages.filter(m => m.role === 'user').length : 0
  title.textContent = `${chat.title} (${messageCount} ${messageCount === 1 ? 'exchange' : 'exchanges'})`

  const actions = document.createElement('div')
  actions.className = 'history-item-actions'

  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'history-delete-btn'
  deleteBtn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    deleteChatFromHistory(chat.id)
  })

  actions.appendChild(deleteBtn)
  header.appendChild(title)

  const preview = document.createElement('div')
  preview.className = 'history-item-preview'
  const firstMsg = chat.messages ? chat.messages.find(m => m.role === 'assistant') : null
  if (firstMsg) {
    const cleanedText = cleanMarkdown(firstMsg.content)
    preview.textContent = cleanedText.length > 120 ? cleanedText.substring(0, 120) + '...' : cleanedText
  }

  const date = document.createElement('div')
  date.className = 'history-item-date'
  const dateObj = new Date(chat.timestamp)
  date.textContent = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  item.appendChild(header)
  item.appendChild(actions)
  if (firstMsg) item.appendChild(preview)
  item.appendChild(date)

  item.addEventListener('click', () => loadChatFromHistory(chat.id))

  return item
}

// Track loaded chats for infinite scroll
let loadedChats: ChatHistory[] = []
let currentHistoryOffset = 0
let isLoadingMoreHistory = false
let hasMoreHistory = true

async function showHistoryPanel() {
  if (ENABLE_PERF_PROFILING) performance.mark('showHistoryPanel-start')

  try {
    if (!historyPanel) {
      console.error('showHistoryPanel: historyPanel element not found')
      return
    }

    if (!historyList) {
      console.error('showHistoryPanel: historyList element not found')
      return
    }

    // Reset state when opening panel
    loadedChats = []
    currentHistoryOffset = 0
    hasMoreHistory = true
    historyList.innerHTML = ''

    // Load initial batch
    await loadMoreHistoryItems()

    if (ENABLE_PERF_PROFILING) {
      performance.mark('showHistoryPanel-end')
      performance.measure('showHistoryPanel', 'showHistoryPanel-start', 'showHistoryPanel-end')
    }

    // Remember current window height before showing history panel
    previousChatHeight = lastResizeHeight || (document.getElementById('input-container')?.offsetHeight || 44)

    historyPanel.style.display = 'flex'
    historyPanel.style.visibility = 'visible'

    // Setup scroll listener for infinite scroll
    setupHistoryScrollListener()

    // Resize window to fit history content
    requestAnimationFrame(() => {
      resizeWindowToContent(true)
    })
  } catch (error) {
    console.error('showHistoryPanel error:', error)
  }
}

async function loadMoreHistoryItems() {
  if (isLoadingMoreHistory || !hasMoreHistory || !historyList) return

  isLoadingMoreHistory = true

  try {
    const BATCH_SIZE = 20
    const result = await window.electronAPI.getHistory(BATCH_SIZE, currentHistoryOffset)

    if (!result.ok || !result.chats || result.chats.length === 0) {
      hasMoreHistory = false

      // Show empty state if no chats at all
      if (currentHistoryOffset === 0) {
        historyList.innerHTML = '<div class="history-empty">No chat history yet</div>'
      }

      isLoadingMoreHistory = false
      return
    }

    const newChats = result.chats
    loadedChats = [...loadedChats, ...newChats]
    currentHistoryOffset += newChats.length

    // Check if we got fewer items than requested (means we're at the end)
    if (newChats.length < BATCH_SIZE) {
      hasMoreHistory = false
    }

    // Render the new batch
    newChats.forEach(chat => {
      const item = createHistoryItem(chat)
      historyList.appendChild(item)
    })

    // Add loading indicator if there are more items
    const existingLoader = historyList.querySelector('.history-loader')
    if (existingLoader) {
      existingLoader.remove()
    }

    if (hasMoreHistory) {
      const loader = document.createElement('div')
      loader.className = 'history-loader'
      loader.style.padding = '16px'
      loader.style.textAlign = 'center'
      loader.style.color = 'var(--text-secondary)'
      loader.style.fontSize = '12px'
      loader.textContent = 'Scroll for more...'
      historyList.appendChild(loader)
    }

    // Resize window to fit updated history list
    requestAnimationFrame(() => {
      resizeWindowToContent(true)
    })

  } catch (error) {
    console.error('loadMoreHistoryItems error:', error)
    hasMoreHistory = false
  } finally {
    isLoadingMoreHistory = false
  }
}

function setupHistoryScrollListener() {
  if (!historyList) return

  // Remove existing listener if any
  const oldListener = (historyList as any).__scrollListener
  if (oldListener) {
    historyList.removeEventListener('scroll', oldListener)
  }

  const scrollListener = () => {
    if (!historyList || !hasMoreHistory || isLoadingMoreHistory) return

    const scrollTop = historyList.scrollTop
    const scrollHeight = historyList.scrollHeight
    const clientHeight = historyList.clientHeight

    // Load more when scrolled to within 100px of bottom
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      loadMoreHistoryItems()
    }
  }

  // Store listener reference for cleanup
  (historyList as any).__scrollListener = scrollListener
  historyList.addEventListener('scroll', scrollListener)
}

function hideHistoryPanel(skipResize = false) {
  historyPanel.style.display = 'none'
  historyPanel.style.visibility = 'hidden'

  // Always resize to fit the actual content (chat)
  if (!skipResize) {
    requestAnimationFrame(() => {
      previousChatHeight = null
      lastResizeHeight = 0
      resizeWindowToContent(true)

      // Double check
      setTimeout(() => {
        resizeWindowToContent(true)
      }, 50)
    })
  }
}



function addMessage(role: 'user' | 'assistant' | 'system', content: string, extra: Partial<Message> = {}): Message {
  const message = { role, content, timestamp: Date.now(), ...extra }
  messages.push(message)

  // Generate chat ID on first message if not exists
  if (!currentChatId && messages.length === 1) {
    currentChatId = generateChatId()
  }

  // Auto-save to history after assistant responses
  if (role === 'assistant') {
    saveCurrentChatToHistory().catch(e => console.error('Failed to save chat history:', e))
  }

  saveState()
  renderMessages()
  return message
}

let isStreaming = false
let lastResizeHeight = 0
let resizeRAF: number | null = null
let scrollRAF: number | null = null
const RESIZE_THRESHOLD = 0 // Resize immediately on any height change
const RESIZE_THROTTLE_MS = 16 // 1 frame throttle max
let userHasScrolled = false // Track if user has manually scrolled
// Track the chat window height before opening history so we can restore it
let previousChatHeight: number | null = null
// Cache for rendered markdown to avoid re-parsing
const markdownCache = new Map<string, string>()
let lastRenderedMessageCount = 0 // Track if we need full re-render
// ResizeObserver for efficient resize detection
let resizeObserver: ResizeObserver | null = null
// Debounced resize with max call rate
let resizeDebounceTimer: number | null = null
const RESIZE_DEBOUNCE_MS = 16 // Max resize calls per 16ms (approx 60fps)
let resizeDelayTimer: number | null = null
type ScrollDirection = 'top' | 'bottom'
let pendingScrollDirection: ScrollDirection | null = null

function updateNewChatButtonVisibility() {
  // Show new chat button only if there are messages
  if (messages.length > 0) {
    newChatBtn.style.display = 'flex'
  } else {
    newChatBtn.style.display = 'none'
  }
}

// Performance profiling flag (set to false after profiling)
const ENABLE_PERF_PROFILING = false

// KaTeX readiness helper - waits for renderMathInElement to be available
async function waitForKaTeX(timeout = 5000): Promise<boolean> {
  // If already available, return immediately
  if (typeof (window as any).renderMathInElement === 'function') {
    return true
  }

  // Poll for KaTeX availability
  return new Promise((resolve) => {
    const startTime = Date.now()
    const checkInterval = 50 // Check every 50ms

    const checkKaTeX = () => {
      if (typeof (window as any).renderMathInElement === 'function') {
        resolve(true)
        return
      }

      // Timeout after specified duration
      if (Date.now() - startTime > timeout) {
        console.warn('KaTeX not available after timeout, math rendering may be delayed')
        resolve(false)
        return
      }

      // Continue polling
      setTimeout(checkKaTeX, checkInterval)
    }

    checkKaTeX()
  })
}

// Render KaTeX math in an element (with retry if needed)
async function renderKaTeXMath(element: HTMLElement) {
  const isReady = await waitForKaTeX()
  if (!isReady) {
    // Retry once more after a short delay
    setTimeout(() => {
      if (typeof (window as any).renderMathInElement === 'function') {
        try {
          (window as any).renderMathInElement(element, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '\\[', right: '\\]', display: true },
              { left: '$', right: '$', display: false },
              { left: '\\(', right: '\\)', display: false }
            ],
            throwOnError: false
          })
        } catch (e) {
          console.error('KaTeX rendering error:', e)
        }
      }
    }, 500)
    return
  }

  try {
    (window as any).renderMathInElement(element, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    })
  } catch (e) {
    console.error('KaTeX rendering error:', e)
  }
}

function renderMessages() {
  if (ENABLE_PERF_PROFILING) performance.mark('renderMessages-start')

  // Use DocumentFragment for better performance - batch DOM updates
  const fragment = document.createDocumentFragment()

  // Check if we can do incremental render (only new messages)
  const shouldFullRender = messages.length !== lastRenderedMessageCount

  if (shouldFullRender) {
    chatContainer.innerHTML = ''
    lastRenderedMessageCount = messages.length
  }

  // Render messages in reverse order so newest appears at top
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (document.body.classList.contains('chat-overlay-minimal') && msg.role === 'user') {
      continue
    }
    const div = document.createElement('div')
    div.className = `message ${msg.role}`

    // Render markdown for assistant messages with caching
    if (msg.role === 'assistant') {
      try {
        const cacheKey = `${msg.timestamp}-${msg.content}`
        let rendered = markdownCache.get(cacheKey)
        let mathExpressions: MathPlaceholder[] | null = null

        if (!rendered) {
          // Protect math expressions before markdown parsing
          const protectionResult = protectMathExpressions(msg.content)
          mathExpressions = protectionResult.mathExpressions
          // Parse markdown
          const markdownHtml = marked.parse(protectionResult.protectedText) as string
          // Restore math expressions after markdown parsing
          rendered = restoreMathExpressions(markdownHtml, mathExpressions)

          // Sanitize HTML to prevent XSS
          rendered = DOMPurify.sanitize(rendered, {
            ADD_TAGS: ['img', 'code', 'pre', 'span', 'div', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'a', 'b', 'i', 'strong', 'em', 'del', 'sup', 'sub'],
            ADD_ATTR: ['class', 'id', 'src', 'href', 'target', 'rel', 'alt', 'title', 'width', 'height', 'style']
          })

          markdownCache.set(cacheKey, rendered)
            // Also cache math expressions for this message
            ; (div as any).__mathExpressions = mathExpressions
          // Limit cache size to prevent memory bloat
          if (markdownCache.size > 100) {
            const firstKey = markdownCache.keys().next().value
            markdownCache.delete(firstKey)
          }
        } else {
          // Try to get cached math expressions
          mathExpressions = (div as any).__mathExpressions || null
        }

        div.innerHTML = rendered

        // Final check: if placeholders are still present in the HTML, restore them directly
        if (mathExpressions && mathExpressions.length > 0) {
          const htmlContent = div.innerHTML
          if (htmlContent.includes('MATHPLACEHOLDER_')) {
            // Restore any remaining placeholders
            let finalHtml = htmlContent
            mathExpressions.forEach(math => {
              const escapedId = math.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              finalHtml = finalHtml.replace(new RegExp(escapedId, 'g'), math.content)
            })
            div.innerHTML = DOMPurify.sanitize(finalHtml, {
              ADD_TAGS: ['img', 'code', 'pre', 'span', 'div', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'a', 'b', 'i', 'strong', 'em', 'del', 'sup', 'sub'],
              ADD_ATTR: ['class', 'id', 'src', 'href', 'target', 'rel', 'alt', 'title', 'width', 'height', 'style']
            })
          }
        }

        // Render KaTeX math expressions after markdown is rendered
        // Use async helper to wait for KaTeX if needed
        renderKaTeXMath(div).catch((e) => {
          console.error('KaTeX rendering failed:', e)
        })
      } catch (e) {
        // Fallback to plain text if markdown parsing fails
        div.textContent = msg.content
      }
    } else {
      div.textContent = msg.content
    }

    // Add screenshots to user messages
    if (msg.role === 'user' && (msg as any).screenshots && (msg as any).screenshots.length > 0) {
      const screenshotContainer = document.createElement('div')
      screenshotContainer.className = 'screenshot-in-message'
        ; (msg as any).screenshots.forEach((screenshot: any) => {
          const img = document.createElement('img')
          // Use base64 data if available (for persisted chats), otherwise use file path
          if (screenshot.base64Data) {
            img.src = `data:image/png;base64,${screenshot.base64Data}`
          } else if (screenshot.filePath) {
            img.src = `file://${screenshot.filePath}`
          }
          img.alt = 'Screenshot'
          img.onclick = () => enlargeImage(img.src)
          screenshotContainer.appendChild(img)
        })
      div.appendChild(screenshotContainer)
    }

    if (msg.role === 'user' && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const attachmentContainer = document.createElement('div')
      attachmentContainer.className = 'message-attachments'

      msg.attachments.forEach((attachment) => {
        const chip = document.createElement('div')
        chip.className = `message-attachment-chip${attachment.blocked ? ' blocked' : ''}`
        chip.innerHTML = `
          <svg class="message-attachment-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
            ${getAttachmentIconMarkup(attachment)}
          </svg>
          <span class="message-attachment-name">${escapeHtml(attachment.name)}</span>
        `
        chip.title = attachment.warnings.length > 0 ? attachment.warnings.join('\n') : attachment.name
        attachmentContainer.appendChild(chip)
      })

      div.appendChild(attachmentContainer)
    }

    fragment.appendChild(div)
  }

  if (shouldFullRender) {
    chatContainer.appendChild(fragment)
  }

  // Attach scroll listeners to code blocks for showing scrollbar on scroll
  attachCodeBlockScrollListeners()

  updateNewChatButtonVisibility()
  scrollToTop()
  // Always resize smoothly, even when streaming
  smoothResize(true)

  if (ENABLE_PERF_PROFILING) {
    performance.mark('renderMessages-end')
    performance.measure('renderMessages', 'renderMessages-start', 'renderMessages-end')
  }
}

// Attach scroll listeners to code blocks to show scrollbar when scrolling
function attachCodeBlockScrollListeners(container?: HTMLElement) {
  const targetContainer = container || chatContainer
  const codeBlocks = targetContainer.querySelectorAll('pre code.hljs') as NodeListOf<HTMLElement>

  codeBlocks.forEach((codeBlock) => {
    const preElement = codeBlock.parentElement as HTMLElement
    if (!preElement || preElement.hasAttribute('data-scroll-listener')) return

    // Mark as having listener attached
    preElement.setAttribute('data-scroll-listener', 'true')

    let scrollTimeout: number | null = null

    const handleScroll = () => {
      // Add class to show scrollbar
      preElement.classList.add('scrolling')

      // Clear existing timeout
      if (scrollTimeout) clearTimeout(scrollTimeout)

      // Remove class after scrolling stops (200ms delay)
      scrollTimeout = window.setTimeout(() => {
        preElement.classList.remove('scrolling')
      }, 200)
    }

    preElement.addEventListener('scroll', handleScroll, { passive: true })
  })
}

function getChatContentHeight(): number {
  if (!chatContainer || chatContainer.children.length === 0) return 0

  // Calculate height based on children to avoid container stretching issues
  // This fixes the bug where the window stays large after viewing history
  let contentHeight = 0
  const children = Array.from(chatContainer.children) as HTMLElement[]

  children.forEach(child => {
    contentHeight += child.offsetHeight
  })

  // Add gaps (16px)
  if (children.length > 1) {
    contentHeight += (children.length - 1) * 16
  }

  // Add padding (top 0 + bottom 10)
  contentHeight += 10

  return contentHeight
}

function getHistoryContentHeight(): number {
  if (!historyList || !historyPanel) return 0

  const header = historyPanel.querySelector('.history-header') as HTMLElement
  const headerHeight = header ? header.offsetHeight : 0

  let listHeight = 0
  const children = Array.from(historyList.children) as HTMLElement[]

  children.forEach(child => {
    listHeight += child.offsetHeight
  })

  // Add gaps (4px)
  if (children.length > 1) {
    listHeight += (children.length - 1) * 4
  }

  // Add history-list padding (8px top + 8px bottom)
  listHeight += 16

  return headerHeight + listHeight
}

function resizeWindowToContent(force = false) {
  let targetHeight = 0

  const isHistoryVisible = historyPanel && historyPanel.style.display !== 'none'

  if (isHistoryVisible) {
    const historyHeight = getHistoryContentHeight()
    // min 200 to keep it looking decent, max 600
    targetHeight = Math.max(200, Math.min(historyHeight, 600))

    // Update at-max-height class for history list
    if (historyList) {
      if (historyHeight >= 600) {
        historyList.classList.add('at-max-height')
      } else {
        historyList.classList.remove('at-max-height')
      }
    }
  } else {
    const inputHeight = document.getElementById('input-container')?.offsetHeight || 44
    const chatHeight = getChatContentHeight()
    const totalHeight = chatContainer && chatContainer.children.length > 0 ? inputHeight + chatHeight : inputHeight
    targetHeight = Math.max(inputHeight, Math.min(totalHeight, 600))

    // Update at-max-height class based on total content height vs cap
    if (chatContainer) {
      if (totalHeight >= 600) {
        chatContainer.classList.add('at-max-height')
      } else {
        chatContainer.classList.remove('at-max-height')
      }
    }
  }

  // Only resize if height changed significantly to avoid jank, unless forced
  if (force || Math.abs(targetHeight - lastResizeHeight) > RESIZE_THRESHOLD) {
    lastResizeHeight = targetHeight

    // If forced, resize immediately without debounce
    if (force) {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer)
      resizeDebounceTimer = null
      window.electronAPI.chatResize(targetHeight).catch(() => { })
      return
    }

    // Debounce resize calls to prevent excessive IPC
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer)
    }
    resizeDebounceTimer = window.setTimeout(() => {
      window.electronAPI.chatResize(targetHeight).catch(() => { })
      resizeDebounceTimer = null
    }, RESIZE_DEBOUNCE_MS)
  }
}

function smoothResize(force = false) {
  // If streaming or forced, resize immediately (queued next frame)
  if (force || isStreaming) {
    if (resizeDelayTimer) {
      clearTimeout(resizeDelayTimer)
      resizeDelayTimer = null
    }
    queueResizeRAF()
    return
  }

  if (resizeDelayTimer) return

  resizeDelayTimer = window.setTimeout(() => {
    resizeDelayTimer = null
    queueResizeRAF()
  }, RESIZE_THROTTLE_MS)
}

function queueResizeRAF() {
  if (resizeRAF) return

  if (ENABLE_PERF_PROFILING) performance.mark('smoothResize-start')

  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = null
    resizeWindowToContent()
    if (ENABLE_PERF_PROFILING) {
      performance.mark('smoothResize-end')
      performance.measure('smoothResize', 'smoothResize-start', 'smoothResize-end')
    }
  })
}

// Initialize ResizeObserver for chat container
function initResizeObserver() {
  if (typeof ResizeObserver === 'undefined' || !chatContainer) return

  resizeObserver = new ResizeObserver((entries) => {
    // Only trigger resize if not streaming or if forced
    if (!isStreaming) {
      smoothResize()
    }
  })

  resizeObserver.observe(chatContainer)

  // Also observe input container for height changes
  const inputContainer = document.getElementById('input-container')
  if (inputContainer) {
    resizeObserver.observe(inputContainer)
  }
}

function scrollToBottom() {
  scheduleScroll('bottom')
}

function scrollToTop() {
  scheduleScroll('top')
}

function scheduleScroll(direction: ScrollDirection) {
  if (direction === 'top' && isStreaming && userHasScrolled) return

  if (direction === 'top') {
    pendingScrollDirection = 'top'
  } else if (pendingScrollDirection !== 'top') {
    pendingScrollDirection = 'bottom'
  }

  if (scrollRAF) return

  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = null
    if (!pendingScrollDirection) return
    if (pendingScrollDirection === 'top') {
      chatContainer.scrollTop = 0
    } else {
      chatContainer.scrollTop = chatContainer.scrollHeight
    }
    pendingScrollDirection = null
  })
}

function showTypingIndicator() {
  isStreaming = true
  const div = document.createElement('div')
  div.className = 'typing-indicator'
  div.id = 'typing-indicator'
  div.innerHTML = '<span></span><span></span><span></span>'
  // Insert at the beginning so it appears at top
  chatContainer.insertBefore(div, chatContainer.firstChild)
  // Keep scroll at top
  scrollToTop()
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typing-indicator')
  if (indicator) indicator.remove()
  isStreaming = false
}

// Token batching for smooth streaming
let tokenBuffer = ''
let tokenFlushTimer: any = null
const TOKEN_FLUSH_DELAY = 0 // Render immediately for fluid word-by-word streaming

function appendStreamingText(text: string) {
  if (ENABLE_PERF_PROFILING) performance.mark('appendStreamingText-start')

  isStreaming = true
  if (text.trim()) {
    hasStreamingActivity = true
  }
  tokenBuffer += text

  if (tokenFlushTimer) clearTimeout(tokenFlushTimer)

  tokenFlushTimer = setTimeout(() => {
    flushTokenBuffer()
    if (ENABLE_PERF_PROFILING) {
      performance.mark('appendStreamingText-end')
      performance.measure('appendStreamingText', 'appendStreamingText-start', 'appendStreamingText-end')
    }
  }, TOKEN_FLUSH_DELAY)
}

function flushTokenBuffer() {
  if (!tokenBuffer) return

  // Remove typing indicator as soon as we have content to show
  const indicator = document.getElementById('typing-indicator')
  if (indicator) indicator.remove()

  let streamDiv = document.getElementById('streaming-response') as HTMLDivElement | null
  if (!streamDiv) {
    streamDiv = document.createElement('div')
    streamDiv.id = 'streaming-response'
    streamDiv.className = 'message assistant'
    // Insert at the beginning so it appears at top and grows downward
    chatContainer.insertBefore(streamDiv, chatContainer.firstChild)
  }

  // Accumulate text content
  const currentText = (streamDiv as any).__rawText || ''
  const newText = currentText + tokenBuffer
    ; (streamDiv as any).__rawText = newText
  tokenBuffer = ''

  // Render as markdown if available (with caching for performance)
  try {
    // Cache markdown rendering for streaming content
    const cacheKey = `stream-${newText}`
    let rendered = markdownCache.get(cacheKey)
    let mathExpressions: MathPlaceholder[] | null = null

    if (!rendered) {
      // Protect math expressions before markdown parsing
      const protectionResult = protectMathExpressions(newText)
      mathExpressions = protectionResult.mathExpressions
      // Parse markdown
      const markdownHtml = marked.parse(protectionResult.protectedText) as string
      // Restore math expressions after markdown parsing
      rendered = restoreMathExpressions(markdownHtml, mathExpressions)
      markdownCache.set(cacheKey, rendered)
      // Limit cache size
      if (markdownCache.size > 100) {
        const firstKey = markdownCache.keys().next().value
        markdownCache.delete(firstKey)
      }
    }

    streamDiv.innerHTML = DOMPurify.sanitize(rendered)

    // Final check: if placeholders are still present in the HTML, restore them directly
    if (mathExpressions && mathExpressions.length > 0) {
      const htmlContent = streamDiv.innerHTML
      if (htmlContent.includes('MATHPLACEHOLDER_')) {
        // Restore any remaining placeholders
        let finalHtml = htmlContent
        mathExpressions.forEach(math => {
          const escapedId = math.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          finalHtml = finalHtml.replace(new RegExp(escapedId, 'g'), math.content)
        })
        streamDiv.innerHTML = DOMPurify.sanitize(finalHtml)
      }
    }

    // Render KaTeX math expressions after markdown is rendered
    // Use async helper to wait for KaTeX if needed
    renderKaTeXMath(streamDiv).catch((e) => {
      console.error('KaTeX rendering failed in streaming:', e)
    })
    // Attach scroll listeners to newly rendered code blocks
    attachCodeBlockScrollListeners(streamDiv)
  } catch (e) {
    // Fallback to plain text
    streamDiv.textContent = newText
  }

  // Don't scroll during streaming - let user see content grow from top
  // Force resize immediately for fast updates
  smoothResize(true)
}

function finalizeStreamingResponse() {
  // Flush any remaining tokens
  if (tokenFlushTimer) {
    clearTimeout(tokenFlushTimer)
    tokenFlushTimer = null
  }
  if (tokenBuffer) {
    flushTokenBuffer()
  }

  const streamDiv = document.getElementById('streaming-response')
  if (streamDiv) {
    const finalText = (streamDiv as any).__rawText || streamDiv.textContent || ''
    streamDiv.remove()
    if (finalText.trim()) {
      addMessage('assistant', finalText.trim())
    }
  }
  isStreaming = false
  tokenBuffer = ''
  hasStreamingActivity = false

  // Final resize after streaming completes
  requestAnimationFrame(() => {
    resizeWindowToContent()
  })
}

function cancelStreamingResponse() {
  if (tokenFlushTimer) {
    clearTimeout(tokenFlushTimer)
    tokenFlushTimer = null
  }
  tokenBuffer = ''
  hasStreamingActivity = false

  const indicator = document.getElementById('typing-indicator')
  if (indicator) indicator.remove()

  const streamDiv = document.getElementById('streaming-response')
  if (streamDiv) streamDiv.remove()

  isStreaming = false
}

function removePendingUserMessage() {
  if (!pendingUserMessageTimestamp) return
  const idx = [...messages].reverse().findIndex(m => m.role === 'user' && m.timestamp === pendingUserMessageTimestamp)
  if (idx === -1) {
    pendingUserMessageTimestamp = null
    return
  }
  const realIdx = messages.length - 1 - idx
  messages.splice(realIdx, 1)
  pendingUserMessageTimestamp = null
  saveState()
  renderMessages()
}

async function sendMessage() {
  if (!sendBtn) return
  if (isGenerating) return

  const rawText = chatInput.value
  draftNoteMentions = pruneDraftNoteMentions(rawText, draftNoteMentions)
  const selectedNoteMentions = extractNoteMentionsFromText(rawText, draftNoteMentions)
  const text = rawText.trim()
  const hasScreenshots = attachedScreenshots.length > 0
  const readyAttachedFiles = getReadyAttachments(attachedFiles)
  const blockedAttachedFiles = attachedFiles.filter((attachment) => attachment.blocked)
  const hasFiles = readyAttachedFiles.length > 0

  if (!text && !hasScreenshots && !hasFiles) return

  if (isGenerating) return

  const requestVersion = ++chatRequestVersion
  isGenerating = true
  isCancelRequested = false
  hasStreamingActivity = false
  updateSendButtonState()

  // Store screenshots and files with the message
  const messageScreenshots = [...attachedScreenshots]
  const messageFiles = [...readyAttachedFiles]
  attachedScreenshots = []
  attachedFiles = [...blockedAttachedFiles]
  renderScreenshots()
  renderAttachedFiles()

  // Convert screenshots to base64 for API
  let screenshotDataUrls: string[] = []
  if (messageScreenshots.length > 0) {
    try {
      for (const screenshot of messageScreenshots) {
        // Check if already has base64 data (dropped images)
        if ((screenshot as any).base64Data) {
          screenshotDataUrls.push(`data:image/png;base64,${(screenshot as any).base64Data}`)
        } else {
          // Fetch from file system (captured screenshots)
          const result = await window.electronAPI.screenshotGetBase64(screenshot.id)
          if (result.ok && result.base64) {
            screenshotDataUrls.push(`data:image/png;base64,${result.base64}`)
          }
        }
      }
    } catch (err) {
      console.error('Failed to load screenshot data:', err)
    }
  }

  if (requestVersion !== chatRequestVersion) return
  const pendingUserMessage = addMessage('user', text, selectedNoteMentions.length > 0 ? {
    noteMentions: selectedNoteMentions
  } : {})
  pendingUserMessageTimestamp = pendingUserMessage.timestamp
  // Attach screenshots and files to the last user message
  if (messages.length > 0) {
    if (messageScreenshots.length > 0) {
      (messages[messages.length - 1] as any).screenshots = messageScreenshots;
      (messages[messages.length - 1] as any).screenshotDataUrls = screenshotDataUrls
    }
    if (messageFiles.length > 0) {
      ; (messages[messages.length - 1] as any).attachments = messageFiles
    }
  }

  chatInput.value = ''
  chatInput.style.height = 'auto'
  draftNoteMentions = []
  hideNoteMentionList()
  updateSendButtonState()
  // Reset scroll flag for new message
  userHasScrolled = false

  // Scroll to top immediately when user sends message
  // This way the streaming response will appear at the top and grow downward
  scrollToTop()

  showTypingIndicator()

  try {
    // Set up streaming listeners
    let streamingText = ''
    let streamTerminalHandled = false

    // Ensure we never have multiple active stream listeners.
    if (activeStreamUnsub) {
      try { activeStreamUnsub.chunk?.() } catch { }
      try { activeStreamUnsub.done?.() } catch { }
      try { activeStreamUnsub.error?.() } catch { }
      activeStreamUnsub = null
    }

    const cleanupChunk = window.chat.onStreamChunk((chunk: string) => {
      // Check for cancel request
      if (isCancelRequested || requestVersion !== chatRequestVersion) {
        return // Skip adding more content
      }
      // Note: hideTypingIndicator() is now called in flushTokenBuffer 
      // when the first real tokens are rendered to avoid the "empty output" flash
      appendStreamingText(chunk)
      streamingText += chunk
    })

    const cleanupDone = window.chat.onStreamDone(() => {
      if (requestVersion !== chatRequestVersion) return
      streamTerminalHandled = true
      isGenerating = false
      pendingUserMessageTimestamp = null
      updateSendButtonState()
      finalizeStreamingResponse()
      cleanupChunk()
      cleanupDone()
      cleanupError()
      activeStreamUnsub = null
    })

    const cleanupError = window.chat.onStreamError((error: string) => {
      if (requestVersion !== chatRequestVersion) return
      streamTerminalHandled = true
      isGenerating = false
      pendingUserMessageTimestamp = null
      updateSendButtonState()
      hideTypingIndicator()
      finalizeStreamingResponse()
      addMessage('system', `Error: ${error}`)
      scrollToBottom()
      cleanupChunk()
      cleanupDone()
      cleanupError()
      activeStreamUnsub = null
    })

    activeStreamUnsub = { chunk: cleanupChunk, done: cleanupDone, error: cleanupError }

    // Renderer-only system messages should never be forwarded as chat history.
    const messagesToSend = messages
      .filter(m => m.role !== 'system')
      .map((message) => ({
        ...message,
        content: message.role === 'user'
          ? replaceMentionTokensForSend(message.content, message.noteMentions || [])
          : message.content
      }))

    if (requestVersion !== chatRequestVersion) return
    if (!isGenerating || isCancelRequested) {
      cleanupChunk()
      cleanupDone()
      cleanupError()
      activeStreamUnsub = null
      pendingUserMessageTimestamp = null
      updateSendButtonState()
      return
    }

    // The main process adds the system prompt and picks the configured model.
    const response = await window.electronAPI.chatSend({
      messages: messagesToSend,
      manualNoteIds: collectManualNoteIdsFromMessages(messagesToSend as Array<{ role?: string; noteMentions?: NoteMention[] }>)
    } as any)

    if (requestVersion !== chatRequestVersion || streamTerminalHandled) return
    hideTypingIndicator()

    // Handle non-streaming fallback (if streaming was disabled or failed)
    if (response.ok && response.text && !response.streaming) {
      isGenerating = false
      pendingUserMessageTimestamp = null
      updateSendButtonState()
      cleanupChunk()
      cleanupDone()
      cleanupError()
      addMessage('assistant', response.text)
      scrollToBottom()
    } else if (!response.ok && !response.streaming) {
      isGenerating = false
      pendingUserMessageTimestamp = null
      updateSendButtonState()
      cleanupChunk()
      cleanupDone()
      cleanupError()
      const errorMsg = response.message || 'Failed to get response'
      // A missing provider/key is a setup step, not an error.
      addMessage('system', (response as any).needsSetup ? errorMsg : `Error: ${errorMsg}`)
      scrollToBottom()
    }
  } catch (e: any) {
    if (requestVersion !== chatRequestVersion) return
    isGenerating = false
    isCancelRequested = false
    pendingUserMessageTimestamp = null
    updateSendButtonState()
    hideTypingIndicator()
    addMessage('system', `Error: ${e?.message || 'Network error'}`)
    scrollToBottom()
  } finally {
    if (requestVersion === chatRequestVersion) updateSendButtonState()
    if (document.hasFocus()) {
      chatInput.focus()
    }
  }
}

// Auto-resize textarea (better expansion for visibility) with RAF-based updates
let textareaResizeRAF: number | null = null
let lastInputHeight = 0
chatInput.addEventListener('input', () => {
  draftNoteMentions = pruneDraftNoteMentions(chatInput.value, draftNoteMentions)
  updateNoteMentionList()
  // Use RAF for immediate visual update, but batch resize calls
  if (textareaResizeRAF) {
    cancelAnimationFrame(textareaResizeRAF)
  }

  textareaResizeRAF = requestAnimationFrame(() => {
    textareaResizeRAF = null
    chatInput.style.height = 'auto'
    const newHeight = Math.min(chatInput.scrollHeight, 150) // Max 150px for better visibility
    chatInput.style.height = newHeight + 'px'

    // Only show scrollbar when content exceeds max height
    if (chatInput.scrollHeight > 150) {
      chatInput.classList.add('scrollable')
    } else {
      chatInput.classList.remove('scrollable')
    }

    // Only trigger resize if height actually changed significantly
    if (Math.abs(newHeight - lastInputHeight) > 10) {
      lastInputHeight = newHeight
      // Use smoothResize which already has debouncing
      smoothResize()
    }
    updateSendButtonState()
  })
})

// Send on Enter (Shift+Enter for new line)
if (chatInput) chatInput.addEventListener('keydown', (e) => {
  if (noteMentionList && noteMentionList.style.display !== 'none' && activeMentionOptions.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeMentionIndex = (activeMentionIndex + 1) % activeMentionOptions.length
      renderNoteMentionList()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeMentionIndex = (activeMentionIndex - 1 + activeMentionOptions.length) % activeMentionOptions.length
      renderNoteMentionList()
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault()
      const option = activeMentionOptions[activeMentionIndex]
      if (option) {
        applySelectedNoteMention(option).catch((error) => console.error('Failed to apply note mention:', error))
      }
      return
    }
  }
  if (e.key === 'Escape') {
    hideNoteMentionList()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

// Track dictation state for button icon
let isDictating = false

if (sendBtn) sendBtn.addEventListener('click', () => {
  // During generation, clicking stops it
  if (isGenerating) {
    chatRequestVersion++
    isCancelRequested = true
    // Also notify main process to stop the actual request
    window.electronAPI.chatAbort().catch(e => console.error('Failed to abort chat:', e))

    // Detach stream listeners immediately so late IPC events can't update UI.
    if (activeStreamUnsub) {
      try { activeStreamUnsub.chunk?.() } catch { }
      try { activeStreamUnsub.done?.() } catch { }
      try { activeStreamUnsub.error?.() } catch { }
      activeStreamUnsub = null
    }

    // Immediate UI feedback
    isGenerating = false
    isStreaming = false
    updateSendButtonState()
    hideTypingIndicator()
    const streamDiv = document.getElementById('streaming-response')
    const streamedText = (streamDiv as any)?.__rawText || streamDiv?.textContent || ''
    const bufferedText = tokenBuffer || ''
    const hasAnyText = hasStreamingActivity || streamedText.trim().length > 0 || bufferedText.trim().length > 0
    if (hasAnyText) {
      pendingUserMessageTimestamp = null
      finalizeStreamingResponse()
    } else {
      cancelStreamingResponse()
      removePendingUserMessage()
    }
    return
  }

  if (sendBtn.classList.contains('has-text')) {
    sendMessage()
  } else if (isDictating) {
    // Stop dictation if currently recording
    window.electronAPI.chatDictationToggle().catch(e => console.error('Failed to stop dictation:', e))
  } else {
    // Start dictation
    window.electronAPI.chatDictationToggle().catch(e => console.error('Failed to start dictation:', e))
  }
})

// Listen for dictation state events
window.chat?.onDictationStart?.(() => {
  isDictating = true
  if (sendBtn) {
    sendBtn.classList.remove('is-processing')
    sendBtn.classList.add('is-recording')
  }
})

window.chat?.onDictationStop?.(() => {
  // Dictation stopped, now processing
  if (sendBtn) {
    sendBtn.classList.remove('is-recording')
    sendBtn.classList.add('is-processing')
  }
})

window.chat?.onDictationComplete?.((text: string) => {
  isDictating = false
  if (sendBtn) {
    sendBtn.classList.remove('is-recording', 'is-processing')
  }
  // If we received transcribed text, put it in the input
  if (text && text.trim() && chatInput) {
    const currentText = chatInput.value.trim()
    chatInput.value = currentText ? `${currentText} ${text}` : text
    chatInput.dispatchEvent(new Event('input'))
    chatInput.focus()
    // Auto-resize the textarea
    chatInput.style.height = 'auto'
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px'
    updateSendButtonState()
    resizeWindowToContent(true)
  }
})

// New Chat button
if (newChatBtn) newChatBtn.addEventListener('click', () => {
  startNewChat().catch(e => console.error('Failed to start new chat:', e))
})

// History button
if (historyBtn) historyBtn.addEventListener('click', () => {
  showHistoryPanel()
})

// Close History button
if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', () => {
  hideHistoryPanel()
})

document.addEventListener('mousedown', (event) => {
  const target = event.target as Node | null
  if (!target) return
  if (noteMentionList?.contains(target) || chatInput?.contains(target)) return
  hideNoteMentionList()
})



// Attach file button removed - users can drag and drop files instead

// Track manual user scrolling during streaming
if (chatContainer) chatContainer.addEventListener('scroll', () => {
  if (isStreaming) {
    userHasScrolled = true
  }
})

// Hidden context menu actions (can be triggered via keyboard shortcuts if needed)
document.getElementById('paste-clipboard')?.addEventListener('click', async () => {
  try {
    const text = await window.electronAPI.clipboardRead()
    if (text) {
      chatInput.value = (chatInput.value + '\n\n' + text).trim()
      chatInput.dispatchEvent(new Event('input'))
    }
  } catch { }
})

document.getElementById('use-transcript')?.addEventListener('click', async () => {
  try {
    const transcript = await window.electronAPI.getLastTranscript()
    if (transcript) {
      chatInput.value = (chatInput.value + '\n\n' + transcript).trim()
      chatInput.dispatchEvent(new Event('input'))
    }
  } catch { }
})

document.getElementById('clear-chat')?.addEventListener('click', () => {
  messages = []
  attachedScreenshots = []
  draftNoteMentions = []
  hideNoteMentionList()
  renderScreenshots()
  saveState()
  renderMessages()
})

// Translucence handling
function applyTranslucence(value: number) {
  const opacity = 1 - (value / 100)
  // Set CSS variable on document root for proper reactivity
  document.documentElement.style.setProperty('--bg-opacity', String(opacity))
  localStorage.setItem('chat_translucence', String(value))
}

// Listen for translucence updates from main process
try {
  if (window.chat && typeof window.chat.onTranslucenceUpdate === 'function') {
    window.chat.onTranslucenceUpdate((value: number) => {
      applyTranslucence(value)
    })
  }
} catch (e) {
  console.error('Failed to setup translucence listener:', e)
}

// Listen for stealth theme updates from main process
try {
  if (window.chat && typeof window.chat.onStealthThemeUpdate === 'function') {
    window.chat.onStealthThemeUpdate((enabled: boolean) => {
      if (enabled) {
        document.body.classList.add('stealth-mode')
      } else {
        document.body.classList.remove('stealth-mode')
      }
    })
  }
} catch (e) {
  console.error('Failed to setup stealth theme listener:', e)
}

try {
  if (window.chat && typeof window.chat.onClickThroughUpdate === 'function') {
    window.chat.onClickThroughUpdate((enabled: boolean) => {
      clickThroughActive = !!enabled
    })
  }
} catch (e) {
  console.error('Failed to setup click-through listener:', e)
}

// Listen for transparency adjustment shortcuts (10% steps for easier control)
try {
  if (window.chat && typeof window.chat.onTransparencyIncrease === 'function') {
    window.chat.onTransparencyIncrease(() => {
      const currentOpacity = parseFloat(document.documentElement.style.getPropertyValue('--bg-opacity') || '1')
      const currentTransparency = Math.round((1 - currentOpacity) * 100)
      const newTransparency = Math.min(100, currentTransparency + 10)
      applyTranslucence(newTransparency)
      // Send to main process to update prefs
      window.electronAPI.prefsUpdate({ chatTranslucence: newTransparency }).catch(() => { })
    })
  }
  if (window.chat && typeof window.chat.onTransparencyDecrease === 'function') {
    window.chat.onTransparencyDecrease(() => {
      const currentOpacity = parseFloat(document.documentElement.style.getPropertyValue('--bg-opacity') || '1')
      const currentTransparency = Math.round((1 - currentOpacity) * 100)
      const newTransparency = Math.max(0, currentTransparency - 10)
      applyTranslucence(newTransparency)
      // Send to main process to update prefs
      window.electronAPI.prefsUpdate({ chatTranslucence: newTransparency }).catch(() => { })
    })
  }
} catch (e) {
  console.error('Failed to setup transparency shortcut listeners:', e)
}

// Load initial translucence
async function loadInitialTranslucence() {
  try {
    // Try to get from prefs first
    const prefsResult = await window.electronAPI.prefsGet()
    if (prefsResult.ok && prefsResult.prefs) {
      const prefs = prefsResult.prefs
      if (typeof prefs.chatTranslucence === 'number') {
        applyTranslucence(prefs.chatTranslucence)
      } else {
        applyTranslucence(0)
      }
      // Apply stealth theme if enabled
      if (prefs.stealthDarkTheme) {
        document.body.classList.add('stealth-mode')
      }
      clickThroughActive = !!(prefs.stealthMode && prefs.stealthClickThrough)
      applyOverlayHoverable(!!prefs.chatOverlayHoverable)
      applyOverlayMinimal(!!prefs.chatOverlayMinimal)
      applyOverlayTextCursor(!!prefs.chatOverlayTextCursor)
      return
    }

    // Fallback to localStorage
    const storedTranslucence = localStorage.getItem('chat_translucence')
    if (storedTranslucence) {
      applyTranslucence(Number(storedTranslucence))
    } else {
      applyTranslucence(0)
    }
    clickThroughActive = false
    applyOverlayHoverable(false)
    applyOverlayMinimal(false)
    applyOverlayTextCursor(false)
  } catch (e) {
    console.error('Failed to load settings:', e)
    // Ultimate fallback
    applyTranslucence(0)
    clickThroughActive = false
    applyOverlayHoverable(false)
    applyOverlayMinimal(false)
    applyOverlayTextCursor(false)
  }
}

// Fallback: Re-render math when KaTeX becomes available after initial load
function setupKaTeXFallback() {
  // Check if KaTeX is already loaded
  if (typeof (window as any).renderMathInElement === 'function') {
    return // Already loaded, no need for fallback
  }

  // Poll for KaTeX availability and re-render messages when it loads
  const checkInterval = setInterval(() => {
    if (typeof (window as any).renderMathInElement === 'function') {
      clearInterval(checkInterval)
      // Re-render all assistant messages to apply KaTeX
      if (chatContainer && messages.length > 0) {
        const assistantMessages = chatContainer.querySelectorAll('.message.assistant')
        assistantMessages.forEach((msgEl) => {
          renderKaTeXMath(msgEl as HTMLElement).catch((e) => {
            console.error('KaTeX fallback rendering error:', e)
          })
        })
      }
    }
  }, 100)

  // Stop checking after 10 seconds
  setTimeout(() => {
    clearInterval(checkInterval)
  }, 10000)
}

// Initialize - minimal, no welcome message
loadState().finally(() => {
  refreshNoteMentionOptions().catch(() => { })
})
loadInitialTranslucence()
setupKaTeXFallback()

try {
  window.electronAPI.onPrefsUpdate?.((prefs: any) => {
    if (typeof prefs?.chatOverlayHoverable === 'boolean') {
      applyOverlayHoverable(prefs.chatOverlayHoverable)
    }
    if (typeof prefs?.chatOverlayMinimal === 'boolean') {
      applyOverlayMinimal(prefs.chatOverlayMinimal)
    }
    if (typeof prefs?.chatOverlayTextCursor === 'boolean') {
      applyOverlayTextCursor(prefs.chatOverlayTextCursor)
    }
  })
} catch { }

// Initialize ResizeObserver after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initResizeObserver()
  })
} else {
  initResizeObserver()
}

// Reset zoom level to 1.0 on load (fix accidental zoom)
try {
  window.electronAPI.zoomSet(1.0).catch(() => { })
} catch { }

// Image modal for enlarging screenshots
function hideImageModal() {
  if (!imageModal || !modalImage) return
  modalImage.src = ''
  imageModal.style.display = 'none'
}

function enlargeImage(src: string) {
  if (!imageModal || !modalImage) return
  modalImage.src = src
  imageModal.style.display = 'flex'
}

if (imageModal && modalImage) {
  imageModal.addEventListener('click', (event) => {
    if (event.target === imageModal) {
      hideImageModal()
    }
  })

  modalImage.addEventListener('click', (event) => {
    event.stopPropagation()
  })
}

// Screenshot management
function renderScreenshots() {
  if (!screenshotsInline) return
  screenshotsInline.innerHTML = ''

  if (attachedScreenshots.length === 0) {
    // For removal, we want smooth resize to shrink the window
    smoothResize()
    return
  }

  attachedScreenshots.forEach((screenshot, index) => {
    const thumb = document.createElement('div')
    thumb.className = 'screenshot-thumb'

    const img = document.createElement('img')
    // Check if this is a dropped image (has base64Data) or a screenshot
    if ((screenshot as any).base64Data) {
      img.src = `data:image/png;base64,${(screenshot as any).base64Data}`
    } else {
      img.src = `file://${screenshot.filePath.replace('.png', '-preview.png')}`
    }
    img.alt = 'Screenshot'
    img.onclick = (e) => {
      e.stopPropagation()
      if ((screenshot as any).base64Data) {
        enlargeImage(`data:image/png;base64,${(screenshot as any).base64Data}`)
      } else {
        enlargeImage(`file://${screenshot.filePath}`)
      }
    }

    const removeBtn = document.createElement('button')
    removeBtn.className = 'screenshot-remove'
    removeBtn.textContent = '×'
    removeBtn.onclick = (e) => {
      e.stopPropagation()
      attachedScreenshots.splice(index, 1)
      renderScreenshots()
    }

    thumb.appendChild(img)
    thumb.appendChild(removeBtn)
    screenshotsInline.appendChild(thumb)
  })

  // Trigger instant window resize to accommodate screenshots
  // Skip animation/debounce for immediate visual feedback
  resizeWindowToContent(true)
  updateSendButtonState()
}

// Capture screenshot function
async function captureScreenshot() {
  try {
    const result = await window.electronAPI.screenshotCapture()
    if (result.ok && result.screenshot) {
      attachedScreenshots.push({
        id: result.screenshot.id,
        filePath: result.screenshot.filePath,
        timestamp: result.screenshot.timestamp
      })
      renderScreenshots()
    }
  } catch (err) {
    console.error('Failed to capture screenshot:', err)
  }
}

function mergePreparedAttachments(nextAttachments: ChatAttachment[]) {
  const merged = [...attachedFiles]
  nextAttachments.forEach((attachment) => {
    const existingIndex = merged.findIndex((current) => current.id === attachment.id || (current.storagePath && current.storagePath === attachment.storagePath))
    if (existingIndex >= 0) {
      merged[existingIndex] = attachment
    } else {
      merged.push(attachment)
    }
  })
  attachedFiles = merged
  renderAttachedFiles()
}

async function prepareAndAddAttachments(filePaths: string[]) {
  const normalizedPaths = filePaths.filter(Boolean)
  if (normalizedPaths.length === 0) return
  try {
    const result = await window.electronAPI.chatPrepareAttachments(normalizedPaths)
    if (result.ok && Array.isArray(result.attachments)) {
      mergePreparedAttachments(result.attachments)
    }
  } catch (err) {
    console.error('Failed to prepare attachments:', err)
  }
}

async function openAttachmentPicker() {
  try {
    const result = await window.electronAPI.chatOpenFilePicker()
    if (result.ok && Array.isArray(result.filePaths) && result.filePaths.length > 0) {
      await prepareAndAddAttachments(result.filePaths)
    }
  } catch (err) {
    console.error('Failed to open attachment picker:', err)
  }
}

function extractDesktopFilePaths(fileList: FileList | null | undefined): string[] {
  if (!fileList) return []
  const paths: string[] = []
  for (let index = 0; index < fileList.length; index++) {
    const candidate = fileList[index] as File & { path?: string }
    if (candidate?.path) {
      paths.push(candidate.path)
    }
  }
  return paths
}

function renderAttachedFiles() {
  if (!attachedFilesContainer) return
  attachedFilesContainer.innerHTML = ''

  if (attachedFiles.length === 0) {
    smoothResize()
    updateSendButtonState()
    return
  }

  attachedFiles.forEach((file, index) => {
    const item = document.createElement('div')
    item.className = `attached-file-item${file.blocked ? ' blocked' : ''}`

    // File icon (different for images vs documents)
    const icon = document.createElement('svg')
    icon.className = 'attached-file-icon'
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '2')
    icon.innerHTML = getAttachmentIconMarkup(file)

    // File name
    const content = document.createElement('div')
    content.className = 'attached-file-content'

    const name = document.createElement('div')
    name.className = 'attached-file-name'
    name.textContent = file.name
    name.title = file.name
    content.appendChild(name)

    if (file.warnings.length > 0) {
      const warning = document.createElement('div')
      warning.className = 'attached-file-warning'
      warning.textContent = file.warnings.join(' ')
      content.appendChild(warning)
    }

    // Remove button
    const removeBtn = document.createElement('button')
    removeBtn.className = 'attached-file-remove'
    removeBtn.textContent = '×'
    removeBtn.onclick = (e) => {
      e.stopPropagation()
      attachedFiles.splice(index, 1)
      renderAttachedFiles()
    }

    item.appendChild(icon)
    item.appendChild(content)
    item.appendChild(removeBtn)
    attachedFilesContainer.appendChild(item)
  })

  smoothResize()
  updateSendButtonState()
}

// Listen for keyboard shortcut opacity adjustments
try {
  if (typeof window.electronAPI.onOpacityAdjust === 'function') {
    window.electronAPI.onOpacityAdjust(async (delta: number) => {
      // Get current value from prefs
      const prefsResult = await window.electronAPI.prefsGet()
      const currentValue = prefsResult?.prefs?.chatTranslucence ?? 50
      const newValue = Math.max(10, Math.min(100, currentValue + delta))
      applyTranslucence(newValue)
      window.electronAPI.prefsUpdate({ chatTranslucence: newValue }).catch(() => { })
    })
    window.electronAPI.onChatShortcutSend(() => {
      sendMessage()
    })
    window.electronAPI.onChatShortcutNew(() => {
      startNewChat().catch(e => console.error('Failed to start new chat:', e))
    })
  }
} catch (e) {
  console.error('Failed to setup chat listeners:', e)
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const isMac = window.env?.platform === 'darwin'
  const isPrimaryMod = e.ctrlKey || (isMac && e.metaKey)
  const key = (e.key || '').toLowerCase()

  // Prevent Ctrl/Command zooming inside the overlay (including Ctrl+0 for reset)
  if (isPrimaryMod && (key === '+' || key === '=' || key === '-' || key === '_' || key === '0')) {
    e.preventDefault()
    e.stopPropagation()
    return false
  }

  // Send message when click-through is active
  if (isPrimaryMod && key === 'p') {
    if (clickThroughActive) {
      e.preventDefault()
      sendMessage()
    }
    return
  }

  // New chat shortcut
  if (isPrimaryMod && key === 'l') {
    e.preventDefault()
    startNewChat().catch(e => console.error('Failed to start new chat:', e))
    return
  }

  // Screenshot shortcut (Ctrl/Command+Shift+S)
  if (isPrimaryMod && e.shiftKey && key === 's') {
    e.preventDefault()
    captureScreenshot()
  }
}, { capture: true })

// Prevent mouse wheel zoom (both Ctrl and Meta keys)
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    e.stopPropagation()
    return false
  }
}, { passive: false, capture: true })

// Prevent gesture zoom on trackpad
document.addEventListener('gesturestart', (e) => {
  e.preventDefault()
  e.stopPropagation()
}, { passive: false, capture: true })

document.addEventListener('gesturechange', (e) => {
  e.preventDefault()
  e.stopPropagation()
}, { passive: false, capture: true })

document.addEventListener('gestureend', (e) => {
  e.preventDefault()
  e.stopPropagation()
}, { passive: false, capture: true })

// Drag and drop for images - attach to prompt instead of opening
const overlay = document.getElementById('overlay') as HTMLElement

attachFileBtn?.addEventListener('click', () => {
  openAttachmentPicker().catch((error) => console.error('Failed to add files:', error))
})

// Prevent default drag/drop behavior globally
document.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.stopPropagation()
})

document.addEventListener('drop', (e) => {
  e.preventDefault()
  e.stopPropagation()
})

// Handle drag events with visual feedback
overlay?.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.stopPropagation()
  overlay.style.opacity = '0.7'
})

overlay?.addEventListener('dragleave', (e) => {
  e.preventDefault()
  e.stopPropagation()
  overlay.style.opacity = '1'
})

overlay?.addEventListener('drop', async (e) => {
  e.preventDefault()
  e.stopPropagation()
  overlay.style.opacity = '1'

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  await prepareAndAddAttachments(extractDesktopFilePaths(files))
})

// Screenshot handling - listen for captures from global shortcut
try {
  if (typeof window.electronAPI.onScreenshotCaptured === 'function') {
    window.electronAPI.onScreenshotCaptured(async (screenshot: any) => {
      console.log('Screenshot captured via shortcut:', screenshot.id)
      attachedScreenshots.push({
        id: screenshot.id,
        filePath: screenshot.filePath,
        timestamp: screenshot.timestamp
      })
      renderScreenshots()
    })
  }
} catch (e) {
  console.error('Failed to setup screenshot listener:', e)
}

// Note: window.electronAPI types are defined in preload.ts
