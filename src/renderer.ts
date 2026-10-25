let currentMode: 'mic' | 'system' | 'both' = 'both'
import { marked } from 'marked'
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import {
  getNoteMentionOptions,
  type NoteMention,
  type NoteMentionOption
} from './shared/noteMentions'
import {
  hasAudiblePcm16Activity,
  hasAudibleTimeDomainActivity,
  shouldEmitAudioActivity
} from './shared/audioActivity'
import type {
  SpeakingTrainerCoaching,
  SpeakingTrainerNoteAnalysis,
  SpeakingTrainerOverview,
  SpeakingTrainerTrends
} from './shared/speakingTrainer'
import type { AiProviderInfo, AiSettings, AiSettingsSnapshot, AiTask } from './shared/aiProviders'
import type { ChatAttachment } from './shared/chatAttachments'
import { buildNoteMailto, buildNoteMarkdown, noteExportFileName } from './shared/noteExport'
import type { OnboardingWizardState, PermissionGroupId, PermissionWizardStep } from './shared/permissions'

document.body.classList.toggle('platform-macos', window.env?.platform === 'darwin')

// Zoom Prevention
document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const isPrimaryMod = e.ctrlKey || (isMac && e.metaKey)
  const key = (e.key || '').toLowerCase()
  if (document.body.classList.contains('is-recording-shortcut')) return
  if (isPrimaryMod && (key === '+' || key === '=' || key === '-' || key === '_' || key === '0')) {
    e.preventDefault(); e.stopPropagation(); return false
  }
}, { capture: true })

document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault(); e.stopPropagation(); return false
  }
}, { passive: false, capture: true })

document.addEventListener('gesturestart', (e) => { e.preventDefault(); e.stopPropagation() }, { passive: false, capture: true })
document.addEventListener('gesturechange', (e) => { e.preventDefault(); e.stopPropagation() }, { passive: false, capture: true })
document.addEventListener('gestureend', (e) => { e.preventDefault(); e.stopPropagation() }, { passive: false, capture: true })

// Type augmentation for TipTap Markdown extension
declare module '@tiptap/core' {
  interface EditorStorage {
    markdown: {
      getMarkdown: () => string
    }
  }
}

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

interface NoteListItem {
  id: string
  name: string
  preview: string
  mtime: number
  size: number
  createdAt: number
}

interface ChatPageMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  noteMentions?: NoteMention[]
  attachments?: ChatAttachment[]
  /** Note ids the answer drew on (Chat with Notes). */
  sources?: string[]
}

interface ChatHistoryItem {
  id: string
  title: string
  timestamp: number
  messages: ChatPageMessage[]
}

// Helper to escape special characters for HTML attributes
function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function isReadyAttachment(attachment: ChatAttachment | null | undefined): attachment is ChatAttachment {
  return !!attachment && !attachment.blocked
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

interface AppState {
  notes: {
    items: NoteListItem[]
  }
}

type StoreListener<T> = (state: Readonly<T>, previous: Readonly<T>) => void

function createStore<T extends Record<string, any>>(initial: T) {
  let state = { ...initial }
  const listeners = new Set<StoreListener<T>>()

  return {
    getState(): Readonly<T> {
      return state
    },
    setState(partial: Partial<T>): void {
      const previous = state
      state = { ...state, ...partial }
      listeners.forEach(listener => {
        try {
          listener(state, previous)
        } catch (error) {
          console.error('Store listener error', error)
        }
      })
    },
    subscribe(listener: StoreListener<T>): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const appStore = createStore<AppState>({
  notes: {
    items: []
  }
})

function getNotesCache(): NoteListItem[] {
  return appStore.getState().notes.items
}

function setNotesCache(items: NoteListItem[]): void {
  const current = appStore.getState().notes
  appStore.setState({ notes: { ...current, items } })
}

const ACTIVITY_PREVIEW_LENGTH = 140

function buildActivityPreview(text: string): string {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return ''
  return trimmed.length > ACTIVITY_PREVIEW_LENGTH
    ? `${trimmed.slice(0, ACTIVITY_PREVIEW_LENGTH)}...`
    : trimmed
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function renderMarkdown(md: string): string {
  // Use the marked library for full markdown support including tables
  // The marked library is already configured at the top of this file with hljs support
  try {
    const result = marked.parse(md || '') as string
    return DOMPurify.sanitize(result)
  } catch {
    // Fallback: escape HTML and preserve line breaks
    const escaped = (md || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
    return `<div class="md-fallback">${escaped}</div>`
  }
}

function stripLeadingTitles(md: string): string {
  // Strip any leading # H1 headers (one or more) including the newline(s) following them
  // This cleans up redundant titles that the AI might have included at the start of the note
  return md.replace(/^(?:\s*#\s+.*\n*)+/, '').trim();
}

function normalizeTitle(rawTitle: string): string {
  let cleaned = (rawTitle || '').trim()
  if (!cleaned) return cleaned
  // Strip common auto-prefixed labels like "Meeting Notes -"
  cleaned = cleaned.replace(/^meeting notes\s*[-:\u2013\u2014]\s*/i, '')
  cleaned = cleaned.replace(/^meeting notes\s+/i, '')
  cleaned = cleaned.replace(/\s*[-:\u2013\u2014]\s*(?:\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})(?:\s+time\s+\d{1,2}(?::\d{2})?(?:\s*\d{2})?)?\s*$/i, '')
  cleaned = cleaned.replace(/\btime\s+\d{1,2}(?::\d{2})?(?:\s*\d{2})?\s*$/i, '')
  cleaned = cleaned.replace(/\s*[-:\u2013\u2014]\s*$/i, '')
  return cleaned.trim()
}

function normalizeSummary(summaryMd: string): { summary: string; title: string | null } {
  let summary = summaryMd || ''
  let title: string | null = null
  const titleMatch = summary.match(/\n?TITLE:\s*(.+?)\s*$/i)
  if (titleMatch && titleMatch[1]) {
    const normalizedTitle = normalizeTitle(titleMatch[1].trim())
    title = normalizedTitle || null
    summary = summary.replace(/\n?TITLE:\s*.+?\s*$/i, '').trim()
  }
  summary = stripLeadingTitles(summary)
  return { summary, title }
}



// ---- Streaming (native WAV via AudioWorklet -> RT worker) ----

// Advanced streaming settings (from localStorage with defaults)
function getRtVad(): boolean { return (localStorage.getItem('rt_vad') || '0') === '1' }
function getRtBeam(): number { const n = Number(localStorage.getItem('rt_beam') || '1'); return Math.max(1, Math.min(4, isFinite(n) ? Math.floor(n) : 1)) }
function getRtChunkMs(): number { const n = Number(localStorage.getItem('rt_chunk_ms') || '500'); return Math.max(200, Math.min(2000, isFinite(n) ? Math.floor(n) : 500)) }
function getRtTailSec(): number { const n = Number(localStorage.getItem('rt_tail') || '12'); return Math.max(4, Math.min(60, isFinite(n) ? Math.floor(n) : 12)) }



// Tiny inline worklet: downsample to 16kHz PCM16 and emit ~500ms chunks
function makeWavDownsamplerURL() {
  const code = `class WavDownsampler extends AudioWorkletProcessor{constructor(options){super();this.inRate=sampleRate;this.outRate=16000;this.ratio=this.inRate/this.outRate;this.frac=0;this.pcm16=[];const ms=(options&&options.processorOptions&&options.processorOptions.chunkMs)||500;this.chunkSamples=Math.max(1,Math.floor(this.outRate*ms/1000));this.port.onmessage=(e)=>{const d=e&&e.data||{};if(d.type==='flush'){if(this.pcm16.length>0){const arr=new Int16Array(this.pcm16);this.port.postMessage({type:'pcm16',buffer:arr.buffer},[arr.buffer]);this.pcm16=[];}this.port.postMessage({type:'flushed'});}}}process(inputs){const input=inputs[0];if(!input||input.length===0){return true}const channels=input.length;const frames=input[0]?.length||0;for(let i=0;i<frames;i++){let v=0;for(let c=0;c<channels;c++){v+=input[c][i]||0}v=channels?(v/channels):v;this.frac+=1;while(this.frac>=this.ratio){this.frac-=this.ratio;let s=v;if(s>1)s=1;if(s<-1)s=-1;const i16=s<0?(s*32768):(s*32767);this.pcm16.push(i16|0);if(this.pcm16.length>=this.chunkSamples){const arr=new Int16Array(this.pcm16);this.port.postMessage({type:'pcm16',buffer:arr.buffer},[arr.buffer]);this.pcm16=[]}}}return true}}registerProcessor('wav-downsampler',WavDownsampler);`;
  const blob = new Blob([code], { type: 'application/javascript' })
  return URL.createObjectURL(blob)
}

function pcm16ToWav(samples: Int16Array, sampleRate = 16000): ArrayBuffer {
  const numChannels = 1
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  function writeStr(off: number, str: string) { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
  let off = 0
  writeStr(off, 'RIFF'); off += 4
  view.setUint32(off, 36 + dataSize, true); off += 4
  writeStr(off, 'WAVE'); off += 4
  writeStr(off, 'fmt '); off += 4
  view.setUint32(off, 16, true); off += 4 // fmt chunk size
  view.setUint16(off, 1, true); off += 2  // PCM
  view.setUint16(off, numChannels, true); off += 2
  view.setUint32(off, sampleRate, true); off += 4
  view.setUint32(off, byteRate, true); off += 4
  view.setUint16(off, blockAlign, true); off += 2
  view.setUint16(off, 16, true); off += 2 // bits per sample
  writeStr(off, 'data'); off += 4
  view.setUint32(off, dataSize, true); off += 4
  // PCM data
  const out = new Int16Array(buffer, 44, samples.length)
  out.set(samples)
  return buffer
}

window.addEventListener('DOMContentLoaded', async () => {
  // macOS: enforce permissions onboarding on startup
  try {
    if (window.env?.platform === 'darwin' && (window as any).electronAPI?.permissions?.needsOnboarding) {
      const needsOnboarding = await (window as any).electronAPI.permissions.needsOnboarding();
      if (needsOnboarding) {
        window.location.href = 'permissions.html';
        return;
      }
    }
  } catch (err) {
    console.error('[Renderer] Error checking permissions onboarding:', err);
  }

  // Initialize UI
  // Assuming initUI, loadNotes, loadChatHistory are defined elsewhere or will be added.
  // For now, these calls are commented out to avoid reference errors if they don't exist.
  // initUI()
  // Restore notes
  // loadNotes()
  // Restore chat history
  // loadChatHistory()

  const recordBtn = $('recordBtn') as HTMLButtonElement | null
  const stopBtn = $('stopBtn') as HTMLButtonElement | null
  const status = $('status') as HTMLElement | null
  const recordingControls = document.getElementById('recordingControls') as HTMLDivElement | null
  const recordingStatus = document.getElementById('recordingStatus') as HTMLDivElement | null
  const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement | null
  const notesList = $('notes-list') as HTMLElement | null
  const notesListUI = document.getElementById('notesListUI') as HTMLUListElement | null
  const meetingNotesList = document.getElementById('meetingNotesList') as HTMLUListElement | null
  const meetingNotesCount = document.getElementById('meetingNotesCount') as HTMLElement | null
  const meetingNotesSearch = document.getElementById('meetingNotesSearch') as HTMLInputElement | null
  const meetingNoteTitleEl = document.getElementById('meetingNoteTitle') as HTMLElement | null
  const meetingNoteTimestampEl = document.getElementById('meetingNoteTimestamp') as HTMLElement | null
  const meetingNoteContentEl = document.getElementById('meetingNoteContent') as HTMLElement | null

  // Note Taker Widget elements
  const noteTakerWidgetBtn = document.getElementById('noteTakerWidgetBtn') as HTMLButtonElement | null
  const noteTakerWidget = document.getElementById('noteTakerWidget') as HTMLElement | null
  const widgetRecordToggle = document.getElementById('widgetRecordToggle') as HTMLInputElement | null
  const widgetAudioMode = document.getElementById('widgetAudioMode') as HTMLSelectElement | null
  const widgetMicDevice = document.getElementById('widgetMicDevice') as HTMLSelectElement | null
  const widgetSpeakerDevice = document.getElementById('widgetSpeakerDevice') as HTMLSelectElement | null
  const notesSection = document.getElementById('notesSection') as HTMLElement | null
  const chatNotesSection = document.getElementById('chatNotesSection') as HTMLElement | null
  const speakingTrainerSection = document.getElementById('speakingTrainerSection') as HTMLElement | null
  const settingsSection = document.getElementById('settingsSection') as HTMLElement | null
  const navNotes = document.getElementById('nav-notes') as HTMLElement | null
  const navChatNotes = document.getElementById('nav-chat-notes') as HTMLElement | null
  const navSpeakingTrainer = document.getElementById('nav-speaking-trainer') as HTMLElement | null
  const navSetup = document.getElementById('nav-setup') as HTMLElement | null
  const navHome = document.getElementById('nav-home') as HTMLElement | null
  const navMeetings = document.getElementById('nav-meetings') as HTMLElement | null
  const navDict = document.getElementById('nav-dict') as HTMLElement | null

  const notePreview = document.getElementById('notePreview') as HTMLElement | null
  const noteNewBtn = document.getElementById('noteNew') as HTMLButtonElement | null
  const noteDeleteBtn = document.getElementById('noteDelete') as HTMLButtonElement | null
  const noteEditBtn = document.getElementById('noteEdit') as HTMLButtonElement | null
  const noteExportBtn = document.getElementById('noteExport') as HTMLButtonElement | null

  const speakingTrainerSelect = document.getElementById('speakingTrainerSelect') as HTMLSelectElement | null
  const speakingTrainerLoading = document.getElementById('speakingTrainerLoading') as HTMLElement | null
  const speakingTrainerEmpty = document.getElementById('speakingTrainerEmpty') as HTMLElement | null
  const speakingTrainerContent = document.getElementById('speakingTrainerContent') as HTMLElement | null
  const speakingTrainerHeadline = document.getElementById('speakingTrainerHeadline') as HTMLElement | null
  const speakingTrainerSummary = document.getElementById('speakingTrainerSummary') as HTMLElement | null
  const speakingTrainerStrengths = document.getElementById('speakingTrainerStrengths') as HTMLElement | null
  const speakingTrainerImprovements = document.getElementById('speakingTrainerImprovements') as HTMLElement | null
  const speakingTrainerDrills = document.getElementById('speakingTrainerDrills') as HTMLElement | null
  const trainerMetricFillersValue = document.getElementById('trainerMetricFillersValue') as HTMLElement | null
  const trainerMetricFillersSub = document.getElementById('trainerMetricFillersSub') as HTMLElement | null
  const trainerMetricFillersTrend = document.getElementById('trainerMetricFillersTrend') as HTMLElement | null
  const trainerMetricQuestionsValue = document.getElementById('trainerMetricQuestionsValue') as HTMLElement | null
  const trainerMetricQuestionsSub = document.getElementById('trainerMetricQuestionsSub') as HTMLElement | null
  const trainerMetricQuestionsTrend = document.getElementById('trainerMetricQuestionsTrend') as HTMLElement | null
  const trainerMetricTurnsValue = document.getElementById('trainerMetricTurnsValue') as HTMLElement | null
  const trainerMetricTurnsSub = document.getElementById('trainerMetricTurnsSub') as HTMLElement | null
  const trainerMetricTurnsTrend = document.getElementById('trainerMetricTurnsTrend') as HTMLElement | null
  const trainerMetricPaceValue = document.getElementById('trainerMetricPaceValue') as HTMLElement | null
  const trainerMetricPaceSub = document.getElementById('trainerMetricPaceSub') as HTMLElement | null
  const trainerMetricPaceTrend = document.getElementById('trainerMetricPaceTrend') as HTMLElement | null
  const SPEAKING_TRAINER_ENABLED = false

  let currentNoteId: string | null = null
  let lastSavedNoteId: string | null = null
  let lastSavedMarkdown = ''
  let currentMeetingNoteId: string | null = null
  let speakingTrainerOverview: SpeakingTrainerOverview | null = null
  let speakingTrainerCurrentNoteId: string | null = null
  let speakingTrainerAnalysisRequest = 0
  let meetingNotesDraft = ''
  let editorInstance: Editor | null = null
  let wordCountTimeout: any = null
  const activityList = document.getElementById('activityList') as HTMLElement | null
  const progressLog = $('progressLog') as HTMLElement | null
  const transcriptBox = $('transcript') as HTMLElement | null
  const captureModeSelect = (document.getElementById('captureMode') as HTMLSelectElement) || null
  // Window controls
  const winMin = document.getElementById('win-min') as HTMLButtonElement | null
  const winMax = document.getElementById('win-max') as HTMLButtonElement | null
  const winClose = document.getElementById('win-close') as HTMLButtonElement | null
  const sidebarToggle = document.getElementById('sidebarToggle') as HTMLButtonElement | null
  const settingsNavBtn = document.getElementById('settingsNavBtn') as HTMLButtonElement | null
  const prefsBtn = document.getElementById('prefsBtn') as HTMLButtonElement | null
  const prefsPanel = document.getElementById('prefsPanel') as HTMLElement | null
  const chatShortcutEl = document.getElementById('chatShortcut') as HTMLInputElement | null
  const chatShortcutRecordBtn = document.getElementById('chatShortcutRecord') as HTMLButtonElement | null
  const chatShortcutStatus = document.getElementById('chatShortcutStatus') as HTMLElement | null
  const chatTranslucenceEl = document.getElementById('chatTranslucence') as HTMLInputElement | null
  const chatTranslucenceValueEl = document.getElementById('chatTranslucenceValue') as HTMLElement | null
  const testTonesBtn = document.getElementById('testTones') as HTMLButtonElement | null
  const shareLogsBtn = document.getElementById('shareLogs') as HTMLButtonElement | null
  const personalNotesEl = document.getElementById('personalNotes') as HTMLTextAreaElement | null
  const notesSearch = document.getElementById('notesSearch') as HTMLInputElement | null
  const noteTitleEl = document.getElementById('noteTitle') as HTMLInputElement | null
  const noteSaveStatusEl = document.getElementById('noteSaveStatus') as HTMLElement | null
  const noteEditInline = document.getElementById('noteEditInline') as HTMLTextAreaElement | null
  const noteStyled = document.getElementById('noteStyled') as HTMLElement | null
  const noteEditorModal = document.getElementById('noteEditorModal') as HTMLElement | null
  const noteEditorText = document.getElementById('noteEditorText') as HTMLTextAreaElement | null
  const noteEditorPreview = document.getElementById('noteEditorPreview') as HTMLElement | null
  const noteEditorSave = document.getElementById('noteEditorSave') as HTMLButtonElement | null
  const noteEditorCancel = document.getElementById('noteEditorCancel') as HTMLButtonElement | null
  let lastSavedInline = ''
  // Setup UI
  const setupSection = document.getElementById('setupSection') as HTMLElement | null
  const setupLog = document.getElementById('setupLog') as HTMLElement | null
  const setupRunBtn = document.getElementById('setupRun') as HTMLButtonElement | null
  const setupStatus = document.getElementById('setupStatus') as HTMLElement | null
  const noteRenameBtn = document.getElementById('noteRename') as HTMLButtonElement | null
  const notesSubtree = document.getElementById('notes-subtree') as HTMLUListElement | null
  const sttLanguagePickerBtn = document.getElementById('sttLanguagePickerBtn') as HTMLButtonElement | null
  const sttLanguageSummary = document.getElementById('sttLanguageSummary') as HTMLElement | null
  const sttLanguageModal = document.getElementById('sttLanguageModal') as HTMLElement | null
  const sttLanguageClose = document.getElementById('sttLanguageClose') as HTMLButtonElement | null
  const sttLanguageSearch = document.getElementById('sttLanguageSearch') as HTMLInputElement | null
  const sttLanguageGrid = document.getElementById('sttLanguageGrid') as HTMLElement | null
  const sttLanguageCount = document.getElementById('sttLanguageCount') as HTMLElement | null
  const sttLanguageClear = document.getElementById('sttLanguageClear') as HTMLButtonElement | null
  const settingsChatTranslucenceEl = document.getElementById('settingsChatTranslucence') as HTMLInputElement | null
  const settingsChatTranslucenceValueEl = document.getElementById('settingsChatTranslucenceValue') as HTMLElement | null

  const settingsStatResetBtn = document.getElementById('settingsStatReset') as HTMLButtonElement | null
  const resetShortcutsBtn = document.getElementById('resetShortcutsBtn') as HTMLButtonElement | null
  const resetShortcutsModal = document.getElementById('resetShortcutsModal') as HTMLDivElement | null
  const resetShortcutsConfirmBtn = document.getElementById('resetShortcutsConfirmBtn') as HTMLButtonElement | null
  const resetShortcutsCancelBtn = document.getElementById('resetShortcutsCancelBtn') as HTMLButtonElement | null
  // Personalization settings controls
  const aiStyleProfessionalEl = document.getElementById('aiStyleProfessional') as HTMLInputElement | null
  const aiStyleCasualEl = document.getElementById('aiStyleCasual') as HTMLInputElement | null
  const aiStyleConciseEl = document.getElementById('aiStyleConcise') as HTMLInputElement | null
  const aiStyleCustomRadioEl = document.getElementById('aiStyleCustomRadio') as HTMLInputElement | null
  const aiStyleCustomBoxEl = document.getElementById('aiStyleCustomBox') as HTMLElement | null
  const aiStyleCustomEl = document.getElementById('aiStyleCustom') as HTMLTextAreaElement | null
  const shortcutTriggerEl = document.getElementById('shortcutTrigger') as HTMLInputElement | null
  const shortcutReplacementEl = document.getElementById('shortcutReplacement') as HTMLInputElement | null
  const addShortcutBtn = document.getElementById('addShortcut') as HTMLButtonElement | null
  const shortcutsListEl = document.getElementById('shortcutsList') as HTMLElement | null
  const templateNameEl = document.getElementById('templateName') as HTMLInputElement | null
  const addTemplateBtn = document.getElementById('addTemplate') as HTMLButtonElement | null
  const templateTextareaBoxEl = document.getElementById('templateTextareaBox') as HTMLElement | null
  const templatePromptEl = document.getElementById('templatePrompt') as HTMLTextAreaElement | null
  const saveTemplateBtn = document.getElementById('saveTemplate') as HTMLButtonElement | null
  const cancelTemplateBtn = document.getElementById('cancelTemplate') as HTMLButtonElement | null
  const templatesListEl = document.getElementById('templatesList') as HTMLElement | null
  let editingTemplate: number | null = null
  // General settings controls
  const settingsOpenAtStartupEl = document.getElementById('settingsOpenAtStartup') as HTMLInputElement | null
  const settingsMeetingNotificationsEl = document.getElementById('settingsMeetingNotifications') as HTMLInputElement | null
  const settingsDictationLanguageEl = document.getElementById('settingsDictationLanguage') as HTMLSelectElement | null
  // Stealth mode controls
  const settingsStealthModeEl = document.getElementById('settingsStealthMode') as HTMLInputElement | null
  const settingsStealthOptionsEl = document.getElementById('settingsStealthOptions') as HTMLElement | null
  const settingsStealthScreenCaptureEl = document.getElementById('settingsStealthScreenCapture') as HTMLInputElement | null
  const settingsStealthClickThroughEl = document.getElementById('settingsStealthClickThrough') as HTMLInputElement | null
  const settingsStealthDarkThemeEl = document.getElementById('settingsStealthDarkTheme') as HTMLInputElement | null
  const settingsChatOverlayHoverableEl = document.getElementById('settingsChatOverlayHoverable') as HTMLInputElement | null
  const settingsChatOverlayMinimalEl = document.getElementById('settingsChatOverlayMinimal') as HTMLInputElement | null
  const settingsChatOverlayTextCursorEl = document.getElementById('settingsChatOverlayTextCursor') as HTMLInputElement | null
  // macOS Permissions Section elements
  const permissionsSection = document.getElementById('permissionsSection') as HTMLElement | null
  const settingsMicStatus = document.getElementById('settingsMicStatus') as HTMLElement | null
  const settingsMeetingCaptureStatus = document.getElementById('settingsMeetingCaptureStatus') as HTMLElement | null
  const settingsTypingAccessStatus = document.getElementById('settingsTypingAccessStatus') as HTMLElement | null
  const settingsGlobalShortcutsStatus = document.getElementById('settingsGlobalShortcutsStatus') as HTMLElement | null
  const settingsMicBtn = document.getElementById('settingsMicBtn') as HTMLButtonElement | null
  const settingsMeetingCaptureBtn = document.getElementById('settingsMeetingCaptureBtn') as HTMLButtonElement | null
  const settingsTypingAccessBtn = document.getElementById('settingsTypingAccessBtn') as HTMLButtonElement | null
  const settingsGlobalShortcutsBtn = document.getElementById('settingsGlobalShortcutsBtn') as HTMLButtonElement | null
  const settingsMicDesc = document.getElementById('settingsMicDesc') as HTMLElement | null
  const settingsMeetingCaptureDesc = document.getElementById('settingsMeetingCaptureDesc') as HTMLElement | null
  const settingsTypingAccessDesc = document.getElementById('settingsTypingAccessDesc') as HTMLElement | null
  const settingsGlobalShortcutsDesc = document.getElementById('settingsGlobalShortcutsDesc') as HTMLElement | null
  // Chat with Notes UI elements
  const chatNotesHistoryList = document.getElementById('chatNotesHistoryList') as HTMLElement | null
  const chatNotesThread = document.getElementById('chatNotesThread') as HTMLElement | null
  const chatNotesInput = document.getElementById('chatNotesInput') as HTMLTextAreaElement | null
  const chatNotesSend = document.getElementById('chatNotesSend') as HTMLButtonElement | null
  const chatNotesNewChat = document.getElementById('chatNotesNewChat') as HTMLButtonElement | null
  const chatNotesAttachBtn = document.getElementById('chatNotesAttachBtn') as HTMLButtonElement | null
  const chatNotesAttachedFiles = document.getElementById('chatNotesAttachedFiles') as HTMLElement | null
  const chatNotesSelectionSummary = document.getElementById('chatNotesSelectionSummary') as HTMLElement | null
  const chatNotesNoteSearch = document.getElementById('chatNotesNoteSearch') as HTMLInputElement | null

  let chatNotesMessages: ChatPageMessage[] = []
  let chatNotesPendingAttachments: ChatAttachment[] = []
  let chatNotesSelectedNoteIds = new Set<string>()
  let chatNotesIsGenerating = false
  let currentView: 'home' | 'notes' | 'chat-notes' | 'speaking-trainer' | 'setup' | 'meetings' | 'settings' | 'dict' = 'home'

  function reportChatNotesComposerMessage(message: string) {
    if (chatNotesInput) {
      chatNotesInput.setCustomValidity(message)
      chatNotesInput.reportValidity()
      chatNotesInput.setCustomValidity('')
      return
    }
    alert(message)
  }

  function inferChatNotesNoteType(note: NoteListItem): string {
    return /^\d{4}-\d{2}-\d{2}\s+\d{4,6}\s*-\s*/.test(note.name) ? 'Meeting note' : 'Personal note'
  }

  function getChatNotesNoteOptions(): Array<NoteMentionOption & { typeLabel: string; createdLabel: string }> {
    const formatChatNotesDate = (ms: number): string => {
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    }
    return getNoteMentionOptions(getNotesCache()).map((option) => {
      const raw = getNotesCache().find((item) => item.id === option.noteId)
      const sortTime = Number.isFinite(raw?.createdAt) && raw?.createdAt
        ? Number(raw?.createdAt)
        : Number.isFinite(raw?.mtime) ? Number(raw?.mtime) : 0
      return {
        ...option,
        typeLabel: raw ? inferChatNotesNoteType(raw) : 'Note',
        createdLabel: sortTime ? formatChatNotesDate(sortTime) : ''
      }
    })
  }

  function renderChatNotesSelectionSummary() {
    if (!chatNotesSelectionSummary) return
    const selectedCount = chatNotesSelectedNoteIds.size
    if (selectedCount === 0) {
      chatNotesSelectionSummary.textContent = 'Notto searches all your notes. Select notes to focus on them.'
      return
    }
    chatNotesSelectionSummary.textContent = `${selectedCount} note${selectedCount === 1 ? '' : 's'} selected. Selected notes stay in context for this chat.`
  }

  function renderChatNotesNoteList() {
    if (!chatNotesHistoryList) return
    const availableNoteIds = new Set(getNotesCache().map((item) => item.id))
    chatNotesSelectedNoteIds = new Set([...chatNotesSelectedNoteIds].filter((noteId) => availableNoteIds.has(noteId)))
    const query = (chatNotesNoteSearch?.value || '').trim().toLowerCase()
    const options = getChatNotesNoteOptions().filter((option) => {
      if (!query) return true
      const haystack = `${option.label}\n${option.preview}\n${option.typeLabel}`.toLowerCase()
      return haystack.includes(query)
    })

    if (options.length === 0) {
      chatNotesHistoryList.innerHTML = '<div class="chat-notes-history-empty">No matching notes.</div>'
      renderChatNotesSelectionSummary()
      return
    }

    chatNotesHistoryList.innerHTML = options.map((option) => {
      const selected = chatNotesSelectedNoteIds.has(option.noteId)
      return `
        <button class="chat-notes-note-item${selected ? ' active' : ''}" data-note-id="${escapeHtmlAttr(option.noteId)}" type="button" aria-pressed="${selected ? 'true' : 'false'}">
          <span class="chat-notes-note-check" aria-hidden="true">${selected ? '✓' : ''}</span>
          <span class="chat-notes-note-copy">
            <span class="chat-notes-note-meta">
              <span class="chat-notes-note-title">${escapeHtml(option.label)}</span>
              <span class="chat-notes-note-type">${escapeHtml(option.typeLabel)}</span>
            </span>
            <span class="chat-notes-note-preview">${escapeHtml(option.preview || 'Empty note')}</span>
            ${option.createdLabel ? `<span class="chat-notes-note-date">${escapeHtml(option.createdLabel)}</span>` : ''}
          </span>
        </button>
      `
    }).join('')

    chatNotesHistoryList.querySelectorAll('.chat-notes-note-item').forEach((element) => {
      element.addEventListener('click', () => {
        const noteId = (element as HTMLElement).dataset.noteId
        if (!noteId) return
        toggleChatNotesSelectedNote(noteId)
      })
    })

    renderChatNotesSelectionSummary()
  }

  function toggleChatNotesSelectedNote(noteId: string) {
    if (chatNotesSelectedNoteIds.has(noteId)) {
      chatNotesSelectedNoteIds.delete(noteId)
    } else {
      chatNotesSelectedNoteIds.add(noteId)
    }

    renderChatNotesNoteList()
    renderChatNotesThread()
  }

  function renderChatNotesPendingAttachments() {
    if (!chatNotesAttachedFiles) return

    if (chatNotesPendingAttachments.length === 0) {
      chatNotesAttachedFiles.innerHTML = ''
      return
    }

    chatNotesAttachedFiles.innerHTML = chatNotesPendingAttachments.map((attachment, index) => `
      <div class="chat-notes-attached-file${attachment.blocked ? ' blocked' : ''}">
        <svg class="chat-notes-attached-file-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
          ${getAttachmentIconMarkup(attachment)}
        </svg>
        <div class="chat-notes-attached-file-content">
          <div class="chat-notes-attached-file-name">${escapeHtml(attachment.name)}</div>
          ${attachment.warnings.length > 0 ? `<div class="chat-notes-attached-file-warning">${escapeHtml(attachment.warnings.join(' '))}</div>` : ''}
        </div>
        <button class="chat-notes-attached-file-remove" data-index="${index}" type="button">×</button>
      </div>
    `).join('')

    chatNotesAttachedFiles.querySelectorAll('.chat-notes-attached-file-remove').forEach((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault()
        const index = Number((element as HTMLElement).dataset.index || '-1')
        if (index < 0) return
        chatNotesPendingAttachments.splice(index, 1)
        renderChatNotesPendingAttachments()
      })
    })
  }

  function mergeChatNotesAttachments(nextAttachments: ChatAttachment[]) {
    const merged = [...chatNotesPendingAttachments]
    nextAttachments.forEach((attachment) => {
      const existingIndex = merged.findIndex((current) => current.id === attachment.id || (current.storagePath && current.storagePath === attachment.storagePath))
      if (existingIndex >= 0) {
        merged[existingIndex] = attachment
      } else {
        merged.push(attachment)
      }
    })
    chatNotesPendingAttachments = merged
    renderChatNotesPendingAttachments()
  }

  async function prepareChatNotesAttachments(filePaths: string[]) {
    const result = await window.electronAPI.chatPrepareAttachments(filePaths)
    if (result.ok && Array.isArray(result.attachments)) {
      mergeChatNotesAttachments(result.attachments)
    }
  }

  async function openChatNotesAttachmentPicker() {
    const result = await window.electronAPI.chatOpenFilePicker()
    if (result.ok && Array.isArray(result.filePaths) && result.filePaths.length > 0) {
      await prepareChatNotesAttachments(result.filePaths)
    }
  }

  /** "2026-01-05 1430 - Weekly sync.txt" -> "Weekly sync" */
  function noteDisplayTitle(noteId: string): string {
    return noteId.replace(/\.txt$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+\d{4,6}\s*-\s*/, '')
  }

  // Clicking a cited source opens that note.
  chatNotesThread?.addEventListener('click', (event) => {
    const source = (event.target as HTMLElement).closest<HTMLElement>('.chat-notes-source')
    if (!source?.dataset.noteId) return
    setView('notes')
    void loadNoteById(source.dataset.noteId)
  })

  function renderChatNotesThread() {
    if (!chatNotesThread) return

    if (chatNotesMessages.length === 0) {
      const selectedCount = chatNotesSelectedNoteIds.size
      chatNotesThread.innerHTML = selectedCount > 0
        ? `<div class="chat-notes-empty">${selectedCount} note${selectedCount === 1 ? '' : 's'} selected. Ask a question to start a clean notes-only chat.</div>`
        : '<div class="chat-notes-empty">Ask anything about your meetings and notes. Notto finds the relevant notes, or select specific ones on the left.</div>'
      return
    }

    chatNotesThread.innerHTML = chatNotesMessages.map((message) => {
      const html = message.role === 'assistant'
        ? renderMarkdown(message.content || '')
        : escapeHtml(message.content || '').replace(/\n/g, '<br>')
      const attachmentsHtml = Array.isArray(message.attachments) && message.attachments.length > 0
        ? `<div class="chat-notes-message-attachments">${message.attachments.map((attachment) => `
            <div class="chat-notes-message-attachment${attachment.blocked ? ' blocked' : ''}" title="${escapeHtmlAttr(attachment.warnings.join('\n') || attachment.name)}">
              <svg class="chat-notes-message-attachment-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
                ${getAttachmentIconMarkup(attachment)}
              </svg>
              <span>${escapeHtml(attachment.name)}</span>
            </div>
          `).join('')}</div>`
        : ''
      const sourcesHtml = message.role === 'assistant' && message.sources && message.sources.length > 0
        ? `<div class="chat-notes-sources"><span>Sources</span>${message.sources.map((noteId) => `<button type="button" class="chat-notes-source" data-note-id="${escapeHtmlAttr(noteId)}">${escapeHtml(noteDisplayTitle(noteId))}</button>`).join('')}</div>`
        : ''
      return `<div class="chat-notes-message ${message.role}">${html}${attachmentsHtml}${sourcesHtml}</div>`
    }).join('')
    chatNotesThread.scrollTop = chatNotesThread.scrollHeight
  }

  function resetChatNotesComposer(options: { clearAttachments?: boolean } = {}) {
    if (chatNotesInput) {
      chatNotesInput.value = ''
    }
    if (options.clearAttachments !== false) {
      chatNotesPendingAttachments = []
      renderChatNotesPendingAttachments()
    }
  }

  async function startNewChatNotesConversation() {
    chatNotesMessages = []
    chatNotesIsGenerating = false
    resetChatNotesComposer()
    renderChatNotesThread()
  }

  async function sendChatNotesMessage() {
    if (!chatNotesInput || chatNotesIsGenerating) return

    const text = chatNotesInput.value.trim()
    const readyAttachments = chatNotesPendingAttachments.filter(isReadyAttachment)
    const blockedAttachments = chatNotesPendingAttachments.filter((attachment) => attachment.blocked)
    if (!text && readyAttachments.length === 0) return

    const userMessage: ChatPageMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
      ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {})
    }

    chatNotesMessages.push(userMessage)
    chatNotesIsGenerating = true
    chatNotesPendingAttachments = blockedAttachments
    renderChatNotesPendingAttachments()
    resetChatNotesComposer({ clearAttachments: false })
    renderChatNotesThread()

    const assistantMessage: ChatPageMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    }
    chatNotesMessages.push(assistantMessage)
    renderChatNotesThread()

    const cleanupChunk = window.chat.onStreamChunk((chunk: string) => {
      assistantMessage.content += chunk
      renderChatNotesThread()
    })
    const cleanupDone = window.chat.onStreamDone(() => {
      cleanupChunk()
      cleanupDone()
      cleanupError()
      chatNotesIsGenerating = false
    })
    const cleanupError = window.chat.onStreamError((error: string) => {
      cleanupChunk()
      cleanupDone()
      cleanupError()
      chatNotesIsGenerating = false
      assistantMessage.content = assistantMessage.content || `Error: ${error}`
      renderChatNotesThread()
    })

    try {
      const messagesToSend = chatNotesMessages.filter((message) => message.role !== 'system')

      const response = await window.electronAPI.chatSend({
        messages: messagesToSend,
        manualNoteIds: Array.from(chatNotesSelectedNoteIds),
        searchAllNotes: chatNotesSelectedNoteIds.size === 0
      })

      if (response.ok && response.sources?.noteIds?.length) {
        assistantMessage.sources = response.sources.noteIds
        renderChatNotesThread()
      }

      if (response.ok && response.text && !response.streaming) {
        cleanupChunk()
        cleanupDone()
        cleanupError()
        assistantMessage.content = response.text
        chatNotesIsGenerating = false
        renderChatNotesThread()
      } else if (!response.ok && !response.streaming) {
        cleanupChunk()
        cleanupDone()
        cleanupError()
        assistantMessage.content = `Error: ${response.message || 'Failed to get response'}`
        chatNotesIsGenerating = false
        renderChatNotesThread()
      }
    } catch (error: any) {
      cleanupChunk()
      cleanupDone()
      cleanupError()
      assistantMessage.content = `Error: ${error?.message || 'Network error'}`
      chatNotesIsGenerating = false
      renderChatNotesThread()
    }
  }


  // Welcome message cycling
  const welcomeHeader = $('welcomeHeader') as HTMLElement | null
  const focusPhrases = [
    "In the flow",
    "Quietly productive",
    "Deep work mode",
    "Clear headspace",
    "Steady progress",
    "Mind on task",
    "Thoughtful pace",
    "Flow continues",
    "Small steps count",
    "Intentional work",
    "Focus starts now",
    "Work, calmly"
  ]

  if (welcomeHeader) {
    const lastIdx = parseInt(localStorage.getItem('welcomePhraseIdx') || '-1', 10)
    const nextIdx = (lastIdx + 1) % focusPhrases.length
    welcomeHeader.textContent = focusPhrases[nextIdx]
    localStorage.setItem('welcomePhraseIdx', nextIdx.toString())
  }

  // Use Cases Modal
  const useCasesModal = document.getElementById('useCasesModal') as HTMLElement | null
  const closeUseCasesModal = document.getElementById('closeUseCasesModal') as HTMLButtonElement | null

  if (closeUseCasesModal && useCasesModal) {
    closeUseCasesModal.addEventListener('click', () => {
      useCasesModal.style.display = 'none'
    })
  }

  // Close modal when clicking outside
  window.addEventListener('click', (e) => {
    if (useCasesModal && e.target === useCasesModal) {
      useCasesModal.style.display = 'none'
    }
  })

  // Zoom helpers
  async function applySavedZoom() {
    const saved = Number(localStorage.getItem('zoom_factor') || '1')
    if (saved && isFinite(saved)) {
      await window.electronAPI.zoomSet(saved)
    }
  }
  function persistZoom(factor?: number) {
    if (typeof factor === 'number' && isFinite(factor)) {
      localStorage.setItem('zoom_factor', String(factor))
    }
  }
  window.addEventListener('wheel', async (e) => {
    if (e.ctrlKey) {
      e.preventDefault()
      const dir = e.deltaY > 0 ? -0.05 : 0.05
      const res = await window.electronAPI.zoomDelta(dir)
      persistZoom(res.factor)
    }
  }, { passive: false })
  window.addEventListener('keydown', async (e) => {
    const isCtrl = e.ctrlKey || (window.env?.platform === 'darwin' && e.metaKey)
    if (isCtrl) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); const r = await window.electronAPI.zoomDelta(0.1); persistZoom(r.factor) }
      if (e.key === '-') { e.preventDefault(); const r = await window.electronAPI.zoomDelta(-0.1); persistZoom(r.factor) }
      if (e.key === '0') { e.preventDefault(); const r = await window.electronAPI.zoomSet(1); persistZoom(r.factor) }
    } else if (e.key === ' ' || e.code === 'Space') {
      const el = (document.activeElement as HTMLElement | null)
      const tag = (el?.tagName || '').toLowerCase()
      const role = (el?.getAttribute?.('role') || '').toLowerCase()
      const isInteractiveTag = tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a'
      const isInteractiveRole = /^(button|switch|slider|textbox|combobox|menuitem|tab|link)$/.test(role)
      const isEditable = !!(el && (el.isContentEditable || (el as any).contentEditable === 'true'))
      if (isInteractiveTag || isInteractiveRole || isEditable) return
      e.preventDefault()
      if (stopBtn && !stopBtn.disabled) {
        stopBtn.click()
      } else if (recordBtn && !recordBtn.disabled) {
        recordBtn.click()
      }
    }
  })
  applySavedZoom().catch(() => { })
  // Default to home view on load
  try { setView('home') } catch { }
  // Populate notes in sidebar on startup
  refreshNotes().catch((error) => {
    console.error('Failed to initialize notes:', error)
  })

  // Add global error handler for unhandled errors
  window.addEventListener('error', (event) => {
    console.error('Unhandled error:', event.error)
  })

  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason)
  })

  function appendProgress(msg: string) {
    if (!progressLog) return
    progressLog.textContent = (progressLog.textContent ? progressLog.textContent + '\n' : '') + msg
    progressLog.scrollTop = progressLog.scrollHeight
  }



  // Preferences panel (cues)
  async function loadPrefs() {
    try {
      const r = await window.electronAPI.prefsGet()
      if (r.ok && r.prefs) {
        if (chatTranslucenceEl) {
          const translucence = Math.max(0, Math.min(100, Number(r.prefs.chatTranslucence ?? 50)))
          chatTranslucenceEl.value = String(translucence)
        }
        if (chatShortcutEl) chatShortcutEl.value = r.prefs.chatShortcut || 'CommandOrControl+K'

        // Also load into Settings page controls
        if (settingsChatTranslucenceEl) {
          const translucence = Math.max(0, Math.min(100, Number(r.prefs.chatTranslucence ?? 50)))
          settingsChatTranslucenceEl.value = String(translucence)
          settingsChatTranslucenceEl.style.background = `linear-gradient(to right, var(--text-primary) 0%, var(--text-primary) ${translucence}%, #eee ${translucence}%, #eee 100%)`
        }

        // Load general settings
        if (settingsOpenAtStartupEl) {
          settingsOpenAtStartupEl.checked = r.prefs.openAtStartup ?? true
        }
        if (settingsMeetingNotificationsEl) {
          settingsMeetingNotificationsEl.checked = r.prefs.meetingNotificationsEnabled ?? true
        }
        // Load stealth mode settings
        if (settingsStealthModeEl) {
          settingsStealthModeEl.checked = r.prefs.stealthMode ?? false
        }
        if (settingsStealthScreenCaptureEl) {
          settingsStealthScreenCaptureEl.checked = r.prefs.stealthScreenCaptureBlock ?? false
        }
        if (settingsStealthClickThroughEl) {
          settingsStealthClickThroughEl.checked = r.prefs.stealthClickThrough ?? true
        }
        if (settingsStealthDarkThemeEl) {
          settingsStealthDarkThemeEl.checked = r.prefs.stealthDarkTheme ?? true
        }
        if (settingsChatOverlayHoverableEl) {
          settingsChatOverlayHoverableEl.checked = r.prefs.chatOverlayHoverable ?? false
        }
        if (settingsChatOverlayMinimalEl) {
          settingsChatOverlayMinimalEl.checked = r.prefs.chatOverlayMinimal ?? false
        }
        if (settingsChatOverlayTextCursorEl) {
          settingsChatOverlayTextCursorEl.checked = r.prefs.chatOverlayTextCursor ?? false
        }
        // Show/hide stealth options based on stealth mode state
        if (settingsStealthOptionsEl) {
          settingsStealthOptionsEl.style.display = (r.prefs.stealthMode ?? false) ? 'block' : 'none'
        }
        // Load personalization settings
        const aiStyleMode = r.prefs.aiStyleMode || 'professional'
        if (aiStyleProfessionalEl) aiStyleProfessionalEl.checked = aiStyleMode === 'professional'
        if (aiStyleCasualEl) aiStyleCasualEl.checked = aiStyleMode === 'casual'
        if (aiStyleConciseEl) aiStyleConciseEl.checked = aiStyleMode === 'concise'
        if (aiStyleCustomRadioEl) aiStyleCustomRadioEl.checked = aiStyleMode === 'custom'
        if (aiStyleCustomEl && r.prefs.aiStyleCustom !== undefined) {
          aiStyleCustomEl.value = r.prefs.aiStyleCustom || ''
        }
        if (aiStyleCustomBoxEl) {
          aiStyleCustomBoxEl.style.display = aiStyleMode === 'custom' ? 'block' : 'none'
        }
        // Initialize shortcuts and templates lists
        setTimeout(() => {
          loadShortcuts().catch(() => { })
          renderTemplates().catch(() => { })
        }, 100)
        // Load dictation language setting
        if (settingsDictationLanguageEl && r.prefs.dictationLanguage) {
          settingsDictationLanguageEl.value = r.prefs.dictationLanguage
        }
      }
    } catch { }
  }
  function bindPrefs() {
    chatTranslucenceEl?.addEventListener('input', () => {
      if (chatTranslucenceEl) {
        const translucence = Math.max(0, Math.min(100, Number(chatTranslucenceEl.value || '0')))
        window.electronAPI.prefsUpdate({ chatTranslucence: translucence }).catch(() => { })
      }
    })
  }

  loadPrefs().then(() => {
    bindPrefs()
  }).catch(() => { })
  loadShortcuts().catch(() => { })

  // macOS Permissions Section - show only on macOS and handle permission requests
  const permissionCardsByStep: Partial<Record<PermissionGroupId, { status: HTMLElement | null; button: HTMLButtonElement | null; desc: HTMLElement | null }>> = {
    microphone: { status: settingsMicStatus, button: settingsMicBtn, desc: settingsMicDesc },
    meeting_capture: { status: settingsMeetingCaptureStatus, button: settingsMeetingCaptureBtn, desc: settingsMeetingCaptureDesc },
    typing_access: { status: settingsTypingAccessStatus, button: settingsTypingAccessBtn, desc: settingsTypingAccessDesc },
    global_shortcuts: { status: settingsGlobalShortcutsStatus, button: settingsGlobalShortcutsBtn, desc: settingsGlobalShortcutsDesc }
  }

  function setPermissionDot(element: HTMLElement | null, step: PermissionWizardStep) {
    if (!element) return
    element.classList.remove('granted', 'pending', 'denied')
    if (step.verified) {
      element.classList.add('granted')
    } else if (step.health === 'degraded' || step.state === 'repair_needed' || step.state === 'needs_restart') {
      element.classList.add('denied')
    } else {
      element.classList.add('pending')
    }
  }

  function getPermissionButtonLabel(step: PermissionWizardStep): string {
    if (step.verified) {
      return step.id === 'global_shortcuts' ? 'Verify again' : 'Review'
    }
    if (step.needsRestart) return 'Restart needed'
    if (step.state === 'repair_needed') return 'Repair'
    return 'Check'
  }

  function getPermissionDescription(step: PermissionWizardStep): string {
    if (step.verified) return step.detail
    if (step.needsRestart) return `${step.detail} Restart Notto after changing the macOS permission.`
    return step.detail
  }

  async function refreshPermissionsSection() {
    if (window.env?.platform !== 'darwin' || !permissionsSection) return
    try {
      const wizard = await window.electronAPI.permissions.getWizardState() as OnboardingWizardState
      wizard.steps.forEach((step) => {
        const card = permissionCardsByStep[step.id]
        if (!card) return
        setPermissionDot(card.status || null, step)
        if (card.button) {
          card.button.textContent = getPermissionButtonLabel(step)
          card.button.classList.toggle('granted', step.verified)
        }
        if (card.desc) {
          card.desc.textContent = getPermissionDescription(step)
        }
      })
    } catch (err) {
      console.error('Failed to refresh permissions section:', err)
    }
  }

  async function runSettingsPermissionRepair(stepId: PermissionGroupId) {
    try {
      const card = permissionCardsByStep[stepId]
      if (card?.button) {
        card.button.disabled = true
        card.button.textContent = 'Checking...'
      }

      if (stepId === 'meeting_capture') {
        if ((navigator.mediaDevices as any)?.getDisplayMedia) {
          let stream: MediaStream | null = null
          let started = false
          try {
            stream = await (navigator.mediaDevices as any).getDisplayMedia({ audio: true, video: true })
            started = true
            await new Promise((resolve) => setTimeout(resolve, 1000))
          } catch (err) {
            console.warn('Meeting capture preflight did not start:', err)
          } finally {
            try { stream?.getTracks().forEach((track) => track.stop()) } catch { }
          }
          await window.electronAPI.permissions.acknowledgeSystemAudioCapturePreflight(started)
        }
      }

      const result = await window.electronAPI.permissions.checkStep(stepId)
      if (!result?.ok) {
        await window.electronAPI.permissions.openStepSettings(stepId)
      }
      await refreshPermissionsSection()
    } catch (err) {
      console.error(`Failed to repair settings permission step ${stepId}:`, err)
      await window.electronAPI.permissions.openStepSettings(stepId)
      await refreshPermissionsSection()
    } finally {
      const card = permissionCardsByStep[stepId]
      if (card?.button) card.button.disabled = false
    }
  }

  if (window.env?.platform === 'darwin' && permissionsSection) {
    permissionsSection.style.display = 'block'
    refreshPermissionsSection()

    settingsMicBtn?.addEventListener('click', async () => {
      const wizard = await window.electronAPI.permissions.getWizardState() as OnboardingWizardState
      const step = wizard.steps.find((item) => item.id === 'microphone')
      if (step?.verified) await window.electronAPI.permissions.openStepSettings('microphone')
      else await runSettingsPermissionRepair('microphone')
    })

    settingsMeetingCaptureBtn?.addEventListener('click', async () => {
      const wizard = await window.electronAPI.permissions.getWizardState() as OnboardingWizardState
      const step = wizard.steps.find((item) => item.id === 'meeting_capture')
      if (step?.verified) await window.electronAPI.permissions.openStepSettings('meeting_capture')
      else await runSettingsPermissionRepair('meeting_capture')
    })

    settingsTypingAccessBtn?.addEventListener('click', async () => {
      const wizard = await window.electronAPI.permissions.getWizardState() as OnboardingWizardState
      const step = wizard.steps.find((item) => item.id === 'typing_access')
      if (step?.verified) await window.electronAPI.permissions.openStepSettings('typing_access')
      else await runSettingsPermissionRepair('typing_access')
    })

    settingsGlobalShortcutsBtn?.addEventListener('click', async () => {
      const wizard = await window.electronAPI.permissions.getWizardState() as OnboardingWizardState
      const step = wizard.steps.find((item) => item.id === 'global_shortcuts')
      if (step?.verified) await runSettingsPermissionRepair('global_shortcuts')
      else await runSettingsPermissionRepair('global_shortcuts')
    })
  }


  // Listen for prefs updates from other windows (e.g., chat window)
  if (typeof window.electronAPI.onPrefsUpdate === 'function') {
    window.electronAPI.onPrefsUpdate((prefs: any) => {
      // Update settings sliders when prefs change from other sources
      if (settingsChatTranslucenceEl && typeof prefs.chatTranslucence === 'number') {
        const translucence = Math.max(0, Math.min(100, prefs.chatTranslucence))
        settingsChatTranslucenceEl.value = String(translucence)
        settingsChatTranslucenceEl.style.background = `linear-gradient(to right, var(--text-primary) 0%, var(--text-primary) ${translucence}%, #eee ${translucence}%, #eee 100%)`
      }
      if (settingsChatOverlayHoverableEl && typeof prefs.chatOverlayHoverable === 'boolean') {
        settingsChatOverlayHoverableEl.checked = prefs.chatOverlayHoverable
      }
      if (settingsChatOverlayMinimalEl && typeof prefs.chatOverlayMinimal === 'boolean') {
        settingsChatOverlayMinimalEl.checked = prefs.chatOverlayMinimal
      }
      if (settingsChatOverlayTextCursorEl && typeof prefs.chatOverlayTextCursor === 'boolean') {
        settingsChatOverlayTextCursorEl.checked = prefs.chatOverlayTextCursor
      }
    })
  }

  // Load and display keyboard shortcuts
  async function loadShortcuts() {
    try {
      const r = await window.electronAPI.shortcutsGet()
      if (r.ok && r.shortcuts) {
        displayShortcuts(r.shortcuts)
        updateHeroShortcuts(r.shortcuts)
      }
    } catch (e) {
      console.error('Failed to load shortcuts:', e)
    }
  }

  // Detect platform
  const isMac = window.env?.platform === 'darwin'

  // Convert shortcut to keycap display with OS-specific icons
  function isShortcutBound(shortcut: string | null | undefined): boolean {
    return !!shortcut && shortcut.trim().length > 0 && shortcut.trim().toLowerCase() !== 'unbound'
  }

  function formatShortcutKeys(shortcut: string, useKbd = false): string {
    const keys = shortcut.split('+').map((k: string) => k.trim())
    const keyMap: Record<string, string> = {
      'CommandOrControl': isMac ? '⌘' : 'Ctrl',
      'Command': isMac ? '⌘' : 'Win',
      'Cmd': isMac ? '⌘' : 'Win',
      'Control': isMac ? '⌃' : 'Ctrl',
      'Ctrl': isMac ? '⌃' : 'Ctrl',
      'Shift': isMac ? '⇧' : 'Shift',
      'Alt': isMac ? '⌥' : 'Alt',
      'Option': isMac ? '⌥' : 'Alt',
      'CapsLock': isMac ? '⇪' : 'Caps',
      'Enter': isMac ? '↵' : 'Enter',
      'Escape': isMac ? '⎋' : 'Esc',
      'Tab': isMac ? '⇥' : 'Tab',
      'Backspace': isMac ? '⌫' : 'Back',
      'Delete': isMac ? '⌦' : 'Del',
      'Up': '↑',
      'Down': '↓',
      'Left': '←',
      'Right': '→',
      'Plus': '+',
      '=': '+',
      'Meta': isMac ? '⌘' : 'Win',
      'Super': isMac ? '⌘' : 'Win'
    }

    return keys.map((k: string) => {
      const displayKey = keyMap[k] || k
      if (useKbd) {
        return `<kbd>${displayKey}</kbd>`
      }
      return `<span class="keycap">${displayKey}</span>`
    }).join(useKbd ? ' + ' : '<span class="keycap-plus" style="margin: 0 6px;">+</span>')
  }

  // Update hero card shortcuts with actual values
  async function updateHeroShortcuts(shortcuts: any, disabledKey?: string) {
    const heroMapping = [
      { key: 'dictationHold', id: 'hero-key-dictationHold' },
      { key: 'dictationToggle', id: 'hero-key-dictationToggle' },
      { key: 'aiModeHold', id: 'hero-key-aiModeHold' },
      { key: 'aiModeToggle', id: 'hero-key-aiModeToggle' },
      { key: 'notesToggle', id: 'hero-key-notesToggle' },
      { key: 'chatToggle', id: 'hero-key-chatToggle' },
      { key: 'screenshotCapture', id: 'hero-key-screenshotCapture' }
    ]

    // Get currently disabled shortcuts
    const disabledRes = await window.electronAPI.shortcutsGetDisabled()
    const disabledSet = new Set(disabledRes.ok ? disabledRes.disabled : [])
    if (disabledKey) disabledSet.add(disabledKey)

    heroMapping.forEach(({ key, id }) => {
      const element = document.getElementById(id)
      if (!element) return

      if (disabledSet.has(key)) {
        element.innerHTML = '<span style="opacity: 0.5;">Disabled</span>'
      } else if (isShortcutBound(shortcuts[key])) {
        element.innerHTML = formatShortcutKeys(shortcuts[key], true)
      } else {
        element.innerHTML = '<span style="opacity: 0.5;">None</span>'
      }
    })
  }

  // Display shortcuts in the UI with edit capability
  async function displayShortcuts(shortcuts: any) {
    const container = document.getElementById('shortcutsContainer')
    if (!container) return

    const shortcutLabels: Record<string, string> = {
      // Core Dictation
      dictationHold: 'Dictation (Hold)',
      dictationToggle: 'Dictation (Toggle)',

      // Core Agentic
      aiModeHold: 'Agentic Dictation (Hold)',
      aiModeToggle: 'Agentic Dictation (Toggle)',

      // Notes Navigation
      notesToggle: 'Personal Note',

      // Chat
      chatToggle: 'AI Chat Overlay',
      screenshotCapture: 'Capture Screenshot in AI Chat',

      // Chat Navigation
      chatSend: 'Send Prompt',
      chatNewChat: 'New Chat',
      chatMoveUp: 'Move Overlay Up',
      chatMoveDown: 'Move Overlay Down',
      chatMoveLeft: 'Move Overlay Left',
      chatMoveRight: 'Move Overlay Right',
      chatTransparencyIncrease: 'Increase Overlay Transparency',
      chatTransparencyDecrease: 'Decrease Overlay Transparency',
    }

    container.innerHTML = ''
    // Create grid container
    container.style.display = 'grid'
    container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(225px, 1fr))'
    container.style.columnGap = '24px'
    container.style.justifyContent = 'center'
    container.style.rowGap = '16px'
    // Add padding to prevent bottom clipping of the last row
    container.style.padding = '4px 4px 20px 4px'
    container.style.overflow = 'visible'

    const allShortcuts = [
      // Configurable shortcuts from main process
      ...Object.entries(shortcutLabels).map(([key, label]) => ({
        key,
        label,
        value: shortcuts[key],
        isStatic: false
      }))
    ]

    const disabledRes = await window.electronAPI.shortcutsGetDisabled()
    const disabledSet = new Set(disabledRes.ok ? disabledRes.disabled : [])

    for (const item of allShortcuts) {
      const isBound = isShortcutBound(item.value)
      const isEnabled = !disabledSet.has(item.key)

      const row = document.createElement('div')

      // Update styling to handle disabled state visually (opacity)
      const baseStyle = 'display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 8px; padding: 12px; transition: all 0.15s ease; background: var(--bg-secondary); align-items: center; text-align: center; position: relative; min-height: 100px; justify-content: center;'
      row.style.cssText = baseStyle + (isEnabled ? '' : ' opacity: 0.6; filter: grayscale(0.5);')

      // Label container (Title + Toggle)
      const labelContainer = document.createElement('div')
      labelContainer.style.cssText = 'display: flex; align-items: center; justify-content: center; width: 100%; position: relative; margin-bottom: 4px;'

      const labelSpan = document.createElement('div')
      labelSpan.className = 'text-small'
      labelSpan.style.cssText = 'color: var(--text-primary); font-weight: 500;'
      labelSpan.textContent = item.label

      // Toggle Switch
      const toggleContainer = document.createElement('div')
      toggleContainer.className = 'settings-control'
      toggleContainer.style.cssText = 'position: absolute; right: 0; scale: 0.8; transform-origin: right center;'

      const toggleLabel = document.createElement('label')
      toggleLabel.className = 'switch'
      const toggleInput = document.createElement('input')
      toggleInput.type = 'checkbox'
      toggleInput.checked = isEnabled

      const toggleSlider = document.createElement('span')
      toggleSlider.className = 'switch-slider'

      toggleLabel.appendChild(toggleInput)
      toggleLabel.appendChild(toggleSlider)
      toggleContainer.appendChild(toggleLabel)

      // Add switch functionality
      toggleInput.addEventListener('change', async (e) => {
        // Prevent event bubbling so it doesn't trigger shortcut recording if we click weirdly
        e.stopPropagation()

        try {
          const newState = toggleInput.checked
          // Optimistic UI update
          row.style.cssText = baseStyle + (newState ? '' : ' opacity: 0.6; filter: grayscale(0.5);')

          const res = await window.electronAPI.shortcutsToggle(item.key, newState)
          if (!res.ok) {
            // Revert on failure
            toggleInput.checked = !newState
            row.style.cssText = baseStyle + (!newState ? '' : ' opacity: 0.6; filter: grayscale(0.5);')
            console.error('Failed to toggle shortcut:', res.message)
          } else {
            // Reload to ensure Disabled Set is fresh? No, we optimistically updated.
            // But we might want to refresh the "Hero" section if this affects it.
            window.electronAPI.shortcutsGet().then((r: any) => {
              if (r.ok && r.shortcuts) {
                // Update disabled state for hero
                // Actually updateHeroShortcuts needs to know about disabled state too.
                // Let's tackle that separately or pass it down.
                // For now, hero shortcuts will just show "None" if unassigned, but here we are disabling. 
                // Main process logic: if disabled, it won't fire. But "display" in hero should probably reflect "Disabled".
                updateHeroShortcuts(r.shortcuts, toggleInput.checked ? undefined : item.key) // naive update
              }
            })
          }
        } catch (err) {
          console.error(err)
          toggleInput.checked = !toggleInput.checked // Revert
        }
      })

      labelContainer.appendChild(labelSpan)
      labelContainer.appendChild(toggleContainer)

      row.appendChild(labelContainer)

      const keysContainer = document.createElement('div')
      keysContainer.className = 'keys-container-wrapper'
      // Pack to center:
      keysContainer.style.cssText = `display: flex; align-items: center; justify-content: center; gap: 12px; position: relative; padding: 6px 10px; background: #fff; border: 1px solid #ddd; border-radius: 4px; ${!item.isStatic ? 'cursor: pointer;' : ''} transition: all 0.15s ease; margin-bottom: 4px; overflow: visible; width: 100%;`
      if (!item.isStatic) {
        keysContainer.dataset.shortcutKey = item.key
      }

      const keysDisplay = document.createElement('div')
      keysDisplay.style.cssText = 'display: flex; align-items: center; gap: 4px;'

      if (isBound) {
        keysDisplay.innerHTML = formatShortcutKeys(item.value)
      } else {
        keysDisplay.innerHTML = '<span style="color: var(--text-muted); opacity: 0.6; font-style: italic; font-size: 13px;">Not bound</span>'
      }

      if (!item.isStatic) {
        const editIcon = document.createElement('span')
        editIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; transition: opacity 0.15s ease;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`
        editIcon.style.cssText = 'display: flex; align-items: center; flex-shrink: 0; margin-left: 4px;'
        editIcon.title = 'Edit Shortcut'

        // Removed the trash/clear button here as requested, superseded by toggle switch + re-binding

        const statusSpan = document.createElement('span')
        statusSpan.className = 'text-small'
        statusSpan.style.cssText = 'font-size: 11px; opacity: 0.6; min-height: 14px;'

        let isRecording = false
        let recordedKeys = new Set<string>()

        // Hover effect for edit icon
        keysContainer.addEventListener('mouseenter', () => {
          if (!isRecording) {
            editIcon.querySelector('svg')!.style.opacity = '0.7'
            keysContainer.style.borderColor = '#999'
          }
        })

        keysContainer.addEventListener('mouseleave', () => {
          if (!isRecording) {
            editIcon.querySelector('svg')!.style.opacity = '0.4'
            keysContainer.style.borderColor = '#ddd'
          }
        })

        keysContainer.addEventListener('click', () => {
          // If deactivated (toggle off), ask if they want to enable it first? 
          // Or just let them edit, but keep it disabled? 
          // UX choice: Editing usually implies intent to use. Let's auto-enable or just let it be.
          // For now, allow editing even if disabled, but maybe show a visual cue?
          // Actually, if row is disabled, it might be confusing. 
          // Let's auto-enable on successful edit? Or just leave it. Leaving it is safer.

          if (isRecording) {
            isRecording = false
            recordedKeys.clear()
            keysContainer.style.background = '#fff'
            keysContainer.style.borderColor = '#ddd'
            // Removing recording class
            document.body.classList.remove('is-recording-shortcut')
            keysDisplay.innerHTML = isShortcutBound(shortcuts[item.key]) ? formatShortcutKeys(shortcuts[item.key]) : '<span style="color: var(--text-muted); opacity: 0.6; font-style: italic; font-size: 13px;">Not bound</span>'
            statusSpan.textContent = ''

            // Re-enable hold shortcuts
            window.electronAPI.setHoldShortcutsEnabled(true)
            return
          }

          isRecording = true
          recordedKeys.clear()
          // Adding recording class
          document.body.classList.add('is-recording-shortcut')
          keysContainer.style.background = '#E3F2FD'
          keysContainer.style.borderColor = '#2196F3'
          keysDisplay.innerHTML = '<span style="color: #666; font-size: 12px;">Press keys...</span>'
          statusSpan.textContent = ''

          // Disable hold shortcuts to prevent triggering while recording
          window.electronAPI.setHoldShortcutsEnabled(false)
        })

        // Track currently held modifiers for live display and modifier-only shortcuts
        let currentModifiers = new Set<string>()
        let lastNonModifierKey: string | null = null

        const keyDownHandler = (e: KeyboardEvent) => {
          if (!isRecording || keysContainer.dataset.shortcutKey !== item.key) return

          e.preventDefault()
          e.stopPropagation()

          // Track modifiers
          if (e.ctrlKey) currentModifiers.add(isMac ? 'Control' : 'CommandOrControl')
          if (e.metaKey) currentModifiers.add(isMac ? 'Command' : 'Meta')
          if (e.shiftKey) currentModifiers.add('Shift')
          if (e.altKey) currentModifiers.add(isMac ? 'Option' : 'Alt')

          const keyPart = e.key
          // If it's not a modifier key, record it
          if (keyPart !== 'Control' && keyPart !== 'Meta' && keyPart !== 'Shift' && keyPart !== 'Alt') {
            // Map special keys
            const keyMap: Record<string, string> = {
              ' ': 'Space',
              'ArrowUp': 'Up',
              'ArrowDown': 'Down',
              'ArrowLeft': 'Left',
              'ArrowRight': 'Right',
              '+': 'Plus',
              '=': 'Plus',
              'OS': 'Meta' // Windows key sometimes reports as 'OS'
            }
            lastNonModifierKey = keyMap[keyPart] || keyPart.toUpperCase()
          }

          // Show live feedback
          const parts = [...currentModifiers]
          if (lastNonModifierKey) parts.push(lastNonModifierKey)
          if (parts.length > 0) {
            keysDisplay.innerHTML = formatShortcutKeys(parts.join('+'))
          }
        }

        const keyUpHandler = (e: KeyboardEvent) => {
          if (!isRecording || keysContainer.dataset.shortcutKey !== item.key) return

          e.preventDefault()
          e.stopPropagation()

          // Build final shortcut from held modifiers + optional key
          const parts = [...currentModifiers]
          if (lastNonModifierKey) parts.push(lastNonModifierKey)

          // Only save if we have at least one modifier or a key
          if (parts.length === 0) return

          const shortcut = parts.join('+')
          const requiresNonModifierKey = item.key === 'dictationHold' || item.key === 'aiModeHold'
          if (requiresNonModifierKey && !lastNonModifierKey) {
            isRecording = false
            document.body.classList.remove('is-recording-shortcut')
            currentModifiers.clear()
            lastNonModifierKey = null
            keysContainer.style.background = '#fff'
            keysContainer.style.borderColor = '#ddd'
            statusSpan.textContent = 'Add a non-modifier key'
            statusSpan.style.color = '#f44336'
            keysDisplay.innerHTML = isBound ? formatShortcutKeys(shortcuts[item.key]) : '<span style="color: var(--text-muted); opacity: 0.6; font-style: italic; font-size: 13px;">Not bound</span>'
            window.electronAPI.setHoldShortcutsEnabled(true)
            return
          }
          keysDisplay.innerHTML = formatShortcutKeys(shortcut)

          // Reset tracking
          currentModifiers.clear()
          lastNonModifierKey = null

          // Save shortcut
          isRecording = false
          document.body.classList.remove('is-recording-shortcut')
          keysContainer.style.borderColor = '#888'
          statusSpan.textContent = 'Saving...'
          statusSpan.style.color = '#666'

          window.electronAPI.shortcutsUpdate({ [item.key]: shortcut })
            .then((r: any) => {
              window.electronAPI.setHoldShortcutsEnabled(true)
              if (r.ok) {
                keysContainer.style.background = '#fff'
                keysContainer.style.borderColor = '#ddd'
                shortcuts[item.key] = shortcut
                keysDisplay.innerHTML = formatShortcutKeys(shortcut)
                statusSpan.textContent = 'Saved'
                statusSpan.style.color = '#4CAF50'

                // If it was disabled, maybe we should auto-enable it?
                // Let's do it for better UX.
                if (!toggleInput.checked) {
                  toggleInput.checked = true
                  // Trigger change event or call API directly
                  // Let's call API directly to avoid event bubbling issues
                  window.electronAPI.shortcutsToggle(item.key, true).then(() => {
                    row.style.cssText = baseStyle // remove opacity
                  })
                }

                // Update hero shortcuts immediately to keep them in sync
                const newShortcuts = { ...shortcuts, [item.key]: shortcut }
                updateHeroShortcuts(newShortcuts)

                setTimeout(() => {
                  statusSpan.textContent = ''
                }, 2000)
              } else {
                keysContainer.style.background = '#fff'
                keysContainer.style.borderColor = '#ddd'
                statusSpan.textContent = `? ${r.message || 'Failed'}`
                statusSpan.style.color = '#f44336'
                keysDisplay.innerHTML = isShortcutBound(shortcuts[item.key]) ? formatShortcutKeys(shortcuts[item.key]) : '<span style="color: var(--text-muted); opacity: 0.6; font-style: italic; font-size: 13px;">Not bound</span>'
              }
            })
            .catch((e: any) => {
              window.electronAPI.setHoldShortcutsEnabled(true)
              keysContainer.style.background = '#fff'
              keysContainer.style.borderColor = '#ddd'
              statusSpan.textContent = 'Error'
              statusSpan.style.color = '#f44336'
              keysDisplay.innerHTML = isShortcutBound(shortcuts[item.key]) ? formatShortcutKeys(shortcuts[item.key]) : '<span style="color: var(--text-muted); opacity: 0.6; font-style: italic; font-size: 13px;">Not bound</span>'
            })
        }

        window.addEventListener('keydown', keyDownHandler)
        window.addEventListener('keyup', keyUpHandler)

        keysContainer.appendChild(keysDisplay)
        keysContainer.appendChild(editIcon)

        // row.appendChild(labelSpan) --> Moved up to labelContainer
        row.appendChild(keysContainer)
        row.appendChild(statusSpan)
      } else {
        // Static shortcut - read only
        keysContainer.style.cursor = 'default'
        keysContainer.style.background = '#f5f5f5' // Light gray to indicate disabled/static

        keysContainer.appendChild(keysDisplay)

        // row.appendChild(labelSpan) --> Moved up
        row.appendChild(keysContainer)

        // Spacer to match height of dynamic shortcuts
        const statusSpan = document.createElement('span')
        statusSpan.className = 'text-small'
        statusSpan.style.cssText = 'font-size: 11px; opacity: 0; min-height: 14px;'
        row.appendChild(statusSpan)
      }

      container.appendChild(row)
    }
  }

  // Bind Settings page controls (mirroring the Meetings preferences)
  function bindSettingsControls() {
    settingsChatTranslucenceEl?.addEventListener('input', () => {
      if (settingsChatTranslucenceEl) {
        let val = Number(settingsChatTranslucenceEl.value || '0')
        val = Math.max(0, Math.min(100, val))

        settingsChatTranslucenceEl.style.background = `linear-gradient(to right, var(--text-primary) 0%, var(--text-primary) ${val}%, #eee ${val}%, #eee 100%)`

        window.electronAPI.prefsUpdate({ chatTranslucence: val }).catch(() => { })
        // Sync with Meetings page control if it exists
        if (chatTranslucenceEl) {
          chatTranslucenceEl.value = String(val)
          chatTranslucenceEl.style.background = `linear-gradient(to right, var(--text-primary) 0%, var(--text-primary) ${val}%, #eee ${val}%, #eee 100%)`
        }
      }
    })

    settingsOpenAtStartupEl?.addEventListener('change', () => {
      const enabled = settingsOpenAtStartupEl?.checked ?? true
      window.electronAPI.prefsUpdate({ openAtStartup: enabled }).catch(() => { })
    })

    // Dictation language picker
    settingsDictationLanguageEl?.addEventListener('change', () => {
      if (settingsDictationLanguageEl) {
        window.electronAPI.prefsUpdate({ dictationLanguage: settingsDictationLanguageEl.value }).catch(() => { })
      }
    })

    settingsMeetingNotificationsEl?.addEventListener('change', () => {
      const enabled = settingsMeetingNotificationsEl?.checked ?? true
      window.electronAPI.prefsUpdate({ meetingNotificationsEnabled: enabled } as any).catch(() => { })
    })

    // Stealth mode controls (moved to AI Chat UI section)
    settingsStealthScreenCaptureEl?.addEventListener('change', () => {
      const enabled = settingsStealthScreenCaptureEl?.checked ?? true
      window.electronAPI.prefsUpdate({ stealthScreenCaptureBlock: enabled }).catch(() => { })
    })

    settingsStealthClickThroughEl?.addEventListener('change', () => {
      const enabled = settingsStealthClickThroughEl?.checked ?? true
      window.electronAPI.prefsUpdate({ stealthClickThrough: enabled }).catch(() => { })
    })

    settingsStealthDarkThemeEl?.addEventListener('change', () => {
      const enabled = settingsStealthDarkThemeEl?.checked ?? true
      window.electronAPI.prefsUpdate({ stealthDarkTheme: enabled }).catch(() => { })
    })

    settingsChatOverlayHoverableEl?.addEventListener('change', () => {
      const enabled = settingsChatOverlayHoverableEl?.checked ?? false
      window.electronAPI.prefsUpdate({ chatOverlayHoverable: enabled }).catch(() => { })
    })

    settingsChatOverlayMinimalEl?.addEventListener('change', () => {
      const enabled = settingsChatOverlayMinimalEl?.checked ?? false
      window.electronAPI.prefsUpdate({ chatOverlayMinimal: enabled }).catch(() => { })
    })

    settingsChatOverlayTextCursorEl?.addEventListener('change', () => {
      const enabled = settingsChatOverlayTextCursorEl?.checked ?? false
      window.electronAPI.prefsUpdate({ chatOverlayTextCursor: enabled }).catch(() => { })
    })


    // Personalization: AI Style Mode
    const updateAiStyleMode = () => {
      let mode: 'professional' | 'casual' | 'concise' | 'custom' = 'professional'
      if (aiStyleProfessionalEl?.checked) mode = 'professional'
      else if (aiStyleCasualEl?.checked) mode = 'casual'
      else if (aiStyleConciseEl?.checked) mode = 'concise'
      else if (aiStyleCustomRadioEl?.checked) mode = 'custom'

      window.electronAPI.prefsUpdate({ aiStyleMode: mode } as any).catch(() => { })

      // Show/hide custom textarea
      if (aiStyleCustomBoxEl) {
        aiStyleCustomBoxEl.style.display = mode === 'custom' ? 'block' : 'none'
      }
    }

    aiStyleProfessionalEl?.addEventListener('change', updateAiStyleMode)
    aiStyleCasualEl?.addEventListener('change', updateAiStyleMode)
    aiStyleConciseEl?.addEventListener('change', updateAiStyleMode)
    aiStyleCustomRadioEl?.addEventListener('change', updateAiStyleMode)

    aiStyleCustomEl?.addEventListener('input', () => {
      if (aiStyleCustomEl) {
        window.electronAPI.prefsUpdate({ aiStyleCustom: aiStyleCustomEl.value } as any).catch(() => { })
      }
    })

    // Personalization: Shortcuts
    addShortcutBtn?.addEventListener('click', async () => {
      if (!shortcutTriggerEl || !shortcutReplacementEl) return
      const trigger = shortcutTriggerEl.value.trim()
      const replacement = shortcutReplacementEl.value.trim()
      if (!trigger || !replacement) return

      const result = await window.electronAPI.prefsGet()
      if (!result.ok || !result.prefs) return

      const shortcuts = [...(result.prefs.shortcuts || []), { trigger, replacement }]
      await window.electronAPI.prefsUpdate({ shortcuts } as any)

      shortcutTriggerEl.value = ''
      shortcutReplacementEl.value = ''
      loadShortcuts()
    })

    addTemplateBtn?.addEventListener('click', () => {
      if (!templateNameEl || !templateTextareaBoxEl) return
      const name = templateNameEl.value.trim()
      if (!name) return

      editingTemplate = null
      templateTextareaBoxEl.style.display = 'block'
      templateNameEl.disabled = true
    })

    saveTemplateBtn?.addEventListener('click', async () => {
      if (!templateNameEl || !templatePromptEl || !templateTextareaBoxEl) return
      const name = templateNameEl.value.trim()
      const prompt = templatePromptEl.value.trim()
      if (!name || !prompt) return

      const result = await window.electronAPI.prefsGet()
      if (!result.ok || !result.prefs) return

      let templates = [...(result.prefs.meetingTemplates || [])]

      if (editingTemplate !== null) {
        // Edit existing template
        templates[editingTemplate] = { name, prompt }
      } else {
        // Add new template
        templates.push({ name, prompt })
      }

      await window.electronAPI.prefsUpdate({ meetingTemplates: templates } as any)

      templateNameEl.value = ''
      templatePromptEl.value = ''
      templateTextareaBoxEl.style.display = 'none'
      templateNameEl.disabled = false
      editingTemplate = null
      renderTemplates()
    })

    cancelTemplateBtn?.addEventListener('click', () => {
      if (!templateNameEl || !templatePromptEl || !templateTextareaBoxEl) return
      templateNameEl.value = ''
      templatePromptEl.value = ''
      templateTextareaBoxEl.style.display = 'none'
      templateNameEl.disabled = false
      editingTemplate = null
    })

    // Reset stats button in Settings
    settingsStatResetBtn?.addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all statistics? This cannot be undone.')) {
        resetStats()
      }
    })

    // Reset Shortcuts Logic
    resetShortcutsBtn?.addEventListener('click', () => {
      if (resetShortcutsModal) resetShortcutsModal.style.display = 'flex'
    })

    resetShortcutsCancelBtn?.addEventListener('click', () => {
      if (resetShortcutsModal) resetShortcutsModal.style.display = 'none'
    })

    resetShortcutsConfirmBtn?.addEventListener('click', async () => {
      appendProgress('Resetting shortcuts...')
      const result = await window.electronAPI.shortcutsReset()
      if (result.ok) {
        // Reload shortcuts in UI
        loadShortcuts()
        if (resetShortcutsModal) resetShortcutsModal.style.display = 'none'
      } else {
        alert('Failed to reset shortcuts: ' + (result.message || 'Unknown error'))
      }
    })
  }




  // Keyboard Shortcuts (System)
  const shortcutsContainer = document.getElementById('shortcutsContainer')
  if (shortcutsContainer) {
    // Define system shortcuts
    const appShortcuts = [
      { label: 'Toggle Dictation', keys: 'Alt+D', id: 'toggle-dictation' },
      { label: 'Agentic Dictation Overlay', keys: 'Alt+A', id: 'agentic-overlay' },
      { label: 'AI Chat Overlay', keys: 'Alt+C', id: 'chat-overlay' },
      { label: 'Capture Screenshot', keys: 'Alt+S', id: 'screenshot' }
    ]

    shortcutsContainer.innerHTML = appShortcuts.map(s => `
      <div class="shortcut-item" style="padding: 6px 0;">
        <div class="shortcut-item-content" style="gap: 12px; display: flex; align-items: center;">
          <div class="shortcut-item-replacement" style="font-size: 13px; color: var(--text-primary); flex: 1;">${s.label}</div>
          <div class="shortcut-item-trigger" style="font-family: var(--font-mono); font-size: 12px; padding: 2px 6px; background: var(--bg-secondary); border-radius: 4px; border: 1px solid var(--border);">${s.keys}</div>
        </div>
        <div class="shortcut-item-actions">
           <button class="shortcut-edit-btn" title="Edit Shortcut" style="padding: 4px; height: 24px; width: 24px; color: var(--text-muted); background: transparent; border: none; cursor: pointer;">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
               <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
             </svg>
           </button>
        </div>
      </div>
      `).join('')
  }

  async function renderTemplates() {
    const result = await window.electronAPI.prefsGet()
    if (!result.ok || !result.prefs || !templatesListEl) return

    const templates = result.prefs.meetingTemplates || []
    if (templates.length === 0) {
      templatesListEl.innerHTML = ''
      return
    }

    templatesListEl.textContent = ''
    templates.forEach((t: any, i: number) => {
      const itemEl = document.createElement('div')
      itemEl.className = 'template-item'

      const headerEl = document.createElement('div')
      headerEl.className = 'template-item-header'

      const nameEl = document.createElement('div')
      nameEl.className = 'template-item-name'
      nameEl.textContent = t.name

      const actionsEl = document.createElement('div')
      actionsEl.className = 'template-item-actions'

      const editBtn = document.createElement('button')
      editBtn.className = 'small template-edit'
      editBtn.setAttribute('data-index', String(i))
      editBtn.textContent = 'Edit'

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'small danger template-delete'
      deleteBtn.setAttribute('data-index', String(i))
      deleteBtn.textContent = 'Delete'

      actionsEl.appendChild(editBtn)
      actionsEl.appendChild(deleteBtn)

      headerEl.appendChild(nameEl)
      headerEl.appendChild(actionsEl)

      const promptEl = document.createElement('div')
      promptEl.className = 'template-item-prompt'
      promptEl.textContent = t.prompt

      itemEl.appendChild(headerEl)
      itemEl.appendChild(promptEl)

      templatesListEl.appendChild(itemEl)
    })

    // Add edit/delete handlers
    templatesListEl.querySelectorAll('.template-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = Number(btn.getAttribute('data-index'))
        const result = await window.electronAPI.prefsGet()
        if (!result.ok || !result.prefs) return
        const template = result.prefs.meetingTemplates[index]
        if (!template || !templateNameEl || !templatePromptEl || !templateTextareaBoxEl) return

        editingTemplate = index
        templateNameEl.value = template.name
        templatePromptEl.value = template.prompt
        templateTextareaBoxEl.style.display = 'block'
        templateNameEl.disabled = true
      })
    })

    templatesListEl.querySelectorAll('.template-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = Number(btn.getAttribute('data-index'))
        const result = await window.electronAPI.prefsGet()
        if (!result.ok || !result.prefs) return
        const templates = [...(result.prefs.meetingTemplates || [])]
        templates.splice(index, 1)
        await window.electronAPI.prefsUpdate({ meetingTemplates: templates } as any)
        renderTemplates()
      })
    })
  }

  // ---- Ignored Mic Apps UI ----
  const meetingAppsListEl = document.getElementById('meetingAppsList') as HTMLElement | null
  const meetingAppInputEl = document.getElementById('meetingAppInput') as HTMLInputElement | null
  const addMeetingAppBtn = document.getElementById('addMeetingApp') as HTMLButtonElement | null

  async function renderMeetingApps() {
    if (!meetingAppsListEl) return

    try {
      // Get reference apps and ignored apps
      const [defaultsRes, customRes] = await Promise.all([
        window.electronAPI.meetingAppsGetDefaults(),
        window.electronAPI.meetingAppsGetCustom()
      ])

      if (!defaultsRes.ok) {
        console.error('Failed to load default meeting apps:', defaultsRes.message)
        return
      }

      const categories = defaultsRes.categories || []
      const customApps = customRes.ok ? (customRes.ignoredApps || customRes.customApps || []) : []

      // Build the list HTML
      let html = ''

      // Default apps (grouped by category)
      if (categories.length > 0) {
        html += `<div class="meeting-apps-defaults" style="margin-bottom:16px;">`
        html += `<div style="font-size:12px; font-weight:500; color:var(--text-secondary); margin-bottom:8px;">Reference Meeting Apps</div>`
        html += `<div style="display:flex; flex-wrap:wrap; gap:6px;">`
        for (const cat of categories) {
          // Capitalize first letter
          const display = cat.charAt(0).toUpperCase() + cat.slice(1)
          html += `<span class="meeting-app-tag default" style="display:inline-block; padding:4px 8px; background:var(--bg-secondary); border-radius:4px; font-size:11px; color:var(--text-secondary);">${escapeHtml(display)}</span>`
        }
        html += `</div></div>`
      }

      // Custom apps
      if (customApps.length > 0) {
        html += `<div class="meeting-apps-custom">`
        html += `<div style="font-size:12px; font-weight:500; color:var(--text-secondary); margin-bottom:8px;">Ignored Apps</div>`
        html += `<div style="display:flex; flex-wrap:wrap; gap:6px;">`
        for (const app of customApps) {
          html += `
            <span class="meeting-app-tag custom" style="display:inline-flex; align-items:center; gap:4px; padding:4px 8px; background:var(--primary); border-radius:4px; font-size:11px; color:white;">
              ${escapeHtml(app)}
              <button class="meeting-app-remove" data-app="${escapeHtml(app)}" style="background:none; border:none; color:white; cursor:pointer; padding:0; line-height:1; opacity:0.8;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </span>`
        }
        html += `</div></div>`
      }

      meetingAppsListEl.innerHTML = html

      // Add remove handlers
      meetingAppsListEl.querySelectorAll('.meeting-app-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          const appName = btn.getAttribute('data-app')
          if (!appName) return
          const result = await window.electronAPI.meetingAppsRemoveCustom(appName)
          if (result.ok) {
            renderMeetingApps()
          } else {
            console.error('Failed to remove app:', result.message)
          }
        })
      })
    } catch (e) {
      console.error('Error rendering meeting apps:', e)
    }
  }

  // Add app handler
  addMeetingAppBtn?.addEventListener('click', async () => {
    if (!meetingAppInputEl) return
    const appName = meetingAppInputEl.value.trim()
    if (!appName) return

    const result = await window.electronAPI.meetingAppsAddCustom(appName)
    if (result.ok) {
      meetingAppInputEl.value = ''
      renderMeetingApps()
    } else {
      // Show error (could add toast notification here)
      console.error('Failed to add app:', result.message)
    }
  })

  // Enter key to add
  meetingAppInputEl?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addMeetingAppBtn?.click()
    }
  })

  // Initial render
  renderMeetingApps()

  bindSettingsControls()

  // Sync personal notes with float window
  const setMeetingNotesDraft = (content: string) => {
    meetingNotesDraft = content || ''
  }

  if (personalNotesEl) {
    let notesUpdateTimeout: ReturnType<typeof setTimeout> | null = null
    personalNotesEl.addEventListener('input', () => {
      if (notesUpdateTimeout) clearTimeout(notesUpdateTimeout)
      notesUpdateTimeout = setTimeout(() => {
        if (personalNotesEl) {
          setMeetingNotesDraft(personalNotesEl.value)
            ; (window as any).notes?.updateContent?.(personalNotesEl.value).catch(() => { })
        }
      }, 300)
    })

      // Listen for updates from float window
      ; (window as any).notes?.getContent?.().then((result: any) => {
        if (result?.ok && personalNotesEl) {
          personalNotesEl.value = result.content || ''
          setMeetingNotesDraft(personalNotesEl.value)
        }
      }).catch(() => { })

    // Listen for content updates from other sources
    if ((window as any).notes?.onContentUpdated) {
      (window as any).notes.onContentUpdated((content: string) => {
        if (personalNotesEl && personalNotesEl.value !== content) {
          personalNotesEl.value = content
        }
        setMeetingNotesDraft(content)
      })
    }
  } else {
    ; (window as any).notes?.getContent?.().then((result: any) => {
      if (result?.ok) {
        setMeetingNotesDraft(result.content || '')
      }
    }).catch(() => { })

    if ((window as any).notes?.onContentUpdated) {
      (window as any).notes.onContentUpdated((content: string) => {
        setMeetingNotesDraft(content)
      })
    }
  }

  // Stream progress lines from main
  window.progress?.onLog((m) => { appendProgress(m); if (setupLog) { setupLog.textContent = (setupLog.textContent ? setupLog.textContent + '\n' : '') + m; setupLog.scrollTop = setupLog.scrollHeight } })

  // Sidebar collapse state
  const savedSidebar = localStorage.getItem('sidebar_collapsed')
  if (savedSidebar === '1') {
    document.body.classList.add('sidebar-collapsed')
  }
  sidebarToggle?.addEventListener('click', () => {
    const wasCollapsed = document.body.classList.toggle('sidebar-collapsed')
    localStorage.setItem('sidebar_collapsed', wasCollapsed ? '1' : '0')
  })

  // Formatting helpers for transcript preview
  function fmtTime(t: number) {
    if (typeof t !== 'number' || !isFinite(t)) return ''
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    const ms = Math.floor((t - Math.floor(t)) * 1000)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  }
  function renderSegments(box: HTMLElement, segs: any[]) {
    // Uniform transcript look (no timestamps). Include speaker label if available.
    box.textContent = segs.map((s: any) => {
      const spk = s.speaker ? `${s.speaker}: ` : ''
      const txt = (s.text ?? '').trim()
      return `${spk}${txt}`.trim()
    }).join('\n')
  }

  // Helpers: Notes
  let lastTranscriptText = ''

  async function transcribeRecording(recordingId: string, opts: { deleteInput?: boolean; isMeetingMode?: boolean; isAIMode?: boolean }) {
    return await window.electronAPI.apiTranscribe(recordingId, {
      deleteInput: opts.deleteInput,
      isMeetingMode: opts.isMeetingMode,
      isAIMode: opts.isAIMode
    }) as { ok: true; text: string } | { ok: false; message: string; details?: string }
  }

  function renderSidebarNotes(items: { id: string; name: string }[]) {
    try {
      if (!notesSubtree) return
      const top = items.slice(0, 10)
      notesSubtree.innerHTML = top.map(it => `<li class="sub-item nav-item" data-id="${escapeHtmlAttr(it.id)}"><span class="sub-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>${escapeHtml(it.name)}</li>`).join('')
      notesSubtree.querySelectorAll('li.sub-item').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          const id = (el as HTMLElement).getAttribute('data-id')!
          setView('notes')
          loadNoteById(id)
        })
      })
    } catch { }
  }
  let lastSummaryMd = ''
  function getNotesText(): string {
    const value = personalNotesEl ? personalNotesEl.value : meetingNotesDraft
    return (value || '').trim()
  }
  let keepRecordings = false
  function generateSessionTitle(transcript: string, fallback: string = 'Session'): string {
    const t = (transcript || '').replace(/\s+/g, ' ').trim()
    if (!t) return fallback
    const candidate = t.split(' ').slice(0, 8).join(' ')
    const cleaned = normalizeTitle(candidate)
    return cleaned || candidate
  }
  async function autoCreateNote(summaryMd: string, transcriptText: string, durationSeconds: number = 0) {
    try {
      let title = generateSessionTitle(transcriptText, 'Session')
      const normalized = normalizeSummary(summaryMd)
      if (normalized.title) {
        title = normalized.title
      }
      const cleanSummary = normalized.summary

      const notesContent = getNotesText()
      console.log('Auto-creating note with personal notes:', notesContent)
      const res = await window.electronAPI.notesCreate({ title, summary: cleanSummary, transcript: transcriptText || '', notes: notesContent })
      if (res.ok) {
        // Log activity with the final title
        if (transcriptText) {
          addActivityLog(title, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>', 'meeting', transcriptText, durationSeconds);
        }

        // If Notes view exists, refresh and select the new note
        if (typeof refreshNotes === 'function') {
          await refreshNotes()
        }
      }
    } catch { }
  }


  // Activity tracking system
  interface ActivityLog {
    timestamp: number
    text: string
    icon: string
    type?: 'dictation' | 'meeting' | 'other'  // Track activity type
    fullText?: string  // Store full text for copy functionality
    full_text?: string
    durationSeconds?: number  // Track duration for meetings
    duration_seconds?: number
  }

  interface Stats {
    meetingsTranscripted: number
    wordsDictated: number
    totalDictationTimeSeconds: number // Track total time spent dictating
  }

  interface DictationSession {
    startTime: number
    endTime: number
    wordCount: number
  }

  function getActivityLogs(): ActivityLog[] {
    // This is now just a placeholder - actual data comes from file via IPC
    try {
      const logs = localStorage.getItem('activity_logs')
      return logs ? JSON.parse(logs) : []
    } catch {
      return []
    }
  }

  function saveActivityLogs(logs: ActivityLog[]) {
    // Save to localStorage for backwards compatibility, but also sync to file
    try {
      const trimmed = logs.slice(-100)
      localStorage.setItem('activity_logs', JSON.stringify(trimmed))
    } catch { }
  }

  function addActivityLog(text: string, icon: string, type: 'dictation' | 'meeting' | 'other' = 'other', fullText?: string, durationSeconds?: number) {
    // Use new file-based API
    window.electronAPI.activityAdd({ text, icon, type, fullText: fullText || text, durationSeconds })
      .then(() => renderActivityLogs())
      .catch(() => { })
  }

  function formatTime(timestamp: number, showDate: boolean = false): string {
    const date = new Date(timestamp)
    // Show date for older items (after "Yesterday" category)
    if (showDate) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  }

  function formatDuration(seconds: number): string {
    if (!seconds || seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    if (mins < 60) {
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
    }
    const hours = Math.floor(mins / 60)
    const remainingMins = mins % 60
    if (remainingMins > 0) {
      return `${hours}h ${remainingMins}m`
    }
    return `${hours}h`
  }

  function getTimeSeparator(timestamp: number): string | null {
    const now = new Date()
    const date = new Date(timestamp)
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    const isToday = now.toDateString() === date.toDateString()
    const isYesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toDateString() === date.toDateString()

    if (isToday) return 'Today'
    if (isYesterday) return 'Yesterday'
    if (diffDays <= 7) return 'Last Week'
    if (diffDays <= 30) return 'Last Month'
    return 'Older'
  }

  function renderActivityLogs() {
    if (!activityList) return

    // Show skeleton loading state if the list is empty (initial load)
    const isInitialLoad = activityList.innerHTML.trim() === '' || activityList.querySelector('.activity-skeleton')
    if (isInitialLoad) {
      activityList.innerHTML = `
        <div class="activity-skeleton">
          <div class="activity-skeleton-item">
            <div class="skeleton-line skeleton-time"></div>
            <div class="skeleton-line skeleton-text"></div>
          </div>
          <div class="activity-skeleton-item">
            <div class="skeleton-line skeleton-time"></div>
            <div class="skeleton-line skeleton-text-short"></div>
          </div>
          <div class="activity-skeleton-item">
            <div class="skeleton-line skeleton-time"></div>
            <div class="skeleton-line skeleton-text"></div>
          </div>
        </div>
      `
    }

    // Load from file-based storage
    window.electronAPI.activityGet().then(res => {
      if (!res.ok) {
        const errorMsg = res.message || 'Failed to load activities'
        console.error('Failed to load activities:', errorMsg)
        activityList.innerHTML = `<div class="activity-section activity-list-fade-in" style="padding: var(--space-4);"><div class="activity-item"><div class="activity-time"></div><div class="activity-text" style="color: var(--text-muted);">${escapeHtml(errorMsg)}</div></div></div>`
        return
      }

      const logs = res.logs || []

      // Filter to only show dictation and meeting activities
      const relevantLogs = logs.filter((log: ActivityLog) => log.type === 'dictation' || log.type === 'meeting')

      if (relevantLogs.length === 0) {
        activityList.innerHTML = '<div class="activity-section activity-list-fade-in" style="padding: var(--space-4);"><div class="activity-item"><div class="activity-time"></div><div class="activity-text" style="color: var(--text-muted);">No activity yet</div></div></div>'
        return
      }

      // Group logs by time separator
      // Sort logs by timestamp descending (newest first) to ensure correct order
      const sortedLogs = [...relevantLogs].sort((a, b) => b.timestamp - a.timestamp)
      const grouped: { separator: string; logs: ActivityLog[] }[] = []
      let currentSeparator: string | null = null
      let currentGroup: ActivityLog[] = []

      sortedLogs.forEach((log: ActivityLog) => {
        const separator = getTimeSeparator(log.timestamp)
        if (separator !== currentSeparator) {
          if (currentGroup.length > 0) {
            grouped.push({ separator: currentSeparator!, logs: [...currentGroup] })
          }
          currentSeparator = separator
          currentGroup = [log]
        } else {
          currentGroup.push(log)
        }
      })

      if (currentGroup.length > 0 && currentSeparator) {
        grouped.push({ separator: currentSeparator, logs: currentGroup })
      }

      // Render grouped logs with fade-in animation
      activityList.innerHTML = grouped.map(group => {
        // Show dates instead of times for categories after "Yesterday"
        const showDate = group.separator !== 'Today' && group.separator !== 'Yesterday'
        return `
        <div class="activity-section activity-list-fade-in">
          <div class="activity-separator">${group.separator}</div>
          ${group.logs.map((log: ActivityLog, idx: number) => {
          const fullText = log.fullText ?? log.full_text ?? log.text
          const displayText = stripMarkdown(fullText)
            .replace(/^(Dictated|Meeting|Agentic Dictation):\s*/, '')
            .replace(/\s+/g, ' ')
            .trim()
          const durationSeconds = log.durationSeconds ?? log.duration_seconds
          return `
            <div class="activity-item" data-log-idx="${idx}" data-log-timestamp="${log.timestamp}">
              <div class="activity-time">${formatTime(log.timestamp, showDate)}</div>
              <div class="activity-content">
                <div class="activity-text">
                  ${log.icon}<span class="activity-text-content">${escapeHtml(displayText)}</span>
                  ${log.type === 'meeting' && durationSeconds ? `<span class="activity-duration">${formatDuration(durationSeconds)}</span>` : ''}
                </div>
                <div class="activity-actions">
                  <button class="activity-btn activity-copy" title="Copy" data-text="${escapeHtml(fullText)}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                  <button class="activity-btn activity-delete" title="Delete" data-timestamp="${log.timestamp}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>
            </div>
          `
        }).join('')}
        </div>
        `
      }).join('')

      // Add event listeners for copy and delete buttons
      activityList.querySelectorAll('.activity-copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const text = (btn as HTMLElement).getAttribute('data-text') || ''
          navigator.clipboard.writeText(text).then(() => {
            // Visual feedback (brief icon swap + title)
            const buttonEl = btn as (HTMLButtonElement & { _copyFeedbackTimeoutId?: number })

            const originalTitle = buttonEl.getAttribute('data-original-title') ?? buttonEl.title
            buttonEl.setAttribute('data-original-title', originalTitle)

            const originalIcon = buttonEl.getAttribute('data-original-icon') ?? buttonEl.innerHTML
            buttonEl.setAttribute('data-original-icon', originalIcon)

            const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'

            buttonEl.title = 'Copied!'
            buttonEl.classList.add('is-copied')
            buttonEl.innerHTML = checkIcon

            if (buttonEl._copyFeedbackTimeoutId) {
              window.clearTimeout(buttonEl._copyFeedbackTimeoutId)
            }

            buttonEl._copyFeedbackTimeoutId = window.setTimeout(() => {
              buttonEl.title = originalTitle
              buttonEl.classList.remove('is-copied')
              buttonEl.innerHTML = originalIcon
            }, 900)
          }).catch(() => { })
        })
      })

      activityList.querySelectorAll('.activity-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          const timestamp = parseInt((btn as HTMLElement).getAttribute('data-timestamp') || '0')
          if (timestamp) {
            window.electronAPI.activityDelete(timestamp)
              .then(() => renderActivityLogs())
              .catch(() => { })
          }
        })
      })
    }).catch(() => {
      activityList.innerHTML = '<div class="activity-section activity-list-fade-in" style="padding: var(--space-4);"><div class="activity-item"><div class="activity-time"></div><div class="activity-text" style="color: var(--text-muted);">Error loading activities</div></div></div>'
    })
  }

  function escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  function stripMarkdown(text: string): string {
    if (!text) return ''
    return text
      .replace(/!\[.*?\]\(.*?\)/g, '') // Images
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // Links
      .replace(/#{1,6}\s+/g, '') // Headers
      .replace(/(\*\*|__|[*_])(.*?)\1/g, '$2') // Bold/Italic
      .replace(/`{1,3}(.*?)`{1,3}/gs, '$1') // Code
      .replace(/^\s*>\s+/gm, '') // Blockquotes
      .replace(/^\s*[-*+]\s+/gm, '') // Lists
      .replace(/^\s*\d+\.\s+/gm, '') // Numbered lists
      .replace(/\r?\n/g, ' ') // Newlines to spaces
      .replace(/\s+/g, ' ') // Collapse spaces
      .trim();
  }

  // Format timestamped transcripts with speaker labels for better display
  function formatTimestampedTranscript(text: string): string {
    // Check if text contains timestamp/speaker format: [MM:SS-MM:SS] Speaker X:
    const hasTimestamps = /\[\d{1,2}:\d{2}-\d{1,2}:\d{2}\]\s*Speaker\s+[A-Z]:/i.test(text)

    if (!hasTimestamps) {
      // Plain transcript - just escape and preserve whitespace
      return escapeHtml(text)
    }

    // Split by lines and format each line with timestamps and speaker labels
    const lines = text.split('\n')
    const formatted = lines.map(line => {
      // Match pattern: [MM:SS-MM:SS] Speaker X: text
      const match = line.match(/^(\[\d{1,2}:\d{2}-\d{1,2}:\d{2}\])\s*(Speaker\s+[A-Z]):\s*(.*)$/i)
      if (match) {
        const timestamp = escapeHtml(match[1])
        const speaker = escapeHtml(match[2])
        const content = escapeHtml(match[3])
        return `<span style="color: var(--muted); font-weight: 500;">${timestamp}</span> <span style="color: var(--accent); font-weight: 600;">${speaker}:</span> ${content}`
      }
      return escapeHtml(line)
    })

    return formatted.join('\n')
  }

  function getStats(): Stats {
    // Placeholder - actual data should come from file
    try {
      const stats = localStorage.getItem('stats')
      return stats ? JSON.parse(stats) : { meetingsTranscripted: 0, wordsDictated: 0, totalDictationTimeSeconds: 0 }
    } catch {
      return { meetingsTranscripted: 0, wordsDictated: 0, totalDictationTimeSeconds: 0 }
    }
  }

  function saveStats(stats: Stats) {
    // Save to localStorage for backwards compatibility
    try {
      localStorage.setItem('stats', JSON.stringify(stats))
    } catch { }
  }

  function updateStats(wordsDictated: number = 0, dictationTimeSeconds: number = 0) {
    // Use new file-based API
    window.electronAPI.statsUpdate({ wordsDictated, dictationTimeSeconds })
      .then(() => renderStats())
      .catch(() => { })
  }

  function resetStats() {
    // Use new file-based API
    window.electronAPI.statsReset()
      .then(() => {
        localStorage.removeItem('stats') // Clear localStorage too
        renderStats()
      })
      .catch(() => { })
  }

  function formatNumber(num: number): string {
    if (num < 1000) return num.toFixed(0)
    if (num < 1000000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  function renderStats() {
    // Load from file-based storage
    window.electronAPI.statsGet().then(res => {
      if (!res.ok) return

      const stats = res.stats || { meetingsTranscripted: 0, wordsDictated: 0, totalDictationTimeSeconds: 0 }
      const wpmEl = document.getElementById('statWPMValue')
      const meetingsEl = document.getElementById('statMeetingsValue')
      const wordsDictatedEl = document.getElementById('statWordsDictatedValue')

      // Calculate WPM
      const wpm = stats.totalDictationTimeSeconds > 0
        ? Math.round((stats.wordsDictated / stats.totalDictationTimeSeconds) * 60)
        : 0

      if (wpmEl) {
        wpmEl.textContent = wpm.toString()
      }

      if (meetingsEl) {
        meetingsEl.textContent = formatNumber(stats.meetingsTranscripted || 0)
      }

      if (wordsDictatedEl) {
        wordsDictatedEl.textContent = formatNumber(stats.wordsDictated)
      }

      // Update modal values
      const statsModalWPM = document.getElementById('statsModalWPM')
      const statsModalDictated = document.getElementById('statsModalDictated')
      const statsModalMeetings = document.getElementById('statsModalMeetings')

      if (statsModalWPM) {
        statsModalWPM.textContent = `${wpm} WPM`
      }

      if (statsModalDictated) {
        statsModalDictated.textContent = `${formatNumber(stats.wordsDictated)} words`
      }

      if (statsModalMeetings) {
        const meetings = stats.meetingsTranscripted || 0
        statsModalMeetings.textContent = meetings === 1 ? '1 meeting' : `${meetings} meetings`
      }
    }).catch(() => { })
  }

  function formatTrainerMetric(value: number | null, suffix: string = ''): string {
    if (value == null || !Number.isFinite(value)) return 'N/A'
    const rounded = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
    return `${rounded}${suffix}`
  }

  function renderTrainerList(target: HTMLElement | null, items: string[], emptyText: string) {
    if (!target) return
    if (!Array.isArray(items) || items.length === 0) {
      target.textContent = emptyText
      return
    }
    target.innerHTML = items.map((item) => `• ${escapeHtml(item)}`).join('<br>')
  }

  function setSpeakingTrainerLoading(active: boolean) {
    if (speakingTrainerLoading) speakingTrainerLoading.style.display = active ? 'flex' : 'none'
  }

  function renderSpeakingTrainerEmptyState() {
    if (speakingTrainerEmpty) speakingTrainerEmpty.style.display = 'flex'
    if (speakingTrainerContent) speakingTrainerContent.style.display = 'none'
    if (speakingTrainerSelect) {
      speakingTrainerSelect.innerHTML = '<option value="">No transcript-backed notes yet</option>'
      speakingTrainerSelect.disabled = true
    }
    if (speakingTrainerHeadline) speakingTrainerHeadline.textContent = 'Pick a meeting to generate coaching.'
    if (speakingTrainerSummary) {
      speakingTrainerSummary.textContent = 'The trainer will combine transcript heuristics with AI coaching once a transcript-backed note is selected.'
    }
    renderTrainerList(speakingTrainerStrengths, [], 'No analysis yet.')
    renderTrainerList(speakingTrainerImprovements, [], 'No analysis yet.')
    renderTrainerList(speakingTrainerDrills, [], 'No analysis yet.')
  }

  function renderSpeakingTrainerMetrics(analysis: SpeakingTrainerNoteAnalysis, trends: SpeakingTrainerTrends | null) {
    if (trainerMetricFillersValue) trainerMetricFillersValue.textContent = formatTrainerMetric(analysis.metrics.fillersPer100Words)
    if (trainerMetricFillersSub) trainerMetricFillersSub.textContent = `${analysis.metrics.fillerCount} fillers in ${analysis.metrics.wordCount} words`
    if (trainerMetricFillersTrend) trainerMetricFillersTrend.textContent = `Across notes: ${formatTrainerMetric(trends?.avgFillerRate ?? null)}`

    if (trainerMetricQuestionsValue) trainerMetricQuestionsValue.textContent = formatTrainerMetric(analysis.metrics.questionsPer100Words)
    if (trainerMetricQuestionsSub) trainerMetricQuestionsSub.textContent = `${analysis.metrics.questionCount} questions in ${analysis.metrics.wordCount} words`
    if (trainerMetricQuestionsTrend) trainerMetricQuestionsTrend.textContent = `Across notes: ${formatTrainerMetric(trends?.avgQuestionRate ?? null)}`

    if (trainerMetricTurnsValue) trainerMetricTurnsValue.textContent = formatTrainerMetric(analysis.metrics.longestTurnWords)
    if (trainerMetricTurnsSub) {
      trainerMetricTurnsSub.textContent = analysis.metrics.turnCount == null || analysis.metrics.avgTurnWords == null
        ? 'Speaker turns unavailable in this transcript'
        : `${analysis.metrics.turnCount} turns • avg ${formatTrainerMetric(analysis.metrics.avgTurnWords)} words`
    }
    if (trainerMetricTurnsTrend) trainerMetricTurnsTrend.textContent = `Across notes: ${formatTrainerMetric(trends?.avgLongestTurnWords ?? null)}`

    if (trainerMetricPaceValue) trainerMetricPaceValue.textContent = formatTrainerMetric(analysis.metrics.paceWpm)
    if (trainerMetricPaceSub) {
      trainerMetricPaceSub.textContent = analysis.metrics.paceWpm == null
        ? 'No timestamps available for pace'
        : `${analysis.metrics.wordCount} words across timestamped transcript`
    }
    if (trainerMetricPaceTrend) trainerMetricPaceTrend.textContent = `Across notes: ${formatTrainerMetric(trends?.avgPaceWpm ?? null)}`
  }

  function renderSpeakingTrainerAnalysis(analysis: SpeakingTrainerNoteAnalysis) {
    renderSpeakingTrainerMetrics(analysis, speakingTrainerOverview?.trends || null)

    if (speakingTrainerHeadline) {
      speakingTrainerHeadline.textContent = analysis.coaching?.headline || analysis.title
    }
    if (speakingTrainerSummary) {
      speakingTrainerSummary.textContent = analysis.coaching?.summary || analysis.aiError || 'AI coaching is unavailable for this note right now. Heuristic metrics are still shown above.'
    }

    renderTrainerList(speakingTrainerStrengths, analysis.coaching?.strengths || [], 'No strengths returned yet.')
    renderTrainerList(speakingTrainerImprovements, analysis.coaching?.improvements || [], 'No improvement areas returned yet.')
    renderTrainerList(speakingTrainerDrills, analysis.coaching?.drills || [], 'No drills returned yet.')

    if (speakingTrainerEmpty) speakingTrainerEmpty.style.display = 'none'
    if (speakingTrainerContent) speakingTrainerContent.style.display = 'block'
  }

  async function loadSpeakingTrainerAnalysis(noteId: string) {
    if (!noteId) return
    const requestId = Date.now()
    speakingTrainerAnalysisRequest = requestId
    setSpeakingTrainerLoading(true)

    try {
      const result = await window.electronAPI.trainerAnalyzeNote(noteId)
      if (speakingTrainerAnalysisRequest !== requestId) return

      if (!result.ok) {
        throw new Error(result.message || 'Failed to analyze note')
      }

      const analysis = result.analysis as SpeakingTrainerNoteAnalysis
      renderSpeakingTrainerAnalysis(analysis)
    } catch (error: any) {
      if (speakingTrainerHeadline) speakingTrainerHeadline.textContent = 'Analysis unavailable'
      if (speakingTrainerSummary) speakingTrainerSummary.textContent = error?.message || 'Failed to load trainer analysis.'
      renderTrainerList(speakingTrainerStrengths, [], 'No analysis yet.')
      renderTrainerList(speakingTrainerImprovements, [], 'No analysis yet.')
      renderTrainerList(speakingTrainerDrills, [], 'No analysis yet.')
      if (speakingTrainerContent) speakingTrainerContent.style.display = 'block'
      if (speakingTrainerEmpty) speakingTrainerEmpty.style.display = 'none'
    } finally {
      if (speakingTrainerAnalysisRequest === requestId) {
        setSpeakingTrainerLoading(false)
      }
    }
  }

  async function refreshSpeakingTrainerOverview() {
    setSpeakingTrainerLoading(true)
    try {
      const result = await window.electronAPI.trainerGetOverview()
      if (!result.ok) {
        throw new Error(result.message || 'Failed to load Speaking Trainer')
      }

      const overview = result.overview as SpeakingTrainerOverview
      speakingTrainerOverview = overview

      if (!speakingTrainerSelect) return

      if (!overview.notes.length) {
        speakingTrainerCurrentNoteId = null
        renderSpeakingTrainerEmptyState()
        return
      }

      speakingTrainerSelect.disabled = false
      speakingTrainerSelect.innerHTML = overview.notes.map((note) => (
        `<option value="${escapeHtmlAttr(note.id)}">${escapeHtml(note.title)}</option>`
      )).join('')

      if (!speakingTrainerCurrentNoteId || !overview.notes.some((note) => note.id === speakingTrainerCurrentNoteId)) {
        speakingTrainerCurrentNoteId = overview.notes[0].id
      }

      speakingTrainerSelect.value = speakingTrainerCurrentNoteId
      if (speakingTrainerEmpty) speakingTrainerEmpty.style.display = 'none'
      await loadSpeakingTrainerAnalysis(speakingTrainerCurrentNoteId)
    } catch (error: any) {
      renderSpeakingTrainerEmptyState()
      if (speakingTrainerSummary) {
        speakingTrainerSummary.textContent = error?.message || 'Failed to load Speaking Trainer.'
      }
    } finally {
      setSpeakingTrainerLoading(false)
    }
  }

  // Ensure empty notes list initially
  if (notesList) notesList.innerHTML = ''

  // Initialize activity logs and stats
  renderActivityLogs()
  renderStats()
  renderSpeakingTrainerEmptyState()

  // Listen for sync updates
  if (window.electronAPI.onStatsUpdate) {
    window.electronAPI.onStatsUpdate(() => renderStats())
  }
  if (window.electronAPI.onActivityUpdate) {
    window.electronAPI.onActivityUpdate(() => renderActivityLogs())
  }

  // No initial welcome log since we filter to only dictation/meeting activities

  // Auto-route capture: default to mic + system (meeting style)
  currentMode = 'both'
  try { localStorage.setItem('record_mode', 'both') } catch { }

  // Default to streaming capture mode
  const savedCapture = (localStorage.getItem('capture_mode') as 'streaming' | 'batch' | null) || 'streaming'
  if (captureModeSelect) captureModeSelect.value = savedCapture
  if (captureModeSelect) captureModeSelect.addEventListener('change', () => {
    localStorage.setItem('capture_mode', captureModeSelect.value)
  })

  // Window control handlers
  winMin?.addEventListener('click', () => window.windowControls?.minimize())
  winMax?.addEventListener('click', () => window.windowControls?.toggleMaximize())
  winClose?.addEventListener('click', () => window.windowControls?.close())

  // mode controls removed; always 'both'

  // Setup nav + view switching
  function setActiveNav(el: HTMLElement | null) {
    document.querySelectorAll('#sidebar .nav-item').forEach(i => i.classList.remove('active'))
    el?.classList.add('active')
  }
  function setView(view: 'home' | 'notes' | 'chat-notes' | 'speaking-trainer' | 'setup' | 'meetings' | 'settings' | 'dict') {
    if (view === 'speaking-trainer' && !SPEAKING_TRAINER_ENABLED) {
      view = 'home'
    }
    currentView = view
    const homeSection = document.getElementById('homeSection') as HTMLElement | null
    const meetingsSection = document.getElementById('meetingsSection') as HTMLElement | null
    const dictSection = document.getElementById('dictSection') as HTMLElement | null
    const notesSection = document.getElementById('notesSection') as HTMLElement | null
    const chatNotesSection = document.getElementById('chatNotesSection') as HTMLElement | null
    const speakingTrainerSection = document.getElementById('speakingTrainerSection') as HTMLElement | null
    const settingsSection = document.getElementById('settingsSection') as HTMLElement | null

    const sections = [homeSection, notesSection, chatNotesSection, speakingTrainerSection, meetingsSection, dictSection, settingsSection]
    sections.forEach(s => s?.style.setProperty('display', 'none'))

    document.body.classList.remove('view-home', 'view-notes', 'view-chat-notes', 'view-speaking-trainer', 'view-setup', 'view-meetings', 'view-settings')
    document.body.classList.add(`view-${view}`)

    if (view === 'home') {
      setActiveNav(navHome)
      homeSection?.style.removeProperty('display')
    } else if (view === 'notes') {
      setActiveNav(navNotes)
      notesSection?.style.removeProperty('display')
      // Refresh notes and auto-select first note if none selected
      refreshNotes().then(() => {
        const cachedNotes = getNotesCache()
        if (!currentNoteId && cachedNotes.length > 0) {
          loadNoteById(cachedNotes[0].id).catch(() => { })
        }
      }).catch(() => { })
    } else if (view === 'chat-notes') {
      setActiveNav(navChatNotes)
      chatNotesSection?.style.removeProperty('display')
      refreshNotes().then(() => {
        renderChatNotesNoteList()
        renderChatNotesThread()
      }).catch(() => { })
      renderChatNotesThread()
    } else if (view === 'speaking-trainer') {
      setActiveNav(navSpeakingTrainer)
      speakingTrainerSection?.style.removeProperty('display')
      refreshSpeakingTrainerOverview().catch(() => { })
    } else if (view === 'setup') {
      setActiveNav(navHome)
      homeSection?.style.removeProperty('display')
    } else if (view === 'meetings') {
      setActiveNav(navMeetings)
      meetingsSection?.style.removeProperty('display')
      refreshNotes().catch(() => { })
      void renderMeetingNotesList(getNotesCache())
      if (personalNotesEl) personalNotesEl.focus()
    } else if (view === 'dict') {
      setActiveNav(navDict)
      dictSection?.style.removeProperty('display')
    } else if (view === 'settings') {
      setActiveNav(settingsNavBtn)
      settingsSection?.style.removeProperty('display')
    }
  }

  navHome?.addEventListener('click', () => setView('home'))
  navMeetings?.addEventListener('click', () => setView('meetings'))
  navNotes?.addEventListener('click', () => setView('notes'))
  navChatNotes?.addEventListener('click', () => setView('chat-notes'))
  navSpeakingTrainer?.addEventListener('click', () => {
    if (!SPEAKING_TRAINER_ENABLED) {
      setView('home')
      return
    }
    setView('speaking-trainer')
  })
  settingsNavBtn?.addEventListener('click', () => setView('settings'))
  navDict?.addEventListener('click', () => setView('home'))

  speakingTrainerSelect?.addEventListener('change', () => {
    const noteId = speakingTrainerSelect.value
    if (!noteId) return
    speakingTrainerCurrentNoteId = noteId
    loadSpeakingTrainerAnalysis(noteId).catch(() => { })
  })

  chatNotesInput?.addEventListener('input', () => {
    if (chatNotesInput) {
      chatNotesInput.setCustomValidity('')
    }
  })

  chatNotesNoteSearch?.addEventListener('input', () => {
    renderChatNotesNoteList()
  })

  chatNotesInput?.addEventListener('dragover', (event) => {
    event.preventDefault()
  })

  chatNotesInput?.addEventListener('drop', (event) => {
    event.preventDefault()
    const filePaths = extractDesktopFilePaths(event.dataTransfer?.files)
    if (filePaths.length > 0) {
      prepareChatNotesAttachments(filePaths).catch((error) => console.error('Failed to attach dropped files:', error))
    }
  })

  chatNotesInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendChatNotesMessage().catch((error) => console.error('Failed to send Chat with Notes message:', error))
    }
  })

  chatNotesSend?.addEventListener('click', () => {
    sendChatNotesMessage().catch((error) => console.error('Failed to send Chat with Notes message:', error))
  })

  chatNotesAttachBtn?.addEventListener('click', () => {
    openChatNotesAttachmentPicker().catch((error) => console.error('Failed to open file picker:', error))
  })

  chatNotesNewChat?.addEventListener('click', () => {
    startNewChatNotesConversation().catch((error) => console.error('Failed to start Chat with Notes conversation:', error))
  })
  // Hero Card Buttons
  const heroShortcutsEditBtn = document.getElementById('heroShortcutsEditBtn')

  heroShortcutsEditBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    setView('settings')
    // Small delay to ensure view switch happened before scrolling
    setTimeout(() => {
      const shortcutsSection = document.getElementById('shortcutsContainer')
      if (shortcutsSection) {
        shortcutsSection.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // Highlight the section briefly
        shortcutsSection.style.transition = 'background 0.3s ease'
        const originalBg = shortcutsSection.style.background
        shortcutsSection.style.background = 'rgba(59, 130, 246, 0.1)'
        setTimeout(() => {
          shortcutsSection.style.background = originalBg
        }, 1000)
      }
    }, 100)
  })

  let isMeetingRecording = false
  let isMeetingPaused = false

  function resetPauseButton() {
    if (!pauseBtn) return
    const pauseIcon = pauseBtn.querySelector('.pause-icon') as HTMLElement | null
    const resumeIcon = pauseBtn.querySelector('.resume-icon') as HTMLElement | null
    if (pauseIcon) pauseIcon.style.display = 'block'
    if (resumeIcon) resumeIcon.style.display = 'none'
    pauseBtn.classList.remove('paused')
  }

  function updateRecordingControls() {
    const hasStatus = (status?.textContent || '').trim().length > 0
    if (recordingControls) {
      recordingControls.style.display = (isMeetingRecording || hasStatus) ? 'inline-flex' : 'none'
    }
    if (pauseBtn) pauseBtn.style.display = isMeetingRecording ? 'inline-flex' : 'none'
    if (stopBtn) stopBtn.style.display = isMeetingRecording ? 'inline-flex' : 'none'
    if (recordingStatus) {
      const active = isMeetingRecording || isMeetingPaused
      recordingStatus.classList.toggle('inactive', !active)
      recordingStatus.classList.toggle('paused', isMeetingPaused)
    }
  }

  function setHeroStatus(text: string) {
    if (status) status.textContent = text
    updateRecordingControls()
  }

  function setMeetingRecording(active: boolean) {
    isMeetingRecording = active
    isMeetingPaused = false
    resetPauseButton()
    updateRecordingControls()
  }

  function setMeetingPaused(paused: boolean) {
    isMeetingPaused = paused
    if (pauseBtn) {
      const pauseIcon = pauseBtn.querySelector('.pause-icon') as HTMLElement | null
      const resumeIcon = pauseBtn.querySelector('.resume-icon') as HTMLElement | null
      if (pauseIcon) pauseIcon.style.display = paused ? 'none' : 'block'
      if (resumeIcon) resumeIcon.style.display = paused ? 'block' : 'none'
      pauseBtn.classList.toggle('paused', paused)
    }
    updateRecordingControls()
  }

  updateRecordingControls()

  // Streaming state (uses WebM recording with MediaRecorder + Gemini API)
  let streamingActive = false
  let streamingCtx: AudioContext | null = null
  let streamingNode: AudioWorkletNode | null = null
  let streamingMic: MediaStream | null = null
  let streamingSys: MediaStream | null = null
  let streamingWavRecording = false // Legacy WAV mode
  let streamingWebmRecording = false // New WebM mode
  let streamingMediaRecorder: MediaRecorder | null = null
  let streamingRecordingStartTime = 0 // Track when recording started
  let meetingAutoCloseTimeout: ReturnType<typeof setTimeout> | null = null // 4-hour auto-close
  const MEETING_MAX_DURATION_MS = 4 * 60 * 60 * 1000 // 4 hours in milliseconds
  // Minimum captured audio (1 second at 16kHz) worth sending for dictation/AI-mode transcription.
  const MIN_TRANSCRIBE_SAMPLES = 16000
  let activeAudioOwner: 'meeting' | 'dictation' | 'aimode' | null = null
  let meetingAudioActivityAt = 0
  let streamingActivityCtx: AudioContext | null = null
  let streamingActivityAnalyser: AnalyserNode | null = null
  let streamingActivityInterval: ReturnType<typeof setInterval> | null = null

  // Batch state
  let batchActive = false
  let batchCtx: AudioContext | null = null
  let batchNode: AudioWorkletNode | null = null
  let batchMic: MediaStream | null = null
  let batchSys: MediaStream | null = null
  let batchRecordingStartTime = 0 // Track when batch recording started

  function stopMediaStream(stream: MediaStream | null) {
    try {
      if (!stream) return
      stream.getTracks().forEach(track => {
        try { track.stop() } catch { }
      })
    } catch { }
  }

  async function closeAudioContext(ctx: AudioContext | null) {
    if (!ctx) return
    try { await ctx.close() } catch { }
  }

  function acquireAudioOwner(owner: 'meeting' | 'dictation' | 'aimode') {
    if (activeAudioOwner && activeAudioOwner !== owner) {
      return false
    }
    activeAudioOwner = owner
    return true
  }

  function releaseAudioOwner(owner: 'meeting' | 'dictation' | 'aimode') {
    if (activeAudioOwner === owner) {
      activeAudioOwner = null
    }
  }

  function clearAudioActivityInterval() {
    if (streamingActivityInterval) {
      clearInterval(streamingActivityInterval)
      streamingActivityInterval = null
    }
  }

  function resetMeetingAudioActivityTracking() {
    meetingAudioActivityAt = 0
  }

  async function notifyMeetingAudioActivity(force = false) {
    if (isMeetingPaused && !force) return
    const now = Date.now()
    if (!force && !shouldEmitAudioActivity(now, meetingAudioActivityAt)) return
    meetingAudioActivityAt = now
    try {
      await window.electronAPI.meetingUpdateAudioActivity?.()
    } catch { }
  }

  async function startStreamingAudioActivityMonitor(stream: MediaStream) {
    clearAudioActivityInterval()
    if (!stream.getAudioTracks().length) return

    if (streamingActivityCtx) {
      try { await streamingActivityCtx.close() } catch { }
      streamingActivityCtx = null
      streamingActivityAnalyser = null
    }

    streamingActivityCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 } as any)
    const source = streamingActivityCtx.createMediaStreamSource(stream)
    streamingActivityAnalyser = streamingActivityCtx.createAnalyser()
    streamingActivityAnalyser.fftSize = 512
    const silence = streamingActivityCtx.createGain()
    silence.gain.value = 0
    source.connect(streamingActivityAnalyser)
    streamingActivityAnalyser.connect(silence).connect(streamingActivityCtx.destination)

    const levelDataArray = new Uint8Array(streamingActivityAnalyser.fftSize)
    streamingActivityInterval = setInterval(() => {
      if (!streamingActivityAnalyser || isMeetingPaused) return
      try {
        streamingActivityAnalyser.getByteTimeDomainData(levelDataArray)
        if (hasAudibleTimeDomainActivity(levelDataArray)) {
          void notifyMeetingAudioActivity()
        }
      } catch { }
    }, 250)
  }

  async function pauseMeetingCapture() {
    try {
      if (streamingWebmRecording && streamingMediaRecorder?.state === 'recording') {
        streamingMediaRecorder.pause()
      }
    } catch { }
    try {
      if (streamingWavRecording && streamingCtx?.state === 'running') {
        await streamingCtx.suspend()
      }
    } catch { }
    try {
      if (batchActive && batchCtx?.state === 'running') {
        await batchCtx.suspend()
      }
    } catch { }
    try {
      if (streamingActivityCtx?.state === 'running') {
        await streamingActivityCtx.suspend()
      }
    } catch { }
  }

  async function resumeMeetingCapture() {
    try {
      if (streamingWebmRecording && streamingMediaRecorder?.state === 'paused') {
        streamingMediaRecorder.resume()
      }
    } catch { }
    try {
      if (streamingWavRecording && streamingCtx?.state === 'suspended') {
        await streamingCtx.resume()
      }
    } catch { }
    try {
      if (batchActive && batchCtx?.state === 'suspended') {
        await batchCtx.resume()
      }
    } catch { }
    try {
      if (streamingActivityCtx?.state === 'suspended') {
        await streamingActivityCtx.resume()
      }
    } catch { }
    await notifyMeetingAudioActivity(true)
  }

  async function releaseAudioResources(args: {
    recorder?: MediaRecorder | null
    waitForRecorderStop?: boolean
    streams?: Array<MediaStream | null>
    nodes?: Array<{ disconnect: () => void } | null>
    contexts?: Array<AudioContext | null>
  }) {
    try {
      if (args.recorder) {
        try {
          if (args.recorder.state !== 'inactive') {
            if (args.waitForRecorderStop) {
              await new Promise<void>((resolve) => {
                let settled = false
                const finish = () => {
                  if (settled) return
                  settled = true
                  resolve()
                }
                args.recorder!.addEventListener('stop', finish, { once: true })
                args.recorder!.stop()
                setTimeout(finish, 2000)
              })
            } else {
              args.recorder.stop()
            }
          }
        } catch { }
      }
      for (const stream of args.streams || []) {
        stopMediaStream(stream)
      }
      for (const node of args.nodes || []) {
        try { node?.disconnect() } catch { }
      }
      for (const ctx of args.contexts || []) {
        await closeAudioContext(ctx || null)
      }
    } catch { }
  }

  async function cleanupStreamingCapture() {
    clearAudioActivityInterval()
    await releaseAudioResources({
      recorder: streamingMediaRecorder,
      streams: [streamingMic, streamingSys],
      nodes: [streamingNode],
      contexts: [streamingCtx, streamingActivityCtx]
    })
    streamingActive = false
    streamingWavRecording = false
    streamingWebmRecording = false
    streamingMic = null
    streamingSys = null
    streamingNode = null
    streamingCtx = null
    streamingMediaRecorder = null
    streamingActivityCtx = null
    streamingActivityAnalyser = null
    resetMeetingAudioActivityTracking()
    releaseAudioOwner('meeting')
  }

  async function cleanupBatchCapture() {
    clearAudioActivityInterval()
    await releaseAudioResources({
      streams: [batchMic, batchSys],
      nodes: [batchNode],
      contexts: [batchCtx]
    })
    batchActive = false
    batchMic = null
    batchSys = null
    batchNode = null
    batchCtx = null
    resetMeetingAudioActivityTracking()
    releaseAudioOwner('meeting')
  }

  async function startStreamingFlow(): Promise<boolean> {
    if (recordBtn) recordBtn.style.display = 'none'
    if (stopBtn) stopBtn.disabled = false
    setMeetingRecording(true)
    setHeroStatus(`Starting (${currentMode})...`)
    if (progressLog) progressLog.textContent = ''
    if (transcriptBox) transcriptBox.textContent = ''
    updateWidgetRecordingState(true) // Update widget toggle
    window.electronAPI.trayUpdateRecordingState?.(true) // Update tray menu

    try {
      resetMeetingAudioActivityTracking()
      // Use WAV so the transcription pipeline receives the expected format.
      await startWAVRecording()

      // Set 4-hour auto-close timer
      if (meetingAutoCloseTimeout) clearTimeout(meetingAutoCloseTimeout)
      meetingAutoCloseTimeout = setTimeout(() => {
        appendProgress('Meeting auto-stopped after 4 hours')
        if (stopBtn && !stopBtn.disabled) stopBtn.click()
      }, MEETING_MAX_DURATION_MS)
      return true
    } catch (err: any) {
      setMeetingRecording(false)
      setHeroStatus(`Error: ${err?.message ?? err}`)
      clearAudioActivityInterval()
      await cleanupStreamingCapture()
      try {
        await window.electronAPI.notesCloseWindow?.()
      } catch { }
      if (recordBtn) {
        recordBtn.style.display = 'inline-flex'
        recordBtn.disabled = false
      }
      return false
    }
  }

  async function startWebMRecording() {
    // Start WebM recording
    const rec = await window.electronAPI.webmrecStart()
    if (!rec.ok) throw new Error(rec.message || 'Failed to start WebM recording')
    streamingWebmRecording = true
    streamingRecordingStartTime = Date.now()

    // Build capture graph based on mode
    streamingMic = null; streamingSys = null
    try {
      if (currentMode === 'mic' || currentMode === 'both') {
        streamingMic = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1, // Mono
            sampleRate: 16000, // 16kHz (Gemini downsamples to this anyway)
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          } as any
        })
        if (streamingMic) appendProgress('Mic capture active')
      }
    } catch (e: any) {
      if (currentMode !== 'system') {
        const errorMsg = e.name === 'NotAllowedError' ? 'Microphone permission denied' :
          e.name === 'NotFoundError' ? 'No microphone found' :
            e.name === 'NotReadableError' ? 'Microphone is busy' :
              `Mic not available: ${e?.name ?? 'Error'}`
        appendProgress(errorMsg)
        if (currentMode === 'mic') throw new Error(errorMsg)
      }
    }
    try {
      if (currentMode === 'system' || currentMode === 'both') {
        // Use the standard system picker (avoid macOS "bypass private window picker" warning).
        // We request video+audio to force the picker UI, then immediately drop the video track.
        streamingSys = await (navigator.mediaDevices as any).getDisplayMedia({ audio: true, video: true })
        try {
          streamingSys?.getVideoTracks().forEach((t: MediaStreamTrack) => {
            try { t.stop() } catch { }
            try { streamingSys?.removeTrack(t) } catch { }
          })
        } catch { }
        if (streamingSys) appendProgress('System audio capture active')
      }
    } catch (e: any) {
      if (currentMode !== 'mic') appendProgress(`System audio not available: ${e?.name ?? 'Error'}`)
    }
    if (!streamingMic && !streamingSys) throw new Error('Neither mic nor system audio available')

    // Create combined stream for MediaRecorder
    const combinedStream = new MediaStream()
    if (streamingMic) streamingMic.getAudioTracks().forEach(track => combinedStream.addTrack(track))
    if (streamingSys) streamingSys.getAudioTracks().forEach(track => combinedStream.addTrack(track))

    // Check for WebM/Opus support
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/webm' // Fallback

    streamingMediaRecorder = new MediaRecorder(combinedStream, {
      mimeType,
      audioBitsPerSecond: 32000 // Opus at voice quality
    })

    // Handle data chunks with timeslice (1 second) to prevent memory bloat
    streamingMediaRecorder.ondataavailable = async (event: BlobEvent) => {
      if (event.data && event.data.size > 0 && streamingWebmRecording) {
        try {
          const arrayBuffer = await event.data.arrayBuffer()
          window.electronAPI.webmrecChunk(arrayBuffer)
        } catch (e: any) {
          appendProgress(`WebM chunk error: ${e?.message ?? 'Unknown'}`)
        }
      }
    }

    streamingMediaRecorder.onerror = (event: any) => {
      appendProgress(`MediaRecorder error: ${event.error?.message ?? 'Unknown'}`)
    }

    // Start recording with 1 second timeslice to prevent memory bloat
    streamingMediaRecorder.start(1000)
    await startStreamingAudioActivityMonitor(combinedStream)
    streamingActive = true
    setHeroStatus('Recording')
  }

  async function startWAVRecording() {
    // Legacy WAV recording for OpenRouter compatibility
    const rec = await window.electronAPI.wavrecStart()
    if (!rec.ok) throw new Error(rec.message || 'Failed to start recording')
    streamingWavRecording = true
    streamingRecordingStartTime = Date.now()

    streamingMic = null; streamingSys = null
    try {
      if (currentMode === 'mic' || currentMode === 'both') {
        streamingMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as any })
        if (streamingMic) appendProgress('Mic capture active')
      }
    } catch (e: any) {
      if (currentMode !== 'system') appendProgress(`Mic not available: ${e?.name ?? 'Error'}`)
    }
    try {
      if (currentMode === 'system' || currentMode === 'both') {
        // Use the standard system picker (avoid macOS "bypass private window picker" warning).
        // We request video+audio to force the picker UI, then immediately drop the video track.
        streamingSys = await (navigator.mediaDevices as any).getDisplayMedia({ audio: true, video: true })
        try {
          streamingSys?.getVideoTracks().forEach((t: MediaStreamTrack) => {
            try { t.stop() } catch { }
            try { streamingSys?.removeTrack(t) } catch { }
          })
        } catch { }
        if (streamingSys) appendProgress('System audio capture active')
      }
    } catch (e: any) {
      if (currentMode !== 'mic') appendProgress(`System audio not available: ${e?.name ?? 'Error'}`)
    }
    if (!streamingMic && !streamingSys) throw new Error('Neither mic nor system audio available')

    streamingCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 } as any)
    const workletURL = makeWavDownsamplerURL()
    await streamingCtx.audioWorklet.addModule(workletURL)
    const chunkMs = 500
    streamingNode = new AudioWorkletNode(streamingCtx, 'wav-downsampler', { processorOptions: { chunkMs } })

    const mixGain = streamingCtx.createGain()
    mixGain.gain.value = 1.0
    if (streamingMic) {
      const src = streamingCtx.createMediaStreamSource(streamingMic)
      const g = streamingCtx.createGain(); g.gain.value = 1.0; src.connect(g).connect(mixGain)
    }
    if (streamingSys) {
      const src = streamingCtx.createMediaStreamSource(streamingSys)
      const g = streamingCtx.createGain(); g.gain.value = 1.0; src.connect(g).connect(mixGain)
    }
    mixGain.connect(streamingNode)
    const silence = streamingCtx.createGain(); silence.gain.value = 0.0
    streamingNode.connect(silence).connect(streamingCtx.destination)

    streamingActive = true
    setHeroStatus('Recording')

    streamingNode.port.onmessage = async (ev: MessageEvent) => {
      try {
        if (!streamingActive) return
        const data: any = ev.data || {}
        if (data.type === 'pcm16' && data.buffer && streamingWavRecording) {
          try {
            const samples = new Int16Array(data.buffer)
            if (hasAudiblePcm16Activity(samples)) {
              void notifyMeetingAudioActivity()
            }
            await window.electronAPI.wavrecChunkPCM16(data.buffer)
          } catch { }
        }
      } catch (e: any) {
        appendProgress(`recording error: ${e?.message ?? e}`)
      }
    }
  }

  async function stopStreamingFlow() {
    if (stopBtn) {
      stopBtn.style.display = 'none'
      stopBtn.disabled = true
    }
    updateWidgetRecordingState(false) // Update widget toggle
    window.electronAPI.trayUpdateRecordingState?.(false) // Update tray menu
    // Clear 4-hour auto-close timer
    if (meetingAutoCloseTimeout) {
      clearTimeout(meetingAutoCloseTimeout)
      meetingAutoCloseTimeout = null
    }

    try {
      clearAudioActivityInterval()

      const recordingDurationSeconds = streamingRecordingStartTime > 0
        ? Math.round((Date.now() - streamingRecordingStartTime) / 1000)
        : 0
      streamingRecordingStartTime = 0

      // Stop WebM recording if active
      if (streamingWebmRecording && streamingMediaRecorder) {
        streamingWebmRecording = false
        streamingMediaRecorder.stop()
        // Wait for final data chunk
        await new Promise<void>((resolve) => {
          if (streamingMediaRecorder) {
            streamingMediaRecorder.onstop = () => resolve()
            // Timeout after 2 seconds
            setTimeout(() => resolve(), 2000)
          } else {
            resolve()
          }
        })

        // Stop all tracks
        if (streamingMic) { try { streamingMic.getTracks().forEach(t => t.stop()) } catch { } }
        if (streamingSys) { try { streamingSys.getTracks().forEach(t => t.stop()) } catch { } }
        streamingMic = null; streamingSys = null
        streamingMediaRecorder = null

        // Get the WebM recording result from main process
        const stop = await window.electronAPI.webmrecStop()
        if (stop.ok && stop.recordingId) {
          setHeroStatus('Building notes...')
          try { await window.electronAPI.notesHideWindow?.() } catch { }
          const api = await window.electronAPI.apiTranscribe(stop.recordingId, { deleteInput: true, isMeetingMode: true })
          await handleTranscriptionResult(api, recordingDurationSeconds)
        } else {
          setHeroStatus('Recording failed to save')
        }
      }
      // Legacy WAV recording path
      else if (streamingWavRecording) {
        try { if (streamingNode) await flushWorklet(streamingNode) } catch { }
        await new Promise(r => setTimeout(r, 80))
        streamingActive = false
        if (streamingMic) { try { streamingMic.getTracks().forEach(t => t.stop()) } catch { } }
        if (streamingSys) { try { streamingSys.getTracks().forEach(t => t.stop()) } catch { } }
        if (streamingNode) { try { streamingNode.disconnect() } catch { } }
        if (streamingCtx) { try { await streamingCtx.close() } catch { } }
        streamingMic = null; streamingSys = null; streamingNode = null; streamingCtx = null

        streamingWavRecording = false
        const stop = await window.electronAPI.wavrecStop()
        if (stop.ok && stop.recordingId) {
          setHeroStatus('Building notes...')
          try { await window.electronAPI.notesHideWindow?.() } catch { }
          const api = await transcribeRecording(stop.recordingId, { deleteInput: true, isMeetingMode: true })
          await handleTranscriptionResult(api, recordingDurationSeconds)
        } else {
          setHeroStatus('Recording failed to save')
        }
      }
    } catch (e: any) {
      appendProgress(`stop error: ${e?.message ?? e}`)
    } finally {
      await cleanupStreamingCapture()
      if (recordBtn) {
        recordBtn.style.display = 'inline-flex'
        recordBtn.disabled = false
      }
      if (stopBtn) stopBtn.style.display = 'none'
      // Close notes window when recording stops
      try {
        await window.electronAPI.notesCloseWindow?.()
      } catch { }
    }
  }

  async function handleTranscriptionResult(api: { ok: boolean; text?: string; message?: string; details?: string }, recordingDurationSeconds: number) {
    if (api.ok && (api.text || '').trim()) {
      let transcriptText = (api.text || '').trim()

      // Try to parse as JSON (Gemini meeting mode)
      try {
        const jsonData = JSON.parse(transcriptText)
        if (Array.isArray(jsonData) && jsonData.length > 0 && jsonData[0].speaker) {
          // Convert JSON to formatted text for display
          transcriptText = jsonData.map((segment: any) => {
            if (segment.error) return ''
            return `[${segment.startTime}-${segment.endTime}] ${segment.speaker}: ${segment.text}`
          }).filter(Boolean).join('\n')
          lastTranscriptText = transcriptText
        }
      } catch {
        // Not JSON, use as-is
        lastTranscriptText = transcriptText
      }

      if (transcriptBox) transcriptBox.innerHTML = formatTimestampedTranscript(transcriptText)

      // Light cleanup for summarization only
      const summarizeText = cleanupForSummary(transcriptText)
      const summaryBox = document.getElementById('summary') as HTMLElement | null
      const words = transcriptText.trim().split(/\s+/).filter(Boolean)
      const wordCount = words.length

      // Log activity removed here - handled in autoCreateNote with final title
      // Increment meetings counter
      window.electronAPI.statsUpdate({ meetingsTranscripted: 1 }).then(() => {
        renderStats()
      }).catch(() => { })

      setHeroStatus(`Done, transcribed ${wordCount} words`)

      // Check for garbage/repetitive transcriptions (e.g. constant "Thank you" or filler)
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size
      const repetitionRatio = wordCount > 0 ? uniqueWords / wordCount : 0

      if (wordCount > 50 && repetitionRatio < 0.1) {
        appendProgress('Warning: Transcript seems highly repetitive. Check your audio source.')
      }

      if (words.length < 6) {
        const shortSummary = 'Transcript was too short to summarize.'
        lastSummaryMd = shortSummary
        if (summaryBox) summaryBox.innerHTML = renderMarkdown(shortSummary)
        await autoCreateNote(shortSummary, transcriptText, recordingDurationSeconds)
      } else {
        const sum = await window.electronAPI.apiSummarize(summarizeText, getNotesText())
        if (sum.ok) {
          const normalized = normalizeSummary(sum.text!)
          lastSummaryMd = normalized.summary
          if (summaryBox) summaryBox.innerHTML = renderMarkdown(normalized.summary)
          await autoCreateNote(sum.text!, transcriptText, recordingDurationSeconds)
        } else {
          lastSummaryMd = '**API summarize error:** ' + (sum.message ?? 'Unknown')
          if (summaryBox) summaryBox.innerHTML = renderMarkdown(lastSummaryMd)
          await autoCreateNote(lastSummaryMd, transcriptText, recordingDurationSeconds)
        }
      }
      setHeroStatus('')
    } else {
      setHeroStatus(`Transcription failed: ${api.message || 'Unknown error'}`)
      appendProgress(`API transcribe error: ${api.message || 'Unknown'}`)
      if (api.details === 'HTTP 429') {
        appendProgress('Rate limited. Please wait a moment before trying again.')
      }
    }
  }

  async function startRecordFlow() {
    if (!acquireAudioOwner('meeting')) {
      appendProgress('Another audio session is already active. Stop it before starting a meeting recording.')
      return
    }
    // Open personal notes window when recording starts
    try {
      const notesResult = await window.electronAPI.notesOpenWindow?.()
      if (notesResult?.ok === false) {
        appendProgress(notesResult.message || 'Unable to prepare meeting notes window')
        releaseAudioOwner('meeting')
        return
      }
    } catch {
      releaseAudioOwner('meeting')
      return
    }

    const cap = (captureModeSelect?.value || localStorage.getItem('capture_mode') || 'streaming') as 'streaming' | 'batch'
    const started = cap === 'batch'
      ? await startBatchFlow()
      : await startStreamingFlow()

    if (!started) return

    const captureStarted = await window.electronAPI.meetingCaptureStarted?.()
    if (captureStarted?.ok === false) {
      appendProgress(captureStarted.message || 'Meeting capture could not be finalized')
      if (stopBtn && !stopBtn.disabled) {
        stopBtn.click()
      }
    }
  }

  async function startBatchFlow(): Promise<boolean> {
    if (recordBtn) recordBtn.style.display = 'none'
    if (stopBtn) stopBtn.disabled = false
    setMeetingRecording(true)
    setHeroStatus(`Starting (batch, ${currentMode})...`)
    if (progressLog) progressLog.textContent = ''
    if (transcriptBox) transcriptBox.textContent = ''
    updateWidgetRecordingState(true) // Update widget toggle
    window.electronAPI.trayUpdateRecordingState?.(true) // Update tray menu

    try {
      resetMeetingAudioActivityTracking()
      // Start WAV writer in main
      const rec = await window.electronAPI.wavrecStart()
      if (!rec.ok) throw new Error(rec.message || 'wavrec:start failed')
      batchRecordingStartTime = Date.now() // Record start time

      // Acquire sources
      batchMic = null; batchSys = null
      try {
        if (currentMode === 'mic' || currentMode === 'both') {
          batchMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as any })
          if (batchMic) appendProgress('Mic capture active (batch)')
        }
      } catch (e: any) {
        appendProgress(`Mic not available: ${e?.name ?? 'Error'}`)
      }
      try {
        if (currentMode === 'system' || currentMode === 'both') {
          batchSys = await (navigator.mediaDevices as any).getDisplayMedia({ audio: true, video: false })
          if (batchSys) appendProgress('System audio capture active (batch)')
        }
      } catch (e: any) {
        appendProgress(`System audio not available: ${e?.name ?? 'Error'}`)
      }
      if (!batchMic && !batchSys) throw new Error('Neither mic nor system audio available')

      // Build downsampler
      batchCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 } as any)
      const workletURL = makeWavDownsamplerURL()
      await batchCtx.audioWorklet.addModule(workletURL)
      batchNode = new AudioWorkletNode(batchCtx, 'wav-downsampler', { processorOptions: { chunkMs: getRtChunkMs() } })

      const mixGain = batchCtx.createGain(); mixGain.gain.value = 1.0
      if (batchMic) { const src = batchCtx.createMediaStreamSource(batchMic); const g = batchCtx.createGain(); g.gain.value = 1.0; src.connect(g).connect(mixGain) }
      if (batchSys) { const src = batchCtx.createMediaStreamSource(batchSys); const g = batchCtx.createGain(); g.gain.value = 1.0; src.connect(g).connect(mixGain) }
      mixGain.connect(batchNode)
      const sink = batchCtx.createGain(); sink.gain.value = 0.0; batchNode.connect(sink).connect(batchCtx.destination)

      batchActive = true
      setHeroStatus('Recording')
      // Don't log 'Started recording' - we'll log the result instead

      batchNode.port.onmessage = async (ev: MessageEvent) => {
        if (!batchActive) return
        const data: any = ev.data || {}
        if (data.type === 'pcm16' && data.buffer) {
          try {
            const samples = new Int16Array(data.buffer)
            if (hasAudiblePcm16Activity(samples)) {
              void notifyMeetingAudioActivity()
            }
            await window.electronAPI.wavrecChunkPCM16(data.buffer)
          } catch (e: any) {
            appendProgress(`wavrec chunk error: ${e?.message ?? e}`)
          }
        }
      }
      return true
    } catch (err: any) {
      setMeetingRecording(false)
      setHeroStatus(`Error: ${err?.message ?? err}`)
      clearAudioActivityInterval()
      await cleanupBatchCapture()
      try {
        await window.electronAPI.notesCloseWindow?.()
      } catch { }
      if (recordBtn) {
        recordBtn.style.display = 'inline-flex'
        recordBtn.disabled = false
      }
      return false
    }
  }

  async function stopBatchFlow() {
    if (stopBtn) {
      stopBtn.style.display = 'none'
      stopBtn.disabled = true
    }
    updateWidgetRecordingState(false) // Update widget toggle
    window.electronAPI.trayUpdateRecordingState?.(false) // Update tray menu
    try {
      clearAudioActivityInterval()

      await new Promise(r => setTimeout(r, 500))
      batchActive = false
      const recordingDurationSeconds = batchRecordingStartTime > 0
        ? Math.round((Date.now() - batchRecordingStartTime) / 1000)
        : 0
      batchRecordingStartTime = 0

      if (batchMic) { try { batchMic.getTracks().forEach(t => t.stop()) } catch { } }
      if (batchSys) { try { batchSys.getTracks().forEach(t => t.stop()) } catch { } }
      if (batchNode) { try { batchNode.disconnect() } catch { } }
      if (batchCtx) { try { await batchCtx.close() } catch { } }
      batchMic = null; batchSys = null; batchNode = null; batchCtx = null

      const stop = await window.electronAPI.wavrecStop()
      if (!stop.ok) { setHeroStatus(`Failed to finalize WAV: ${stop.message ?? 'Unknown'}`); return }
      const recordingId = stop.recordingId!

      // Use API for transcription
      setHeroStatus('Building notes...')
      try { await window.electronAPI.notesHideWindow?.() } catch { }
      const tr = await transcribeRecording(recordingId, { deleteInput: !keepRecordings, isMeetingMode: true })
      if (!tr.ok) { setHeroStatus(`API STT error: ${('message' in tr ? tr.message : 'Unknown')}`); return }
      const text = (('text' in tr ? tr.text : '') ?? '').trim()
      lastTranscriptText = text
      if (transcriptBox) transcriptBox.innerHTML = formatTimestampedTranscript(text)
      const summaryBox = document.getElementById('summary') as HTMLElement | null
      const words = text.split(/\s+/).filter(Boolean)
      const wordCount = words.length
      setHeroStatus(`Done, transcribed ${wordCount} words`)
      // Log activity removed here - handled in autoCreateNote with final title
      // Increment meetings counter
      window.electronAPI.statsUpdate({ meetingsTranscripted: 1 }).then(() => {
        renderStats()
      }).catch(() => { })

      if (words.length < 6) {
        const shortSummary = 'Transcript was too short to summarize.'
        lastSummaryMd = shortSummary
        if (summaryBox) summaryBox.innerHTML = renderMarkdown(shortSummary)
        await autoCreateNote(shortSummary, text, recordingDurationSeconds)
      } else {
        const sum = await window.electronAPI.apiSummarize(text, getNotesText())
        if (sum.ok) {
          const normalized = normalizeSummary(sum.text!)
          lastSummaryMd = normalized.summary
          if (summaryBox) summaryBox.innerHTML = renderMarkdown(normalized.summary)
          await autoCreateNote(sum.text!, text, recordingDurationSeconds)
        } else {
          lastSummaryMd = `**API summarize error:** ${sum.message ?? 'Unknown'}`
          if (summaryBox) summaryBox.innerHTML = renderMarkdown(lastSummaryMd)
          await autoCreateNote(lastSummaryMd, text, recordingDurationSeconds)
        }
      }
      setHeroStatus('')
    } catch (e: any) {
      appendProgress(`batch stop error: ${e?.message ?? e}`)
    } finally {
      await cleanupBatchCapture()
      if (recordBtn) {
        recordBtn.style.display = 'inline-flex'
        recordBtn.disabled = false
      }
      if (stopBtn) stopBtn.style.display = 'none'
      // Close notes window when recording stops
      try {
        await window.electronAPI.notesCloseWindow?.()
      } catch { }
    }
  }

  recordBtn.addEventListener('click', startRecordFlow)

  // Export buttons
  function buildNotionMdFromTranscript(title: string, transcript: string, notes?: string) {
    const t = (transcript || '').trim()
    const n = (notes || '').trim()
    return `# ${title || 'Session'}\n\n## Transcript\n\n${t}\n\n${n ? '---\n\n## Personal notes\n\n' + n + '\n' : ''}`
  }
  function markdownToPlainText(md: string): string {
    try {
      const lines = (md || '').replace(/```[\s\S]*?```/g, '').split(/\r?\n/)
      const out: string[] = []
      for (let line of lines) {
        line = line.replace(/^\s*#+\s*/, '') // headings
        line = line.replace(/^\s*- \[ \]\s*/, '- [ ] ') // keep checkboxes visually
        line = line.replace(/^\s*[-*]\s*/, '- ')
        out.push(line)
      }
      return out.join('\n').trim()
    } catch { return (md || '') }
  }

  // Start recording when main sends prompt event
  window.ui?.onRecord(() => { startRecordFlow().catch(() => { }) })

  // Auto-stop recording when meeting ends (mic goes inactive)
  window.ui?.onAutoStop(() => {
    if (!stopBtn.disabled) {
      stopBtn.click()
    }
  })

  // Start recording when notes window requests it (via Start meeting button)
  window.ui?.onStartRecording?.(() => {
    if (recordBtn && !recordBtn.disabled) {
      recordBtn.click()
    }
  })

  window.ui?.onRecordingPaused?.(() => {
    if (!isMeetingRecording) return
    pauseMeetingCapture().catch(() => { }).finally(() => {
      setMeetingPaused(true)
      setHeroStatus('Paused')
    })
  })

  window.ui?.onRecordingResumed?.(() => {
    if (!isMeetingRecording) return
    resumeMeetingCapture().catch(() => { }).finally(() => {
      setMeetingPaused(false)
      setHeroStatus('Recording')
    })
  })

  if (pauseBtn) {
    pauseBtn.addEventListener('click', async () => {
      const electron = window.electronAPI
      if (!electron?.meetingPause || !electron?.meetingResume) return
      try {
        if (isMeetingPaused) {
          const result = await electron.meetingResume()
          if (result?.ok) {
            await resumeMeetingCapture().catch(() => { })
            setMeetingPaused(false)
            setHeroStatus('Recording')
          }
        } else {
          const result = await electron.meetingPause()
          if (result?.ok) {
            await pauseMeetingCapture().catch(() => { })
            setMeetingPaused(true)
            setHeroStatus('Paused')
          }
        }
      } catch (e) {
        console.error('Failed to pause/resume:', e)
      }
    })
  }

  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true
    setMeetingRecording(false)
    setHeroStatus('Stopping...')
    const cap = (captureModeSelect?.value || localStorage.getItem('capture_mode') || 'streaming') as 'streaming' | 'batch'
    if (cap === 'streaming') {
      await stopStreamingFlow()
      return
    } else {
      await stopBatchFlow()
      return
    }
  })

  // ---- Note Taker Widget functionality ----

  function positionNoteTakerWidget(anchor: HTMLElement) {
    if (!noteTakerWidget) return
    const rect = anchor.getBoundingClientRect()
    const margin = 8

    noteTakerWidget.style.position = 'fixed'
    noteTakerWidget.style.display = 'block'
    noteTakerWidget.style.visibility = 'hidden'

    const widgetWidth = noteTakerWidget.offsetWidth || 320
    const widgetHeight = noteTakerWidget.offsetHeight || 0

    let left = rect.right - widgetWidth
    const maxLeft = window.innerWidth - widgetWidth - margin
    left = Math.min(Math.max(margin, left), Math.max(margin, maxLeft))

    let top = rect.bottom + margin
    if (widgetHeight && top + widgetHeight + margin > window.innerHeight) {
      const aboveTop = rect.top - widgetHeight - margin
      if (aboveTop >= margin) {
        top = aboveTop
      }
    }

    noteTakerWidget.style.left = `${Math.round(left)}px`
    noteTakerWidget.style.top = `${Math.round(top)}px`
    noteTakerWidget.style.right = 'auto'
    noteTakerWidget.style.bottom = 'auto'
    noteTakerWidget.style.visibility = ''
  }

  function toggleNoteTakerWidget(anchor: HTMLElement) {
    if (!noteTakerWidget) return
    const isVisible = noteTakerWidget.style.display !== 'none'
    const isSameAnchor = (noteTakerWidget as any).currentAnchor === anchor

    if (isVisible && isSameAnchor) {
      noteTakerWidget.style.display = 'none'
      return
    }

    positionNoteTakerWidget(anchor)
      ; (noteTakerWidget as any).currentAnchor = anchor
  }

  // Toggle widget visibility from settings button
  if (noteTakerWidgetBtn && noteTakerWidget) {
    noteTakerWidgetBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleNoteTakerWidget(noteTakerWidgetBtn)
    })
  }

  // Close widget when clicking outside
  document.addEventListener('click', (e) => {
    if (noteTakerWidget) {
      const isSettingsBtn = noteTakerWidgetBtn && (e.target === noteTakerWidgetBtn || noteTakerWidgetBtn.contains(e.target as Node))
      if (!noteTakerWidget.contains(e.target as Node) && !isSettingsBtn) {
        noteTakerWidget.style.display = 'none'
      }
    }
  })

  // Sync recording toggle with recording state
  function updateWidgetRecordingState(isRecording: boolean) {
    if (widgetRecordToggle) {
      widgetRecordToggle.checked = isRecording
    }
  }

  // Handle recording toggle from widget
  if (widgetRecordToggle) {
    widgetRecordToggle.addEventListener('change', async () => {
      if (widgetRecordToggle.checked) {
        // Start recording
        if (!recordBtn.disabled) {
          await startRecordFlow()
        }
      } else {
        // Stop recording
        if (!stopBtn.disabled) {
          stopBtn.click()
        }
      }
    })
  }

  // Handle audio mode change
  if (widgetAudioMode) {
    // Load initial value from localStorage
    const savedMode = localStorage.getItem('record_mode') || 'both'
    widgetAudioMode.value = savedMode
    window.electronAPI.trayUpdateAudioMode?.(savedMode as 'mic' | 'system' | 'both') // Sync tray on load

    widgetAudioMode.addEventListener('change', () => {
      const newMode = widgetAudioMode.value as 'mic' | 'system' | 'both'
      currentMode = newMode
      try {
        localStorage.setItem('record_mode', newMode)
      } catch { }
      window.electronAPI.trayUpdateAudioMode?.(newMode) // Update tray menu
    })
  }

  // Enumerate audio devices
  async function enumerateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()

      // Populate microphone devices
      if (widgetMicDevice) {
        widgetMicDevice.innerHTML = '<option value="">Default Microphone</option>'
        const audioInputs = devices.filter(d => d.kind === 'audioinput')
        audioInputs.forEach(device => {
          const option = document.createElement('option')
          option.value = device.deviceId
          option.textContent = device.label || `Microphone ${audioInputs.indexOf(device) + 1}`
          widgetMicDevice.appendChild(option)
        })
      }

      // Populate speaker devices
      if (widgetSpeakerDevice) {
        widgetSpeakerDevice.innerHTML = '<option value="">Default Speaker</option>'
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput')
        audioOutputs.forEach(device => {
          const option = document.createElement('option')
          option.value = device.deviceId
          option.textContent = device.label || `Speaker ${audioOutputs.indexOf(device) + 1}`
          widgetSpeakerDevice.appendChild(option)
        })
      }
    } catch (err) {
      console.error('Failed to enumerate devices:', err)
    }
  }

  // Load devices on page load
  enumerateAudioDevices()

  // Refresh devices when widget is opened
  if (noteTakerWidgetBtn) {
    noteTakerWidgetBtn.addEventListener('click', () => {
      enumerateAudioDevices()
    })
  }

  // ---- Tray Event Handlers ----

  // Handle start recording from tray
  window.ui?.onTrayStartRecording?.(() => {
    if (!recordBtn.disabled) {
      startRecordFlow().catch(() => { })
    }
  })

  // Handle stop recording from tray
  window.ui?.onTrayStopRecording?.(() => {
    if (!stopBtn.disabled) {
      stopBtn.click()
    }
  })

  // Handle audio mode change from tray
  window.ui?.onTrayAudioModeChanged?.((mode: 'mic' | 'system' | 'both') => {
    currentMode = mode
    try {
      localStorage.setItem('record_mode', mode)
    } catch { }
    // Update widget UI if available
    if (widgetAudioMode) {
      widgetAudioMode.value = mode
    }
  })

  // ---- Global Dictation (Alt+Shift hold) ----
  let dictActive = false
  let aiModeActive = false
  let dictCtx: AudioContext | null = null
  let dictNode: AudioWorkletNode | null = null
  let dictMic: MediaStream | null = null
  let dictAnalyser: AnalyserNode | null = null // For reactive audio visualization
  let dictAudioLevelInterval: ReturnType<typeof setInterval> | null = null // Interval to send audio levels to HUD
  let dictSegs: { start: number; end: number; text: string }[] = []
  let dictLang: string = 'unknown'
  let dictUseStreaming = false
  let dictWavRecording = false
  let dictProcessingTranscript = false // Flag to prevent unwanted pastes
  let dictStartTime: number = 0 // Track dictation start time for stats
  let dictPcmBuffers: Int16Array[] = [] // in-memory PCM accumulation for fallback
  // Deepgram WebSocket streaming state
  let deepgramStreamActive = false
  let deepgramToken: string | null = null
  let deepgramTokenExpiresAt = 0
  let sentBufferCount = 0 // Track how many buffered audio chunks were sent to avoid duplicates
  let tokenPrewarmInProgress = false // Prevent duplicate pre-warm calls
  let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null
  let dictStreamSendQueue: Promise<void> = Promise.resolve()

  function resetDictationSessionState(owner: 'dictation' | 'aimode') {
    dictAnalyser = null
    dictMic = null
    dictNode = null
    dictCtx = null
    dictAudioLevelInterval = null
    dictPcmBuffers = []
    dictUseStreaming = false
    dictWavRecording = false
    dictProcessingTranscript = false
    deepgramStreamActive = false
    sentBufferCount = 0
    dictStreamSendQueue = Promise.resolve()
    releaseAudioOwner(owner)
  }

  async function stopDictationRecorderIfActive() {
    if (!dictWavRecording) return
    dictWavRecording = false
    try { await window.electronAPI.wavrecStop() } catch { }
  }

  async function flushQueuedDictationSends() {
    try {
      await dictStreamSendQueue
    } catch { }
  }

  async function flushBufferedDictationChunks(startIndex = sentBufferCount) {
    if (!deepgramStreamActive) return
    for (let index = startIndex; index < dictPcmBuffers.length; index++) {
      const buf = dictPcmBuffers[index]
      const chunkBuffer = new ArrayBuffer(buf.byteLength)
      new Int16Array(chunkBuffer).set(buf)
      await window.electronAPI.deepgramSendChunk(chunkBuffer)
      sentBufferCount = index + 1
    }
  }

  function queueDictationChunkForStreaming(buffer: Int16Array) {
    if (!deepgramStreamActive) return
    const bufferIndex = dictPcmBuffers.length - 1
    dictStreamSendQueue = dictStreamSendQueue.then(async () => {
      if (!deepgramStreamActive) return
      const chunkBuffer = new ArrayBuffer(buffer.byteLength)
      new Int16Array(chunkBuffer).set(buffer)
      const result = await window.electronAPI.deepgramSendChunk(chunkBuffer)
      if (result?.ok === false) {
        throw new Error(result.message || 'Failed to send dictation chunk')
      }
      sentBufferCount = Math.max(sentBufferCount, bufferIndex + 1)
    }).catch((err) => {
      console.error('[Dictation] sendChunk failed:', err)
      deepgramStreamActive = false
    })
  }

  async function cleanupDictationAudio() {
    try {
      if (dictAudioLevelInterval) {
        clearInterval(dictAudioLevelInterval)
      }
      if (dictAnalyser) { try { dictAnalyser.disconnect() } catch { } }
      await releaseAudioResources({
        streams: [dictMic],
        nodes: [dictNode],
        contexts: [dictCtx]
      })
    } catch { }
  }

  function clamp01(v: number): number {
    if (!isFinite(v)) return 0
    return v < 0 ? 0 : v > 1 ? 1 : v
  }

  function computeVoiceBandLevels(freqBins: Uint8Array, sampleRate: number, fftSize: number): number[] {
    // 5 voice-ish bands (Hz): low → high
    const bands: Array<[number, number]> = [
      [80, 250],
      [250, 500],
      [500, 1000],
      [1000, 2000],
      [2000, 6000]
    ]

    // Slight per-band normalization so one band doesn't peg constantly.
    // Lower the lowest band a bit (it tends to dominate on many mics).
    const bandGains = [0.78, 0.86, 0.92, 0.92, 0.88]

    const binHz = sampleRate / fftSize
    const lastBin = freqBins.length - 1

    const levels: number[] = []
    for (const [loHz, hiHz] of bands) {
      let start = Math.floor(loHz / binHz)
      let end = Math.ceil(hiHz / binHz)
      if (start < 0) start = 0
      if (end > lastBin) end = lastBin
      if (end < start) end = start

      // RMS across the band (stable; avoids single-bin jitter)
      let sumSq = 0
      let count = 0
      for (let i = start; i <= end; i++) {
        const x = freqBins[i] / 255
        sumSq += x * x
        count++
      }
      const rms = count > 0 ? Math.sqrt(sumSq / count) : 0

      // Slightly boost low amplitudes so quiet speech still moves the bars.
      // Gamma < 1 expands low range; clamp keeps [0..1].
      const gamma = 0.80
      const boosted = Math.pow(clamp01(rms), gamma)

      // Subtract a tiny noise floor to reduce idle flicker.
      const noiseFloor = 0.04
      const denoised = clamp01((boosted - noiseFloor) / (1 - noiseFloor))

      // Overall sensitivity: ~10–15% less hot to avoid constant maxing.
      const scaled = clamp01(denoised * 0.88 * (bandGains[levels.length] ?? 1))
      levels.push(scaled)
    }
    return levels
  }

  function smoothHudLevels(prev: number[], target: number[], dtMs: number): number[] {
    // Time-based smoothing keeps behavior consistent even if the interval is throttled.
    const dt = Math.max(0.001, Math.min(0.25, dtMs / 1000))
    const attackTau = 0.04 // seconds (fast)
    const releaseTau = 0.11 // seconds (smooth)
    for (let i = 0; i < target.length; i++) {
      const t = clamp01(target[i])
      const p = clamp01(prev[i] ?? 0)
      const tau = t > p ? attackTau : releaseTau
      const a = 1 - Math.exp(-dt / tau)
      prev[i] = p + (t - p) * a
    }
    return prev
  }

  // Pre-warm Deepgram token to eliminate cold-start delay on first dictation
  async function prewarmDeepgramToken() {
    // Skip if already have a valid token (with 5 min buffer for 1-hour TTL tokens)
    if (deepgramToken && Date.now() < deepgramTokenExpiresAt - 300000) {
      console.log('[Dictation] Token already cached, skipping pre-warm')
      return
    }
    // Skip if pre-warm already in progress
    if (tokenPrewarmInProgress) return
    tokenPrewarmInProgress = true

    try {
      console.log('[Dictation] Pre-warming Deepgram token...')
      const result = await window.electronAPI.deepgramGetToken()
      if (result.ok && result.token) {
        deepgramToken = result.token
        deepgramTokenExpiresAt = Date.now() + (result.expiresIn || 3600) * 1000
        console.log(`[Dictation] Token pre-warmed, expires in ${result.expiresIn}s`)

        // Start continuous refresh timer if not already running
        startTokenRefreshTimer()
      }
    } catch (e) {
      console.warn('[Dictation] Token pre-warm failed:', e)
    } finally {
      tokenPrewarmInProgress = false
    }
  }

  // Continuous token refresh - keeps token always ready for instant dictation
  function startTokenRefreshTimer() {
    if (tokenRefreshTimer) return // Already running

    // Check every minute if token needs refresh
    tokenRefreshTimer = setInterval(() => {
      // Refresh if token expires within 5 minutes
      if (!deepgramToken || Date.now() > deepgramTokenExpiresAt - 300000) {
        console.log('[Dictation] Token expiring soon, auto-refreshing...')
        prewarmDeepgramToken()
      }
    }, 60000) // Check every 60 seconds

    console.log('[Dictation] Token auto-refresh timer started')
  }

  async function startDictationFlow() {
    // Immediate re-entrancy check (synchronous)
    if (dictActive || aiModeActive || streamingActive || batchActive) return
    if (!acquireAudioOwner('dictation')) return
    dictActive = true // Set immediately to block other calls

    try {
      window.electronAPI.debugLog('StartDictationFlow called - WebSocket streaming mode')
      dictSegs = []
      dictLang = 'unknown'
      dictUseStreaming = false
      dictWavRecording = false
      dictStartTime = Date.now() // Record start time
      deepgramStreamActive = false
      // Invalidate token if it expires within 5 minutes (adjusted for 1-hour TTL tokens)
      if (deepgramToken && Date.now() > deepgramTokenExpiresAt - 300000) {
        deepgramToken = null
        deepgramTokenExpiresAt = 0
      }
      dictPcmBuffers = []
      sentBufferCount = 0
      dictStreamSendQueue = Promise.resolve()
      // No live transcript preview for dictation

      const tokenPromise = (async () => {
        // Use cached token if still valid (with 5 min buffer for 1-hour TTL tokens)
        if (deepgramToken && Date.now() < deepgramTokenExpiresAt - 300000) {
          console.log('[Dictation] Using pre-warmed token')
          return { ok: true, token: deepgramToken, expiresIn: Math.floor((deepgramTokenExpiresAt - Date.now()) / 1000) }
        }
        return await window.electronAPI.deepgramGetToken()
      })()

        // Step 0: Connect to Deepgram ASAP (parallel with mic acquisition)
        ; (async () => {
          try {
            window.electronAPI.debugLog('Background: Getting Deepgram token...')
            const tokenResult = await tokenPromise

            if (!dictActive) return // Abort if stopped while connecting

            if (tokenResult.ok && tokenResult.token) {
              deepgramToken = tokenResult.token
              if (tokenResult.expiresIn) {
                deepgramTokenExpiresAt = Date.now() + tokenResult.expiresIn * 1000
              }
              // Connect WebSocket
              window.electronAPI.debugLog('Background: Connecting WebSocket...')
              const streamResult = await window.electronAPI.deepgramStartStream(deepgramToken)

              if (!dictActive) {
                if (streamResult.ok) {
                  window.electronAPI.deepgramStopStream().catch(() => { })
                }
                return
              }

              if (streamResult.ok) {
                deepgramStreamActive = true
                window.electronAPI.debugLog('Background: Deepgram Stream Ready! deepgramStreamActive=true')
                console.log('[Dictation] Stream connected, deepgramStreamActive=true')

                // CATCH UP: Send valid audio buffers that accumulated while connecting
                if (dictPcmBuffers.length > 0) {
                  window.electronAPI.debugLog(`Flushing ${dictPcmBuffers.length} buffered chunks to Deepgram...`)
                  const totalSamples = dictPcmBuffers.reduce((sum, buf) => sum + buf.length, 0)
                  await flushBufferedDictationChunks()
                  window.electronAPI.debugLog(`Flushed ${totalSamples} samples to Deepgram`)
                }
              } else {
                window.electronAPI.debugLog(`WebSocket connect failed: ${streamResult.message}`)
              }
            } else {
              window.electronAPI.debugLog('Failed to get Deepgram token')
            }
          } catch (e) {
            window.electronAPI.debugLog(`Background connect error: ${e}`)
          }
        })()

      // Step 1: Get microphone access immediately (Critical for low latency start)
      try {
        dictMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as any })
      } catch (err) {
        window.electronAPI.hudUpdate({ kind: 'no-mic', vis: true })
        window.electronAPI.dictationMicError()
        setTimeout(() => {
          window.electronAPI.dictationCloseHUD()
        }, 3000)
        dictActive = false
        resetDictationSessionState('dictation')
        return
      }

      // Step 2: Start Audio Processing immediately
      dictCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 } as any)
      const workletURL = makeWavDownsamplerURL()
      await dictCtx.audioWorklet.addModule(workletURL)
      // Use 150ms chunks for optimal streaming
      dictNode = new AudioWorkletNode(dictCtx, 'wav-downsampler', { processorOptions: { chunkMs: 150 } })
      const src = dictCtx.createMediaStreamSource(dictMic)
      const g = dictCtx.createGain(); g.gain.value = 1.0; src.connect(g).connect(dictNode)
      const sink = dictCtx.createGain(); sink.gain.value = 0.0; dictNode.connect(sink).connect(dictCtx.destination)

      // Step 3: Set up AnalyserNode for reactive audio visualization
      dictAnalyser = dictCtx.createAnalyser()
      // Larger FFT reduces "bin jumping" so bars look stable.
      dictAnalyser.fftSize = 1024
      // We'll apply our own smoothing for fast attack + smooth release.
      dictAnalyser.smoothingTimeConstant = 0.0
      src.connect(dictAnalyser)

      // Send audio levels to HUD ~60fps for smooth reactive bars
      const levelDataArray = new Uint8Array(dictAnalyser.frequencyBinCount)
      const smoothedLevels = [0, 0, 0, 0, 0]
      let lastLevelAt = performance.now()
      dictAudioLevelInterval = setInterval(() => {
        if (!dictActive || !dictAnalyser) return
        try {
          dictAnalyser.getByteFrequencyData(levelDataArray)
          const target = computeVoiceBandLevels(levelDataArray, dictCtx?.sampleRate || 48000, dictAnalyser.fftSize)
          const now = performance.now()
          const dtMs = now - lastLevelAt
          lastLevelAt = now
          const levels = smoothHudLevels(smoothedLevels, target, dtMs)
          // Prefer fire-and-forget to avoid IPC backpressure; fall back to invoke-based hudUpdate.
          if (window.electronAPI.hudUpdateFast) window.electronAPI.hudUpdateFast({ audioLevels: levels })
          else window.electronAPI.hudUpdate?.({ audioLevels: levels })
        } catch { }
      }, 16)

      // Start fallback file recording (fire-and-forget)
      window.electronAPI.wavrecStart().then(rec => { dictWavRecording = !!rec?.ok }).catch(() => { });

      // Step 4: Handle audio chunks
      dictNode.port.onmessage = async (ev: MessageEvent) => {
        try {
          if (!dictActive) return
          const data: any = ev.data || {}
          if (data.type === 'pcm16' && data.buffer) {
            try {
              const arr = new Int16Array(data.buffer)

              // 1. Buffer for fallback AND catch-up
              dictPcmBuffers.push(arr)

              // 2. If stream is active, send immediately
              if (deepgramStreamActive) {
                queueDictationChunkForStreaming(arr)
              }
              // Note: If stream NOT active yet, we just keep buffering. 
              // The background task will flush this buffer once connected.

              // 3. Fallback disk write
              if (dictWavRecording) { window.electronAPI.wavrecChunkPCM16(data.buffer).catch(() => { }) }
            } catch { }
          }
        } catch { }
      }
    } catch (err) {
      // If setup failed, clean up mic and reset flag
      await cleanupDictationAudio()
      await stopDictationRecorderIfActive()
      dictActive = false
      resetDictationSessionState('dictation')
      window.electronAPI.debugLog(`startDictationFlow error: ${err}`)
    }
  } async function stopDictationFlow() {
    try {
      if (!dictActive) return

      // DON'T set dictActive = false yet - we need to flush remaining audio first

      // Flush any residual samples from the worklet to avoid cutting off last words
      console.log('[Dictation] Flushing worklet...')
      try { if (dictNode) await flushWorklet(dictNode) } catch { }

      // Small settle to let flush events land
      await new Promise(r => setTimeout(r, 50))

      await flushQueuedDictationSends()

      // Now stop accepting new chunks
      dictActive = false

      // Send any final buffered chunks that came in during the flush (only unsent ones)
      const unsentChunks = dictPcmBuffers.slice(sentBufferCount)
      if (deepgramStreamActive && unsentChunks.length > 0) {
        console.log(`[Dictation] Sending ${unsentChunks.length} unsent chunks (total buffered: ${dictPcmBuffers.length}, already sent: ${sentBufferCount})`)
        await flushBufferedDictationChunks(sentBufferCount)
      }

      // Minimal wait before CloseStream
      await new Promise(r => setTimeout(r, 50))

      await cleanupDictationAudio()

      let pasted = false
      let transcriptText = ''

      // PRIORITY 1: Get results from WebSocket stream (fastest path)
      // PRIORITY 1: Get results from WebSocket stream (fastest path)
      if (deepgramStreamActive) {
        // Wait for CloseStream + final results before committing
        window.electronAPI.debugLog('Stopping Deepgram WebSocket stream...')
        const streamResult = await window.electronAPI.deepgramStopStream()
        deepgramStreamActive = false
        if (streamResult.ok && streamResult.text && streamResult.text.trim()) {
          transcriptText = streamResult.text.trim()
          await window.dictation?.paste(transcriptText)
          pasted = true
        }

        if (pasted) {
          // Common post-paste logic
          const dictationDurationSeconds = (Date.now() - dictStartTime) / 1000
          const wordCount = transcriptText.split(/\s+/).filter(Boolean).length
          updateStats(wordCount, dictationDurationSeconds)
          const preview = buildActivityPreview(transcriptText)
          addActivityLog(`${preview}`, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>', 'dictation', transcriptText)
        } else {
          window.electronAPI.debugLog('WebSocket returned empty, falling back to batch...')
        }
      }

      // PRIORITY 2: Fall back to batch transcription if WebSocket failed or was empty
      if (!pasted && dictPcmBuffers.length) {
        const totalSamples = dictPcmBuffers.reduce((a, b) => a + b.length, 0)

        // Main already rejects holds under 2s. Mic startup eats part of a hold, so only skip
        // near-empty captures here (< 1 second at 16kHz) instead of silently dropping 2-3s holds.
        if (totalSamples < MIN_TRANSCRIBE_SAMPLES) {
          console.log('Dictation: Audio too short, skipping transcription')
          window.electronAPI.debugLog(`Audio too short: ${totalSamples} samples`)
          await window.dictation?.paste('')
          pasted = true
        } else {
          window.electronAPI.debugLog(`Fallback: Transcribing ${totalSamples} samples via batch...`)
          const merged = new Int16Array(totalSamples)
          let off = 0
          for (const part of dictPcmBuffers) { merged.set(part, off); off += part.length }
          const wavBuf = pcm16ToWav(merged, 16000)

          // Use batch transcription as fallback
          const api = await window.electronAPI.deepgramTranscribeDictation(wavBuf)
          window.electronAPI.debugLog(`Batch fallback: ok=${api.ok}, textLen=${api.text?.length ?? 0}`)

          if (api.ok && (api.text || '').trim()) {
            const text = (api.text || '').trim()
            await window.dictation?.paste(text)
            pasted = true
            const dictationDurationSeconds = (Date.now() - dictStartTime) / 1000
            const wordCount = text.split(/\s+/).filter(Boolean).length
            updateStats(wordCount, dictationDurationSeconds)
            const preview = buildActivityPreview(text)
            addActivityLog(`${preview}`, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>', 'dictation', text)
          } else {
            // API returned empty or failed
            await window.dictation?.paste('')
            pasted = true
          }
        }
      }

      // Stop file recording if active
      if (dictWavRecording) {
        dictWavRecording = false
        await window.electronAPI.wavrecStop()
      }

      if (!pasted) {
        // Ensure HUD is closed even if transcription failed completely
        await window.dictation?.paste('')
      }
    } catch { }
    finally {
      await cleanupDictationAudio()
      resetDictationSessionState('dictation')
    }
  }

  async function startAIModeFlow() {
    // Immediate check
    if (aiModeActive || dictActive || streamingActive || batchActive) return
    if (!acquireAudioOwner('aimode')) return
    aiModeActive = true // Block immediately

    try {
      dictSegs = []
      dictLang = 'unknown'
      dictUseStreaming = false
      dictWavRecording = false
      dictStartTime = Date.now() // Record start time for Agentic Dictation too

      // Always use API mode for Agentic Dictation
      // Fire-and-forget wavrec to avoid blocking
      window.electronAPI.wavrecStart().then(rec => { dictWavRecording = !!rec?.ok }).catch(() => { })
      dictPcmBuffers = []

      try {
        dictMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as any })
      } catch (err) {
        window.electronAPI.hudUpdate({ kind: 'no-mic', vis: true })
        window.electronAPI.aimodeMicError()
        setTimeout(() => {
          window.electronAPI.dictationCloseHUD()
        }, 3000)
        aiModeActive = false
        resetDictationSessionState('aimode')
        return
      }
      dictCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 } as any)
      const workletURL = makeWavDownsamplerURL()
      await dictCtx.audioWorklet.addModule(workletURL)
      dictNode = new AudioWorkletNode(dictCtx, 'wav-downsampler', { processorOptions: { chunkMs: getRtChunkMs() } })
      const src = dictCtx.createMediaStreamSource(dictMic)
      const g = dictCtx.createGain(); g.gain.value = 1.0; src.connect(g).connect(dictNode)
      const sink = dictCtx.createGain(); sink.gain.value = 0.0; dictNode.connect(sink).connect(dictCtx.destination)
      // aiModeActive = true // Already set above

      // Set up AnalyserNode for reactive audio visualization (same as regular dictation)
      dictAnalyser = dictCtx.createAnalyser()
      dictAnalyser.fftSize = 1024
      dictAnalyser.smoothingTimeConstant = 0.0
      src.connect(dictAnalyser)

      // Send audio levels to HUD ~60fps for smooth reactive bars
      const levelDataArray = new Uint8Array(dictAnalyser.frequencyBinCount)
      const smoothedLevels = [0, 0, 0, 0, 0]
      let lastLevelAt = performance.now()
      dictAudioLevelInterval = setInterval(() => {
        if (!aiModeActive || !dictAnalyser) return
        try {
          dictAnalyser.getByteFrequencyData(levelDataArray)
          const target = computeVoiceBandLevels(levelDataArray, dictCtx?.sampleRate || 48000, dictAnalyser.fftSize)
          const now = performance.now()
          const dtMs = now - lastLevelAt
          lastLevelAt = now
          const levels = smoothHudLevels(smoothedLevels, target, dtMs)
          if (window.electronAPI.hudUpdateFast) window.electronAPI.hudUpdateFast({ audioLevels: levels })
          else window.electronAPI.hudUpdate?.({ audioLevels: levels })
        } catch { }
      }, 16)

      dictNode.port.onmessage = async (ev: MessageEvent) => {
        try {
          if (!aiModeActive) return
          const data: any = ev.data || {}
          if (data.type === 'pcm16' && data.buffer) {
            try {
              const arr = new Int16Array(data.buffer)
              dictPcmBuffers.push(arr)

              if (dictWavRecording) { window.electronAPI.wavrecChunkPCM16(data.buffer).catch(() => { }) }
            } catch { }
          }
        } catch { }
      }
    } catch (err) {
      // Clean up mic if setup failed
      await cleanupDictationAudio()
      await stopDictationRecorderIfActive()
      aiModeActive = false
      resetDictationSessionState('aimode')
    }
  } async function stopAIModeFlow() {
    try {
      if (!aiModeActive) return

      // DON'T set aiModeActive = false yet - we need to flush remaining audio first
      // (matching the pattern used in stopDictationFlow)

      // Flush any residual samples from the worklet to avoid cutting off last words
      try { if (dictNode) await flushWorklet(dictNode) } catch { }
      await new Promise(r => setTimeout(r, 150))

      // Now stop accepting new chunks
      aiModeActive = false

      await cleanupDictationAudio()

      let pasted = false
      try {
        const useBufferTranscription = true
        if (dictPcmBuffers.length) {
          const totalSamples = dictPcmBuffers.reduce((a, b) => a + b.length, 0)
          // Main already rejects holds under 2s; the screenshot + mic startup shortens the capture.
          if (totalSamples < MIN_TRANSCRIBE_SAMPLES) {
            console.log('Agentic Dictation: Audio too short, skipping transcription')
            await window.aimode?.paste('')
            pasted = true
          } else {
            const merged = new Int16Array(totalSamples)
            let off = 0
            for (const part of dictPcmBuffers) { merged.set(part, off); off += part.length }
            const wavBuf = pcm16ToWav(merged, 16000)
            if (useBufferTranscription) {
              const api = await window.electronAPI.apiTranscribeBuffer(wavBuf, { isAIMode: true })
              if (api.ok && (api.text || '').trim()) {
                const text = (api.text || '').trim()
                await window.aimode?.paste(text)
                pasted = true
                const preview = buildActivityPreview(text)
                addActivityLog(`${preview}`, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z"/><path d="M4 17a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1z"/></svg>', 'dictation', text)
              }
            }
          }
        }
      } catch { }

      // Stop file recording if active
      if (dictWavRecording) {
        dictWavRecording = false
        const stop = await window.electronAPI.wavrecStop()
        const recordedRecordingId = stop.ok ? stop.recordingId : null

        // If memory path failed, try file path
        if (!pasted && recordedRecordingId) {
          const api = await transcribeRecording(recordedRecordingId, { deleteInput: true, isAIMode: true })
          if (api.ok && (('text' in api ? api.text : '') || '').trim()) {
            const text = (('text' in api ? api.text : '') || '').trim()
            await window.aimode?.paste(text)
            pasted = true
            const preview = buildActivityPreview(text)
            addActivityLog(`${preview}`, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z"/><path d="M4 17a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1a1 1 0 0 0-1-1z"/></svg>', 'dictation', text)
          }
        } else if (pasted && recordedRecordingId) {
          // Memory path succeeded - clean up the wav file
          window.electronAPI.deleteTempRecording(recordedRecordingId).catch(() => { })
        }
      }

      if (!pasted) {
        // Ensure HUD is closed even if transcription failed completely
        await window.aimode?.paste('')
      }
    } catch { }
    finally {
      await cleanupDictationAudio()
      resetDictationSessionState('aimode')
    }
  }

  window.dictation?.onStart(() => { startDictationFlow().catch(() => { }) })
  window.dictation?.onStop(() => { stopDictationFlow().catch(() => { }) })

  window.aimode?.onStart(() => { startAIModeFlow().catch(() => { }) })
  window.aimode?.onStop(() => { stopAIModeFlow().catch(() => { }) })

  // Flush helper for AudioWorklet to emit remaining samples
  async function flushWorklet(node: AudioWorkletNode): Promise<void> {
    return await new Promise<void>((resolve) => {
      let done = false
      const handler = (ev: any) => {
        try {
          const d = ev?.data || {}
          if (d.type === 'flushed') {
            done = true
            try { (node.port as any)?.removeEventListener?.('message', handler) } catch { }
            resolve()
          }
        } catch { }
      }
      try { (node.port as any)?.addEventListener?.('message', handler) } catch { }
      try { node.port.postMessage({ type: 'flush' }) } catch { resolve() }
      setTimeout(() => { if (!done) { try { (node.port as any)?.removeEventListener?.('message', handler) } catch { }; resolve() } }, 80)
    })
  }

  // Cleanup for summarization only (do not alter raw transcript)
  function cleanupForSummary(text: string): string {
    try {
      const fillers = /\b(um+|uh+|uhm|erm|er|like|you know|sort of|kind of)\b/gi
      return text.replace(fillers, '').replace(/\s{2,}/g, ' ').trim()
    } catch { return text }
  }

  // ---- Notes UI wiring ----
  function fileTitleFromId(id: string): string { return (id || '').replace(/\.txt$/i, '') }
  function markActiveInList(id: string) {
    try {
      if (!notesListUI) return
      notesListUI.querySelectorAll('li.nav-item').forEach(li => {
        const lid = (li as HTMLElement).getAttribute('data-id')
        if (lid === id) {
          li.classList.add('active')
          li.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        } else {
          li.classList.remove('active')
        }
      })
    } catch (error) {
      console.error('Error marking active note:', error)
    }
  }
  // TipTap Editor Logic
  function debounce(func: Function, wait: number) {
    let saveTimeout: ReturnType<typeof setTimeout> | null = null
    return (...args: any[]) => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        func(...args);
      }, wait);
    };
  }

  async function saveNoteNow(noteId: string, content?: string) {
    if (!noteId || !editorInstance) return;
    if (noteId !== currentNoteId) return;

    const markdown = content ?? (editorInstance.storage as any).markdown.getMarkdown();
    if (noteId === lastSavedNoteId && markdown === lastSavedMarkdown) return;

    try {
      if (noteSaveStatusEl) {
        noteSaveStatusEl.textContent = 'Saving...'
        noteSaveStatusEl.className = 'save-status saving'
      }

      const res = await window.electronAPI.notesSave(noteId, markdown)
      if (res?.ok) {
        lastSavedNoteId = noteId
        lastSavedMarkdown = markdown
      }

      if (noteSaveStatusEl) {
        noteSaveStatusEl.textContent = 'All changes saved'
        noteSaveStatusEl.className = 'save-status'
      }

      // Update sidebar state (preview etc) without full refresh if possible, or just refresh
      // await refreshNotes() // Optional: might be too heavy on every save
    } catch (e) {
      console.error('Save error:', e);
      if (noteSaveStatusEl) {
        noteSaveStatusEl.textContent = 'Error saving'
        noteSaveStatusEl.className = 'save-status error'
      }
    }
  }

  const saveNoteDebounced = debounce(saveNoteNow, 1000); // 1 second debounce

  function loadNoteIntoEditor(content: string, noteId: string) {
    if (editorInstance) {
      editorInstance.destroy();
      editorInstance = null;
    }

    const element = document.getElementById('editor-container');
    if (!element) return;

    editorInstance = new Editor({
      element: element,
      extensions: [
        StarterKit,
        Markdown,
      ],
      content: content,
      editorProps: {
        attributes: {
          class: 'ProseMirror',
          spellcheck: 'false',
        },
      },
      onUpdate: ({ editor }) => {
        saveNoteDebounced(currentNoteId);
        updateWordCountDebounced();
      },
    });
  }

  async function loadNoteById(id: string) {
    try {
      if (!id) return
      currentNoteId = id
      const res = await window.electronAPI.notesRead(id)
      const text = res.ok ? stripLeadingTitles(res.text || '') : ''

      // Parse and display title/timestamp logic remains...
      const fullName = fileTitleFromId(id)
      const match = fullName.match(/^(\d{4}-\d{2}-\d{2}\s+\d{4,6})\s*-\s*(.+)$/)
      const rawTimestamp = match ? match[1] : ''
      const title = match ? match[2] : fullName
      let formattedTimestamp = ''
      const cached = getNotesCache().find(note => note.id === id)
      const createdAt = cached && Number.isFinite(cached.createdAt) ? cached.createdAt : 0
      if (createdAt) {
        const date = new Date(createdAt)
        const monthName = date.toLocaleDateString('en-US', { month: 'short' })
        const day = date.getDate()
        const year = date.getFullYear()
        const hour = String(date.getHours()).padStart(2, '0')
        const minute = String(date.getMinutes()).padStart(2, '0')
        formattedTimestamp = `${monthName} ${day}, ${year} at ${hour}:${minute}`
      } else if (rawTimestamp) {
        const tsMatch = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(\d{2})?$/)
        if (tsMatch) {
          const [, year, month, day, hour, minute, second] = tsMatch
          const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), second ? parseInt(second) : 0)
          const monthName = date.toLocaleDateString('en-US', { month: 'short' })
          formattedTimestamp = `${monthName} ${parseInt(day)}, ${year} at ${hour}:${minute}`
        }
      }

      if (noteTitleEl) noteTitleEl.value = title
      const timestampEl = document.getElementById('noteTitleTimestamp')
      if (timestampEl) timestampEl.textContent = formattedTimestamp

      // Initialize TipTap Editor
      loadNoteIntoEditor(text, id);
      lastSavedNoteId = id
      lastSavedMarkdown = text

      // Focus the editor
      if (editorInstance) {
        editorInstance.commands.focus()
      }

      if (noteSaveStatusEl) {
        noteSaveStatusEl.textContent = 'All changes saved'
        noteSaveStatusEl.className = 'save-status'
      }
      updateWordCount(text)
      updateButtonStates()
      markActiveInList(id)
    } catch (e) { console.error(e) }
  }

  const updateWordCountDebounced = () => {
    clearTimeout(wordCountTimeout);
    wordCountTimeout = setTimeout(() => {
      if (editorInstance) {
        const markdown = (editorInstance.storage as any).markdown.getMarkdown();
        updateWordCount(markdown);
      }
    }, 500);
  };

  function updateWordCount(text?: string) {
    const wordCount = document.getElementById('wordCount')
    // If text is not provided, try to get from editor if safe, otherwise ignore
    if (wordCount && typeof text === 'string') {
      const words = text.split(/\s+/).filter(w => w.length > 0).length
      wordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`
    }
  }

  function updateButtonStates() {
    const hasNote = !!currentNoteId
    const renameBtn = document.getElementById('noteRename') as HTMLButtonElement | null
    const deleteBtn = document.getElementById('noteDelete') as HTMLButtonElement | null

    if (renameBtn) renameBtn.disabled = !hasNote
    if (deleteBtn) deleteBtn.disabled = !hasNote
  }

  // Delete modal state (moved here so renderNotesList can access it)
  let deleteModalOpen = false
  let pendingDeleteId: string | null = null

  async function renderNotesList(items: { id: string; name: string; preview: string; mtime: number; size: number; createdAt: number }[]) {
    if (!notesListUI) return

    const normalized = Array.isArray(items) ? items : []

    const notesCount = document.getElementById('notesCount')
    if (notesCount) notesCount.textContent = normalized.length.toString()

    // Format timestamp nicely (e.g., "Nov 25, 18:28")
    const formatTimestamp = (ts: string): string => {
      // Parse "2024-11-25 1828" or "2024-11-25 182800" format
      const match = ts.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(\d{2})?$/)
      if (!match) return ts
      const [, year, month, day, hour, minute, second] = match
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), second ? parseInt(second) : 0)
      const monthName = date.toLocaleDateString('en-US', { month: 'short' })
      return `${monthName} ${parseInt(day)}, ${hour}:${minute}`
    }
    const formatTimestampMs = (ms: number): string => {
      const date = new Date(ms)
      const monthName = date.toLocaleDateString('en-US', { month: 'short' })
      const day = date.getDate()
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return `${monthName} ${day}, ${hour}:${minute}`
    }

    notesListUI.innerHTML = normalized.map(it => {
      const fullName = it.name.replace(/\.txt$/i, '')
      const match = fullName.match(/^(\d{4}-\d{2}-\d{2}\s+\d{4,6})\s*-\s*(.+)$/)
      const rawTimestamp = match ? match[1] : ''
      const createdAt = Number.isFinite(it.createdAt) ? it.createdAt : 0
      const timestamp = createdAt ? formatTimestampMs(createdAt) : (rawTimestamp ? formatTimestamp(rawTimestamp) : '')
      const title = match ? match[2] : fullName

      return `
        <li class="nav-item" data-id="${escapeHtmlAttr(it.id)}">
          <div class="note-item-content">
            <div class="note-title-row">
              <span class="note-title">${escapeHtml(title)}</span>
              <span class="note-timestamp">${escapeHtml(timestamp)}</span>
              <button class="note-delete-btn" data-id="${escapeHtmlAttr(it.id)}" title="Delete note">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
            <div class="note-preview"></div>
          </div>
        </li>
      `
    }).join('')

    const listItems = Array.from(notesListUI.querySelectorAll('li.nav-item')) as HTMLElement[]
    listItems.forEach((li, index) => {
      const item = normalized[index]
      if (!item) return

      const previewEl = li.querySelector('.note-preview') as HTMLElement | null
      if (previewEl) {
        previewEl.textContent = item.preview && item.preview.trim() ? item.preview : 'Empty note'
      }

      // Click on note item to load (entire li is clickable)
      li.style.cursor = 'pointer'
      li.addEventListener('click', async (e) => {
        // Don't load note if clicking delete button
        if ((e.target as HTMLElement)?.closest('.note-delete-btn')) return
        const id = li.getAttribute('data-id')!
        await loadNoteById(id)
        setView('notes')
      })

      // Delete button on each note
      const deleteBtn = li.querySelector('.note-delete-btn') as HTMLButtonElement | null
      console.log('Setting up delete button for note:', item.id, 'deleteBtn found:', !!deleteBtn)
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
          console.log('Delete button clicked for note:', item.id)
          e.preventDefault()
          e.stopPropagation()
          const noteId = deleteBtn.getAttribute('data-id')
          console.log('noteId from data-id:', noteId)
          if (!noteId) return

          // Show delete confirmation
          const deleteModal = document.getElementById('deleteConfirmModal')
          const deleteMessage = document.getElementById('deleteConfirmMessage')
          console.log('deleteModal found:', !!deleteModal, 'deleteMessage found:', !!deleteMessage)
          if (!deleteModal || !deleteMessage) return

          const noteTitle = item.name.replace(/\.txt$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+\d{4}\s*-\s*/, '')
          pendingDeleteId = noteId
          deleteMessage.textContent = `Delete "${noteTitle}"?`
          deleteModal.style.display = 'flex'
          deleteModalOpen = true
        })
      }
    })

    if (currentNoteId) markActiveInList(currentNoteId)
  }

  // New Note button functionality (must be after saveNoteDebounced is defined)
  function markMeetingNoteActive(id: string) {
    try {
      if (!meetingNotesList) return
      meetingNotesList.querySelectorAll('li.nav-item').forEach(li => {
        const lid = (li as HTMLElement).getAttribute('data-id')
        if (lid === id) {
          li.classList.add('active')
          li.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        } else {
          li.classList.remove('active')
        }
      })
    } catch (error) {
      console.error('Error marking active meeting note:', error)
    }
  }

  function renderMeetingNoteEmpty(title: string, message: string) {
    if (meetingNoteTitleEl) meetingNoteTitleEl.textContent = title
    if (meetingNoteTimestampEl) meetingNoteTimestampEl.textContent = ''
    if (meetingNoteContentEl) {
      meetingNoteContentEl.innerHTML = `<div class="meeting-notes-empty">${message}</div>`
    }
  }

  async function loadMeetingNoteById(id: string) {
    try {
      if (!id) return
      currentMeetingNoteId = id
      const res = await window.electronAPI.notesRead(id)
      const rawText = res.ok ? (res.text || '') : ''
      const text = stripLeadingTitles(rawText)

      const fullName = fileTitleFromId(id)
      const match = fullName.match(/^(\d{4}-\d{2}-\d{2}\s+\d{4,6})\s*-\s*(.+)$/)
      const rawTimestamp = match ? match[1] : ''
      const title = match ? match[2] : fullName
      let formattedTimestamp = ''
      const cached = getNotesCache().find(note => note.id === id)
      const createdAt = cached && Number.isFinite(cached.createdAt) ? cached.createdAt : 0
      if (createdAt) {
        const date = new Date(createdAt)
        const monthName = date.toLocaleDateString('en-US', { month: 'short' })
        const day = date.getDate()
        const year = date.getFullYear()
        const hour = String(date.getHours()).padStart(2, '0')
        const minute = String(date.getMinutes()).padStart(2, '0')
        formattedTimestamp = `${monthName} ${day}, ${year} at ${hour}:${minute}`
      } else if (rawTimestamp) {
        const tsMatch = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(\d{2})?$/)
        if (tsMatch) {
          const [, year, month, day, hour, minute, second] = tsMatch
          const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), second ? parseInt(second) : 0)
          const monthName = date.toLocaleDateString('en-US', { month: 'short' })
          formattedTimestamp = `${monthName} ${parseInt(day)}, ${year} at ${hour}:${minute}`
        }
      }

      if (meetingNoteTitleEl) meetingNoteTitleEl.textContent = title
      if (meetingNoteTimestampEl) meetingNoteTimestampEl.textContent = formattedTimestamp
      if (meetingNoteContentEl) {
        meetingNoteContentEl.innerHTML = text ? renderMarkdown(text) : '<div class="meeting-notes-empty">This note is empty.</div>'
        meetingNoteContentEl.scrollTop = 0
      }
      markMeetingNoteActive(id)
    } catch (e) {
      console.error('Failed to load meeting note:', e)
    }
  }

  async function renderMeetingNotesList(items: { id: string; name: string; preview: string; mtime: number; size: number; createdAt: number }[]) {
    if (!meetingNotesList) return

    const normalized = Array.isArray(items) ? items : []

    if (meetingNotesCount) meetingNotesCount.textContent = normalized.length.toString()

    const formatTimestamp = (ts: string): string => {
      const match = ts.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(\d{2})?$/)
      if (!match) return ts
      const [, year, month, day, hour, minute, second] = match
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute), second ? parseInt(second) : 0)
      const monthName = date.toLocaleDateString('en-US', { month: 'short' })
      return `${monthName} ${parseInt(day)}, ${hour}:${minute}`
    }
    const formatTimestampMs = (ms: number): string => {
      const date = new Date(ms)
      const monthName = date.toLocaleDateString('en-US', { month: 'short' })
      const day = date.getDate()
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return `${monthName} ${day}, ${hour}:${minute}`
    }

    meetingNotesList.innerHTML = normalized.map(it => {
      const fullName = it.name.replace(/\.txt$/i, '')
      const match = fullName.match(/^(\d{4}-\d{2}-\d{2}\s+\d{4,6})\s*-\s*(.+)$/)
      const rawTimestamp = match ? match[1] : ''
      const createdAt = Number.isFinite(it.createdAt) ? it.createdAt : 0
      const timestamp = createdAt ? formatTimestampMs(createdAt) : (rawTimestamp ? formatTimestamp(rawTimestamp) : '')
      const title = match ? match[2] : fullName

      return `
        <li class="nav-item" data-id="${escapeHtmlAttr(it.id)}">
          <div class="note-item-content">
            <div class="note-title-row">
              <span class="note-title">${escapeHtml(title)}</span>
              <span class="note-timestamp">${escapeHtml(timestamp)}</span>
            </div>
            <div class="note-preview"></div>
          </div>
        </li>
      `
    }).join('')

    const listItems = Array.from(meetingNotesList.querySelectorAll('li.nav-item')) as HTMLElement[]
    listItems.forEach((li, index) => {
      const item = normalized[index]
      if (!item) return

      const previewEl = li.querySelector('.note-preview') as HTMLElement | null
      if (previewEl) {
        previewEl.textContent = item.preview && item.preview.trim() ? item.preview : 'Empty note'
      }

      li.addEventListener('click', async (e) => {
        e.stopPropagation()
        const id = li.getAttribute('data-id')!
        await loadMeetingNoteById(id)
      })
    })

    const currentExists = !!currentMeetingNoteId && normalized.some(note => note.id === currentMeetingNoteId)
    if (!currentExists) currentMeetingNoteId = null

    if (currentMeetingNoteId) {
      markMeetingNoteActive(currentMeetingNoteId)
    } else if (normalized.length > 0) {
      await loadMeetingNoteById(normalized[0].id)
    } else {
      renderMeetingNoteEmpty('No meeting notes yet', 'Start a meeting to generate notes.')
    }
  }

  // Subscribe to store changes ONCE outside of renderNotesList
  appStore.subscribe((state, previous) => {
    if (state.notes.items !== previous.notes.items) {
      renderChatNotesNoteList()
      renderChatNotesSelectionSummary()
      void renderNotesList(state.notes.items)
      void renderMeetingNotesList(state.notes.items)
      if (SPEAKING_TRAINER_ENABLED && currentView === 'speaking-trainer') {
        void refreshSpeakingTrainerOverview()
      }
    }
  })
  async function refreshNotes() {
    try {
      const res = await window.electronAPI.notesList()
      if (!res.ok) {
        console.error('Failed to refresh notes:', res.message)
        return
      }
      const mapped = (res.items || []).map(it => ({
        id: it.id,
        name: it.name,
        preview: (it.preview || '').trim(),
        mtime: it.mtime,
        size: it.size,
        createdAt: Number.isFinite(it.createdAt) ? it.createdAt : it.mtime
      }))
      setNotesCache(mapped)
      renderChatNotesNoteList()
      renderChatNotesSelectionSummary()
      // Explicitly render to ensure UI updates
      await renderNotesList(mapped)

      // Clear sidebar notes list per user request
      if (notesSubtree) notesSubtree.innerHTML = ''

      // Only auto-select if no current note is selected
      const cachedNotes = getNotesCache()
      if (!currentNoteId && cachedNotes.length > 0) {
        await loadNoteById(cachedNotes[0].id)
      } else if (currentNoteId) {
        // Ensure the current note is still valid
        const currentNoteExists = cachedNotes.some(note => note.id === currentNoteId)
        if (!currentNoteExists) {
          currentNoteId = null
          if (cachedNotes.length > 0) {
            await loadNoteById(cachedNotes[0].id)
          }
        } else {
          markActiveInList(currentNoteId)
        }
      }
    } catch (error) {
      console.error('Error refreshing notes:', error)
    }
  }
  notesSearch?.addEventListener('input', async () => {
    const q = (notesSearch.value || '').toLowerCase().trim()
    const cachedNotes = getNotesCache()
    const filtered = !q ? cachedNotes : cachedNotes.filter(it => it.name.toLowerCase().includes(q))
    await renderNotesList(filtered)
  })
  meetingNotesSearch?.addEventListener('input', async () => {
    const q = (meetingNotesSearch.value || '').toLowerCase().trim()
    const cachedNotes = getNotesCache()
    const filtered = !q ? cachedNotes : cachedNotes.filter(it => it.name.toLowerCase().includes(q))
    await renderMeetingNotesList(filtered)
  })

  // Debounced title rename - saves as you type without blocking clicks
  let titleRenameTimeout: any = null
  let lastTitleNoteId: string | null = null

  const renameTitleDebounced = debounce(async (noteId: string, newTitle: string) => {
    if (!noteId || !newTitle) return

    // Extract current title from note ID to compare
    const fullName = fileTitleFromId(noteId)
    const match = fullName.match(/^(\d{4}-\d{2}-\d{2}\s+\d{4,6})\s*-\s*(.+)$/)
    const currentTitle = match ? match[2] : fullName

    // Only rename if title actually changed
    if (newTitle === currentTitle) return

    try {
      // Preserve the timestamp prefix if it exists
      const timestampPrefix = match ? match[1] + ' - ' : ''
      const safe = newTitle.replace(/[\\/:*?"<>|]/g, ' ').trim()
      const nextId = (timestampPrefix + safe).toLowerCase().endsWith('.txt')
        ? timestampPrefix + safe
        : timestampPrefix + safe + '.txt'

      // Flush the editor before moving its file so a pending save cannot lose edits.
      await saveNoteNow(noteId)
      const r = await window.electronAPI.notesRename(noteId, nextId)
      if (r.ok) {
        // Only update if this is still the current note
        if (currentNoteId === noteId) {
          currentNoteId = nextId
        }
        await refreshNotes()
        if (currentNoteId === nextId) {
          markActiveInList(nextId)
        }
      } else if (noteSaveStatusEl && currentNoteId === noteId) {
        noteSaveStatusEl.textContent = `Title not saved: ${r.message || 'rename failed'}`
        noteSaveStatusEl.className = 'save-status'
      }
    } catch (e) {
      console.error('Error renaming note:', e)
    }
  }, 1000) // 1 second debounce like the editor

  // Handle title editing - auto-save as user types
  noteTitleEl?.addEventListener('input', () => {
    if (!currentNoteId || !noteTitleEl) return
    const newTitle = noteTitleEl.value.trim()
    if (!newTitle) return
    renameTitleDebounced(currentNoteId, newTitle)
  })

  // Share the open note: copy or save as Markdown, or start an email. Nothing is uploaded.
  const noteShareBtn = document.getElementById('noteShareBtn') as HTMLButtonElement | null
  const noteShareMenu = document.getElementById('noteShareMenu') as HTMLElement | null
  const setShareMenuOpen = (open: boolean) => {
    if (!noteShareMenu || !noteShareBtn) return
    noteShareMenu.hidden = !open
    noteShareBtn.setAttribute('aria-expanded', String(open))
  }
  const flashShareStatus = (text: string) => {
    if (!noteSaveStatusEl) return
    noteSaveStatusEl.textContent = text
    noteSaveStatusEl.className = 'save-status'
  }
  noteShareBtn?.addEventListener('click', (event) => {
    event.stopPropagation()
    setShareMenuOpen(!!noteShareMenu?.hidden && !!currentNoteId)
  })
  document.addEventListener('click', () => setShareMenuOpen(false))
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setShareMenuOpen(false) })
  noteShareMenu?.addEventListener('click', async (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-share]')?.dataset.share
    if (!action || !currentNoteId || !editorInstance) return
    setShareMenuOpen(false)
    await saveNoteNow(currentNoteId)
    const title = noteTitleEl?.value.trim() || fileTitleFromId(currentNoteId)
    const markdown = buildNoteMarkdown(title, (editorInstance.storage as any).markdown.getMarkdown())
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(markdown)
        flashShareStatus('Copied as Markdown')
      } else if (action === 'file') {
        const result = await window.electronAPI.exportSaveAs({
          suggestedName: noteExportFileName(title),
          text: markdown,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
        if (result.ok) flashShareStatus('Saved as Markdown')
      } else if (action === 'email') {
        await window.electronAPI.openExternal(buildNoteMailto(title, markdown))
      }
    } catch (error: any) {
      flashShareStatus(`Share failed: ${error?.message ?? error}`)
    }
  })

  // Handle Enter key to move focus to editor
  noteTitleEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Focus the editor
      if (editorInstance) {
        editorInstance.commands.focus()
      }
    }
  })

  noteRenameBtn?.addEventListener('click', async () => {
    try {
      if (!currentNoteId) return
      const cur = currentNoteId
      const nextTitle = prompt('New name (without extension):', cur.replace(/\.txt$/i, ''))
      if (!nextTitle) return
      const safe = nextTitle.replace(/[\\/:*?\"<>|]/g, ' ').trim()
      const nextId = safe.toLowerCase().endsWith('.txt') ? safe : safe + '.txt'
      const r = await window.electronAPI.notesRename(cur, nextId)
      if (r.ok) { await refreshNotes(); currentNoteId = nextId; if (noteTitleEl) noteTitleEl.value = safe }
    } catch { }
  })
  navNotes?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.closest('.sub-item')) return
    setView('notes')
    const isOpen = navNotes.classList.contains('open')
    navNotes.classList.toggle('open', !isOpen)
    if (!isOpen) {
      refreshNotes()
    }
  })
  noteNewBtn?.addEventListener('click', async () => {
    try {
      // Create without blocking prompt to avoid UX and IPC errors
      const result = await window.electronAPI.notesCreate({ title: 'Note' })
      if (result.ok) {
        // Ensure we are in Notes view
        try { setView('notes') } catch { }
        await refreshNotes()
        currentNoteId = result.id || null
        if (currentNoteId) {
          await loadNoteById(currentNoteId)
          // Focus the editor
          if (editorInstance) {
            editorInstance.commands.focus()
          }
        }
      } else {
        console.error('Create note failed:', result?.message)
        alert('Failed to create note. Please try again.')
      }
    } catch (error) {
      console.error('Error creating note:', error)
      alert('An error occurred while creating the note.')
    }
  })
  noteDeleteBtn?.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()

    if (!currentNoteId || deleteModalOpen) return
    const noteTitle = (noteTitleEl?.value || 'this note').replace('.txt', '')

    // Show custom delete confirmation modal
    const deleteModal = document.getElementById('deleteConfirmModal')
    const deleteMessage = document.getElementById('deleteConfirmMessage')

    if (!deleteModal || !deleteMessage) {
      console.error('Delete modal elements not found')
      return
    }

    pendingDeleteId = currentNoteId
    deleteMessage.textContent = `Delete "${noteTitle}"?`
    deleteModal.style.display = 'flex'
    deleteModalOpen = true
  })

  // Set up delete modal buttons once
  document.getElementById('deleteConfirmOk')?.addEventListener('click', async () => {
    const deleteModal = document.getElementById('deleteConfirmModal')
    if (!deleteModal || !pendingDeleteId) return

    const deleteId = pendingDeleteId
    const deletedWasCurrent = deleteId === currentNoteId

    deleteModal.style.display = 'none'
    deleteModalOpen = false

    try {
      const result = await window.electronAPI.notesDelete(deleteId)
      if (result.ok) {
        pendingDeleteId = null

        // Only clear the editor if the deleted note is currently opened.
        if (deletedWasCurrent) {
          currentNoteId = null
          lastSavedNoteId = null
          lastSavedMarkdown = ''
          if (editorInstance) {
            editorInstance.commands.setContent('')
          }
          if (noteTitleEl) noteTitleEl.value = ''
          const timestampEl = document.getElementById('noteTitleTimestamp')
          if (timestampEl) timestampEl.textContent = ''
          if (noteSaveStatusEl) {
            noteSaveStatusEl.textContent = 'No note selected'
            noteSaveStatusEl.className = 'save-status'
          }
        }

        await refreshNotes()
        updateButtonStates()
      } else {
        pendingDeleteId = null
        const errorMsg = result.message || 'Unknown error'
        alert(`Failed to delete note: ${errorMsg}\n\nThe file may be locked, read-only, or have permission issues.`)
        appendProgress(`Delete failed: ${errorMsg}`)
      }
    } catch (error: any) {
      pendingDeleteId = null
      alert(`An error occurred while deleting the note: ${error?.message || 'Unknown error'}`)
      appendProgress(`Delete exception: ${error?.message || 'Unknown error'}`)
      console.error('Delete error:', error)
    }
  })

  document.getElementById('deleteConfirmCancel')?.addEventListener('click', () => {
    const deleteModal = document.getElementById('deleteConfirmModal')
    if (!deleteModal) return
    deleteModal.style.display = 'none'
    deleteModalOpen = false
    pendingDeleteId = null
  })
  // Quitting or relaunching: write the open note now instead of losing the debounce window.
  window.lifecycle?.onFlushRequest(async () => {
    if (currentNoteId) await saveNoteNow(currentNoteId)
  })

  // --- AI Providers ---
  const aiTaskConfigs: Array<{
    task: AiTask
    supports: (provider: AiProviderInfo) => boolean
    suggestedModels: (provider: AiProviderInfo) => string[]
  }> = [
    { task: 'chat', supports: (p) => p.supportsChat, suggestedModels: (p) => p.chatModels },
    { task: 'vision', supports: (p) => p.supportsChat, suggestedModels: (p) => p.chatModels },
    { task: 'transcription', supports: (p) => p.supportsTranscription, suggestedModels: (p) => p.transcriptionModels }
  ]
  const aiSetupBanner = document.getElementById('aiSetupBanner') as HTMLElement | null
  const aiSetupBtn = document.getElementById('aiSetupBtn') as HTMLButtonElement | null
  const aiSetupClose = document.getElementById('aiSetupClose') as HTMLButtonElement | null
  const aiProvidersSection = document.getElementById('aiProvidersSection') as HTMLElement | null
  const aiKeychainWarning = document.getElementById('aiKeychainWarning') as HTMLElement | null
  const aiSettingsStatus = document.getElementById('aiSettingsStatus') as HTMLElement | null
  const aiLiveDictationEl = document.getElementById('aiLiveDictation') as HTMLInputElement | null
  const aiProviderListEl = document.getElementById('aiProviderList') as HTMLElement | null
  const AI_SETUP_DISMISSED_KEY = 'aiSetupBannerDismissed'
  let aiSnapshot: AiSettingsSnapshot | null = null
  let aiStatusTimer: ReturnType<typeof setTimeout> | null = null
  const loadedAiModels = new Map<string, string[]>()

  function createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  function getAiProviderInfo(providerId: string): AiProviderInfo | undefined {
    return aiSnapshot?.providers.find((provider) => provider.id === providerId)
  }

  function getAiModelSuggestions(task: AiTask, providerId: string): string[] {
    const provider = getAiProviderInfo(providerId)
    const config = aiTaskConfigs.find((entry) => entry.task === task)
    if (!provider || !config) return []
    return [...new Set([...config.suggestedModels(provider), ...(loadedAiModels.get(providerId) ?? [])])]
  }

  function showAiSettingsStatus(message: string, isError = false) {
    if (!aiSettingsStatus) return
    aiSettingsStatus.textContent = message
    aiSettingsStatus.classList.toggle('error', isError)
    if (aiStatusTimer) clearTimeout(aiStatusTimer)
    if (!isError) {
      aiStatusTimer = setTimeout(() => { aiSettingsStatus.textContent = '' }, 2000)
    }
  }

  function updateAiSetupBanner() {
    if (!aiSetupBanner || !aiSnapshot) return
    let dismissed = false
    try { dismissed = localStorage.getItem(AI_SETUP_DISMISSED_KEY) === 'true' } catch { }
    const { chat, transcription } = aiSnapshot.settings
    const needsSetup = !chat.provider || !transcription.provider
    aiSetupBanner.style.display = needsSetup && !dismissed ? 'flex' : 'none'
  }

  function renderAiModelSuggestions(task: AiTask) {
    const providerEl = document.getElementById(`ai-${task}-provider`) as HTMLSelectElement | null
    const listEl = document.getElementById(`ai-${task}-models`) as HTMLDataListElement | null
    if (!providerEl || !listEl) return
    listEl.replaceChildren(...getAiModelSuggestions(task, providerEl.value).map((model) => {
      const option = document.createElement('option')
      option.value = model
      return option
    }))
  }

  async function saveAiSettings(next: AiSettings) {
    try {
      aiSnapshot = await window.electronAPI.ai.setSettings(next)
      showAiSettingsStatus('Saved')
      updateAiSetupBanner()
    } catch (error: any) {
      showAiSettingsStatus(error?.message || 'Failed to save', true)
    }
  }

  function saveAiTask(task: AiTask) {
    if (!aiSnapshot) return
    const providerEl = document.getElementById(`ai-${task}-provider`) as HTMLSelectElement | null
    const modelEl = document.getElementById(`ai-${task}-model`) as HTMLInputElement | null
    if (!providerEl || !modelEl) return
    const selection = { provider: providerEl.value as AiSettings['chat']['provider'], model: modelEl.value.trim() }
    void saveAiSettings({ ...aiSnapshot.settings, [task]: selection })
  }

  function renderAiTaskPickers() {
    if (!aiSnapshot) return
    const { settings, providers } = aiSnapshot
    for (const { task, supports } of aiTaskConfigs) {
      const providerEl = document.getElementById(`ai-${task}-provider`) as HTMLSelectElement | null
      const modelEl = document.getElementById(`ai-${task}-model`) as HTMLInputElement | null
      if (!providerEl || !modelEl) continue

      const unsetOption = document.createElement('option')
      unsetOption.value = ''
      unsetOption.textContent = task === 'vision' ? 'Same as chat' : 'Not set'
      providerEl.replaceChildren(unsetOption, ...providers.filter(supports).map((provider) => {
        const option = document.createElement('option')
        option.value = provider.id
        option.textContent = provider.label
        return option
      }))
      providerEl.value = settings[task].provider
      modelEl.value = settings[task].model
      renderAiModelSuggestions(task)

      providerEl.onchange = () => {
        modelEl.value = getAiModelSuggestions(task, providerEl.value)[0] ?? ''
        renderAiModelSuggestions(task)
        saveAiTask(task)
      }
      modelEl.onchange = () => saveAiTask(task)
    }
    if (aiLiveDictationEl) aiLiveDictationEl.checked = settings.liveDictation
  }

  function buildAiKeyField(
    provider: AiProviderInfo,
    last4: string | undefined,
    setStatus: (message: string, isError?: boolean) => void
  ): HTMLElement {
    const field = createElement('div', 'ai-field')
    field.appendChild(createElement('label', undefined, 'API key'))
    const row = createElement('div', 'ai-field-row')

    const input = createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.placeholder = last4 ? 'Paste a new key to replace it' : 'Paste your API key'
    row.appendChild(input)

    const submitKey = async (key: string) => {
      try {
        const result = await window.electronAPI.ai.setKey(provider.id, key)
        if ('message' in result) {
          setStatus(result.message || 'Failed to save key', true)
          return
        }
        aiSnapshot = result
        renderAiProviders()
        updateAiSetupBanner()
      } catch (error: any) {
        setStatus(error?.message || 'Failed to save key', true)
      }
    }

    const saveBtn = createElement('button', 'primary small', 'Save')
    saveBtn.addEventListener('click', () => {
      const key = input.value.trim()
      input.value = ''
      if (key) void submitKey(key)
    })
    row.appendChild(saveBtn)

    if (last4) {
      const clearBtn = createElement('button', 'small', 'Clear')
      clearBtn.addEventListener('click', () => { void submitKey('') })
      row.appendChild(clearBtn)
    }

    if (provider.keyUrl) {
      const keyUrl = provider.keyUrl
      const link = createElement('a', 'ai-link', 'Get a key')
      link.href = keyUrl
      link.addEventListener('click', (event) => {
        event.preventDefault()
        window.electronAPI.openExternal(keyUrl).catch(() => { })
      })
      row.appendChild(link)
    }

    field.appendChild(row)
    return field
  }

  function buildAiServerUrlField(provider: AiProviderInfo, currentUrl: string): HTMLElement {
    const field = createElement('div', 'ai-field')
    field.appendChild(createElement('label', undefined, 'Server URL'))
    const input = createElement('input')
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = provider.baseUrl
    input.value = currentUrl
    input.addEventListener('change', async () => {
      if (!aiSnapshot) return
      const baseUrls = { ...aiSnapshot.settings.baseUrls }
      const url = input.value.trim()
      if (url) baseUrls[provider.id] = url
      else delete baseUrls[provider.id]
      await saveAiSettings({ ...aiSnapshot.settings, baseUrls })
      input.value = aiSnapshot?.settings.baseUrls[provider.id] ?? ''
    })
    field.appendChild(input)
    return field
  }

  function buildAiTestRow(provider: AiProviderInfo, statusEl: HTMLElement): HTMLElement {
    const row = createElement('div', 'ai-field-row')
    const button = createElement('button', 'small', 'Test / load models')
    button.addEventListener('click', async () => {
      button.disabled = true
      statusEl.textContent = 'Testing...'
      statusEl.classList.remove('error')
      try {
        const result = await window.electronAPI.ai.listModels(provider.id)
        if (result.ok) {
          loadedAiModels.set(provider.id, result.models)
          aiTaskConfigs.forEach(({ task }) => renderAiModelSuggestions(task))
          statusEl.textContent = `Connected, ${result.models.length} model${result.models.length === 1 ? '' : 's'}`
        } else {
          statusEl.textContent = result.message || 'Could not connect'
          statusEl.classList.add('error')
        }
      } catch (error: any) {
        statusEl.textContent = error?.message || 'Could not connect'
        statusEl.classList.add('error')
      } finally {
        button.disabled = false
      }
    })
    row.append(button, statusEl)
    return row
  }

  function buildAiProviderRow(provider: AiProviderInfo, snapshot: AiSettingsSnapshot): HTMLDetailsElement {
    const details = createElement('details', 'ai-provider')
    details.dataset.provider = provider.id

    const summary = createElement('summary', 'ai-provider-summary')
    summary.appendChild(createElement('span', 'ai-provider-name', provider.label))
    if (provider.local) summary.appendChild(createElement('span', 'ai-tag', 'Local'))
    const last4 = snapshot.keys[provider.id]?.last4
    if (last4) summary.appendChild(createElement('span', 'ai-key-state', `Key saved ••••${last4}`))
    details.appendChild(summary)

    const body = createElement('div', 'ai-provider-body')
    const statusEl = createElement('span', 'ai-provider-status')
    if (provider.requiresKey) {
      body.appendChild(buildAiKeyField(provider, last4, (message, isError = false) => {
        statusEl.textContent = message
        statusEl.classList.toggle('error', isError)
      }))
    }
    if (provider.local) {
      body.appendChild(buildAiServerUrlField(provider, snapshot.settings.baseUrls[provider.id] ?? ''))
    }
    if (provider.canListModels) {
      body.appendChild(buildAiTestRow(provider, statusEl))
    } else {
      body.appendChild(statusEl)
    }
    details.appendChild(body)
    return details
  }

  function renderAiProviders() {
    if (!aiProviderListEl || !aiSnapshot) return
    const snapshot = aiSnapshot
    const openProviders = new Set(
      Array.from(aiProviderListEl.querySelectorAll<HTMLDetailsElement>('details[open]')).map((el) => el.dataset.provider)
    )
    aiProviderListEl.replaceChildren(...snapshot.providers.map((provider) => {
      const row = buildAiProviderRow(provider, snapshot)
      row.open = openProviders.has(provider.id)
      return row
    }))
  }

  async function loadAiSettings() {
    try {
      aiSnapshot = await window.electronAPI.ai.getSettings()
      if (aiKeychainWarning) aiKeychainWarning.style.display = aiSnapshot.encrypted ? 'none' : 'block'
      renderAiTaskPickers()
      renderAiProviders()
      updateAiSetupBanner()
    } catch (error) {
      console.error('Failed to load AI settings:', error)
    }
  }

  aiLiveDictationEl?.addEventListener('change', () => {
    if (!aiSnapshot) return
    void saveAiSettings({ ...aiSnapshot.settings, liveDictation: aiLiveDictationEl.checked })
  })

  aiSetupBtn?.addEventListener('click', () => {
    setView('settings')
    aiProvidersSection?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  aiSetupClose?.addEventListener('click', () => {
    try { localStorage.setItem(AI_SETUP_DISMISSED_KEY, 'true') } catch { }
    if (aiSetupBanner) aiSetupBanner.style.display = 'none'
  })

  void loadAiSettings()

  // Pre-warm Deepgram token on initial load, delayed so it doesn't block critical UI initialization
  setTimeout(() => {
    prewarmDeepgramToken()
  }, 1000)

})
