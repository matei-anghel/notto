import { app, BrowserWindow, ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import WebSocket from 'ws'
import { IPC } from '../shared/ipcChannels'
import { screenshotHelper } from './ScreenshotHelper'
import { TempRecordingStore } from './tempRecordingStore'
import { chatCompletion, getLiveDictationKey, getLiveDictationModel, getTranscriptionChunkBytes, transcribeAudio } from './ai/aiClient'
import { buildAiModeSystemPrompt } from './ai/prompts'

interface AudioIpcDependencies {
  getPrefs: () => any
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
  tempRecordingStore: TempRecordingStore
  isRecordingPaused: () => boolean
  getAiModeScreenshotId: () => string | null
  clearAiModeScreenshotId: () => void
  getMainWindow: () => BrowserWindow | null
}

type WavState = {
  active: boolean
  filePath: string | null
  recordingId: string | null
  fd: number | null
  bytesPCM: number
  sampleRate: number
  numChannels: number
  bitsPerSample: number
}

type WebmState = {
  active: boolean
  filePath: string | null
  recordingId: string | null
  writeStream: fs.WriteStream | null
  bytesWritten: number
}

const MIN_WAV_CHUNK_SECONDS = 30
const DEEPGRAM_STREAMING_CONCURRENCY_LIMIT = 150

export function registerAudioIpcHandlers(deps: AudioIpcDependencies): void {
  const wavState: WavState = {
    active: false,
    filePath: null,
    recordingId: null,
    fd: null,
    bytesPCM: 0,
    sampleRate: 16000,
    numChannels: 1,
    bitsPerSample: 16
  }

  const webmState: WebmState = {
    active: false,
    filePath: null,
    recordingId: null,
    writeStream: null,
    bytesWritten: 0
  }

  let deepgramWs: WebSocket | null = null
  let deepgramTranscript = ''
  let deepgramFinalTranscript = ''
  let lastFinalizedText = ''
  let deepgramConnected = false
  let deepgramKeepAliveTimer: NodeJS.Timeout | null = null
  let deepgramLastAudioAt = 0
  let chunksSent = 0
  let totalBytesSent = 0

  const ensureDir = async (dir: string) => {
    await fsp.mkdir(dir, { recursive: true })
  }

  const safeUnlink = async (file: string) => {
    try { await fsp.unlink(file) } catch { }
  }

  const wavHeaderBuffer = (dataSize: number, sampleRate: number, numChannels: number, bitsPerSample: number): Buffer => {
    const blockAlign = numChannels * (bitsPerSample / 8)
    const byteRate = sampleRate * blockAlign
    const buffer = Buffer.alloc(44)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    return buffer
  }

  const parseWavMeta = (buf: Buffer): { sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataSize: number; durationSec: number } => {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Not a WAV file')
    }

    let pos = 12
    let fmtOffset = -1
    let dataOffset = -1
    let dataSize = 0
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4)
      const size = buf.readUInt32LE(pos + 4)
      if (id === 'fmt ') fmtOffset = pos + 8
      else if (id === 'data') {
        dataOffset = pos + 8
        dataSize = size
        break
      }
      pos += 8 + size
    }
    if (fmtOffset < 0 || dataOffset < 0) throw new Error('Invalid WAV (missing fmt or data)')

    const audioFormat = buf.readUInt16LE(fmtOffset)
    const channels = buf.readUInt16LE(fmtOffset + 2)
    const sampleRate = buf.readUInt32LE(fmtOffset + 4)
    const bitsPerSample = buf.readUInt16LE(fmtOffset + 14)
    if (audioFormat !== 1) throw new Error('Only PCM WAV supported')

    const bytesPerSec = sampleRate * channels * (bitsPerSample / 8)
    const durationSec = dataSize / bytesPerSec
    return { sampleRate, channels, bitsPerSample, dataOffset, dataSize, durationSec }
  }

  const sliceWav = (buf: Buffer, startSec: number, endSec: number, meta: { sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataSize: number }): Buffer => {
    const { sampleRate, channels, bitsPerSample, dataOffset, dataSize } = meta
    const bytesPerSec = sampleRate * channels * (bitsPerSample / 8)
    const startByteRel = Math.max(0, Math.floor(startSec * bytesPerSec))
    const endByteRel = Math.min(dataSize, Math.floor(endSec * bytesPerSec))
    const sliceSize = Math.max(0, endByteRel - startByteRel)
    const pcmSlice = buf.subarray(dataOffset + startByteRel, dataOffset + startByteRel + sliceSize)
    return Buffer.concat([wavHeaderBuffer(sliceSize, sampleRate, channels, bitsPerSample), pcmSlice])
  }

  const stitchTexts = (parts: string[]): string => {
    const cleaned = parts.map((part) => (part || '').toString().trim()).filter(Boolean)
    if (!cleaned.length) return ''

    const hasTimestamps = /\[\d{1,2}:\d{2}-\d{1,2}:\d{2}\]\s*Speaker\s+[A-Z]:/i.test(cleaned[0])
    if (hasTimestamps) return cleaned.join('\n')

    const simplified = cleaned.map((part) => part.replace(/\s+/g, ' ').trim())
    let output = simplified[0]
    for (let index = 1; index < simplified.length; index += 1) {
      output = `${output.trimEnd()} ${simplified[index]}`
    }
    return output.trim()
  }

  /** AI mode: the spoken request is answered by the chat model, with the screenshot as context. */
  const answerAiModeRequest = async (transcript: string, screenshotBase64?: string): Promise<string> => {
    try {
      const result = await chatCompletion({
        messages: [
          { role: 'system', content: buildAiModeSystemPrompt(!!screenshotBase64) },
          {
            role: 'user',
            content: [
              ...(screenshotBase64 ? [{ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${screenshotBase64}` } }] : []),
              { type: 'text' as const, text: transcript },
            ],
          },
        ],
      })
      return result.text.trim() || transcript
    } catch (error: any) {
      deps.sendProgress(`[AI Mode] Rewrite failed, pasting the transcript instead: ${error?.message ?? error}`)
      return transcript
    }
  }

  /** Transcribe with the configured provider, splitting WAVs larger than it accepts. */
  const transcribeWav = async (
    wavBuffer: Buffer,
    opts: { isAIMode?: boolean; screenshotBase64?: string } = {}
  ): Promise<string> => {
    const language = deps.getPrefs().dictationLanguage
    const maxBytes = getTranscriptionChunkBytes()
    let transcript: string
    if (wavBuffer.length <= maxBytes) {
      transcript = await transcribeAudio(wavBuffer, { language })
    } else {
      const meta = parseWavMeta(wavBuffer)
      const bytesPerSec = meta.sampleRate * meta.channels * (meta.bitsPerSample / 8)
      const chunkSeconds = Math.max(MIN_WAV_CHUNK_SECONDS, Math.floor(maxBytes / bytesPerSec))
      const totalChunks = Math.ceil(meta.durationSec / chunkSeconds)
      const parts: string[] = []
      for (let index = 0; index < totalChunks; index += 1) {
        const startSec = index * chunkSeconds
        const endSec = Math.min(meta.durationSec, startSec + chunkSeconds)
        deps.sendProgress(`Transcribing chunk ${index + 1}/${totalChunks} (${Math.round(endSec - startSec)}s)...`)
        const text = await transcribeAudio(sliceWav(wavBuffer, startSec, endSec, meta), { language })
        if (text) parts.push(text)
      }
      transcript = stitchTexts(parts)
    }
    if (!opts.isAIMode || !transcript) return transcript
    return answerAiModeRequest(transcript, opts.screenshotBase64)
  }

  const normalizeDeepgramStartFailure = (details: { message?: string; reason?: string; code?: number } = {}) => {
    const message = typeof details.message === 'string' ? details.message.trim() : ''
    const reason = typeof details.reason === 'string' ? details.reason.trim() : ''
    const combined = `${message} ${reason}`.toLowerCase()
    const providerLimitSignals = ['429', 'concurr', 'too many', 'rate limit', 'rate-limit', 'quota', 'capacity', 'limit reached']

    if (providerLimitSignals.some((signal) => combined.includes(signal))) {
      return `Deepgram streaming limit reached (${DEEPGRAM_STREAMING_CONCURRENCY_LIMIT} concurrent streams)`
    }
    if (reason) return reason
    if (message) return message
    if (typeof details.code === 'number' && details.code > 0) return `WebSocket closed (${details.code})`
    return 'Connection timeout'
  }

  const stopDeepgramKeepAlive = () => {
    if (deepgramKeepAliveTimer) clearInterval(deepgramKeepAliveTimer)
    deepgramKeepAliveTimer = null
  }

  const startDeepgramKeepAlive = () => {
    stopDeepgramKeepAlive()
    deepgramKeepAliveTimer = setInterval(() => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) return
      const idleMs = Date.now() - deepgramLastAudioAt
      if (idleMs < 3000) return
      try {
        deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }))
      } catch { }
    }, 4000)
  }

  const waitForWsClose = (ws: WebSocket, timeoutMs: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  ipcMain.handle(IPC.invoke.audio.wavrecStart, async () => {
    try {
      if (wavState.active) {
        return { ok: true, recordingId: wavState.recordingId, message: 'Recording already in progress (continued)' }
      }
      const dir = path.join(app.getPath('temp'), 'notto')
      await ensureDir(dir)
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = path.join(dir, `recording-${ts}.wav`)
      const fd = fs.openSync(filePath, 'w')
      fs.writeSync(fd, wavHeaderBuffer(0, wavState.sampleRate, wavState.numChannels, wavState.bitsPerSample), 0, 44, 0)
      wavState.active = true
      wavState.filePath = filePath
      wavState.recordingId = null
      wavState.fd = fd
      wavState.bytesPCM = 0
      return { ok: true }
    } catch (err: any) {
      wavState.active = false
      try { if (wavState.fd !== null) fs.closeSync(wavState.fd) } catch { }
      wavState.fd = null
      wavState.filePath = null
      wavState.recordingId = null
      wavState.bytesPCM = 0
      return { ok: false, message: err?.message ?? String(err) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.wavrecChunk, async (_evt, pcm16: ArrayBuffer) => {
    try {
      if (!wavState.active || wavState.fd === null) return { ok: false, message: 'No active wav recording' }
      if (deps.isRecordingPaused()) return { ok: true, bytes: wavState.bytesPCM, paused: true }
      const buf = Buffer.from(pcm16)
      fs.writeSync(wavState.fd, buf)
      wavState.bytesPCM += buf.length
      return { ok: true, bytes: wavState.bytesPCM }
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.wavrecStop, async () => {
    try {
      if (!wavState.active || wavState.fd === null || !wavState.filePath) return { ok: false, message: 'No active wav recording' }
      fs.writeSync(wavState.fd, wavHeaderBuffer(wavState.bytesPCM, wavState.sampleRate, wavState.numChannels, wavState.bitsPerSample), 0, 44, 0)
      fs.closeSync(wavState.fd)
      const outputPath = wavState.filePath
      const resource = deps.tempRecordingStore.register(outputPath)
      const bytes = wavState.bytesPCM + 44

      wavState.active = false
      wavState.fd = null
      wavState.filePath = null
      wavState.recordingId = null
      wavState.bytesPCM = 0

      return { ok: true, recordingId: resource.id, bytes }
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.webmrecStart, async () => {
    try {
      if (webmState.active) {
        return { ok: true, recordingId: webmState.recordingId, message: 'Recording already in progress' }
      }
      const dir = path.join(app.getPath('temp'), 'notto')
      await ensureDir(dir)
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = path.join(dir, `recording-${ts}.webm`)
      webmState.writeStream = fs.createWriteStream(filePath)
      // Without a listener, a write error (disk full, file locked by antivirus) is an uncaught
      // exception in the main process.
      webmState.writeStream.on('error', (err) => {
        deps.sendProgress(`WebM recording write error: ${err?.message ?? 'Unknown'}`)
      })
      webmState.active = true
      webmState.filePath = filePath
      webmState.recordingId = null
      webmState.bytesWritten = 0
      return { ok: true }
    } catch (err: any) {
      webmState.active = false
      try { webmState.writeStream?.destroy() } catch { }
      webmState.writeStream = null
      webmState.filePath = null
      webmState.recordingId = null
      webmState.bytesWritten = 0
      return { ok: false, message: err?.message ?? String(err) }
    }
  })

  ipcMain.on(IPC.send.rendererToMain.webmrecChunk, (_evt, chunk: ArrayBuffer) => {
    try {
      if (!webmState.active || !webmState.writeStream) return
      if (deps.isRecordingPaused()) return
      const buf = Buffer.from(chunk)
      webmState.writeStream.write(buf)
      webmState.bytesWritten += buf.length
    } catch (err: any) {
      deps.sendProgress(`WebM chunk error: ${err?.message ?? 'Unknown'}`)
    }
  })

  ipcMain.handle(IPC.invoke.audio.webmrecStop, async () => {
    try {
      if (!webmState.active || !webmState.writeStream || !webmState.filePath) {
        return { ok: false, message: 'No active webm recording' }
      }

      const writeStream = webmState.writeStream
      const outputPath = webmState.filePath
      const resource = deps.tempRecordingStore.register(outputPath)
      const bytes = webmState.bytesWritten

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve)
        writeStream.on('error', reject)
        writeStream.end()
      })

      webmState.active = false
      webmState.writeStream = null
      webmState.filePath = null
      webmState.recordingId = null
      webmState.bytesWritten = 0
      return { ok: true, recordingId: resource.id, bytes }
    } catch (err: any) {
      webmState.active = false
      try { webmState.writeStream?.destroy() } catch { }
      webmState.writeStream = null
      webmState.filePath = null
      webmState.recordingId = null
      webmState.bytesWritten = 0
      return { ok: false, message: err?.message ?? String(err) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.summarizeMeeting, async (evt, params: { transcript: string; notes?: string }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ text: '' })
    }
    try {
      const transcript = params.transcript?.slice(0, 20000) ?? ''
      const notes = params.notes?.slice(0, 8000) ?? ''
      const systemPrompt = `You are Notto, an expert AI meeting notetaker that creates professional, structured notes from meeting transcripts. Your goal is to extract actionable information while remaining factual and concise.

 ‼️ CRITICAL LANGUAGE REQUIREMENT ‼️
- NEVER TRANSLATE. Output the notes in the EXACT SAME LANGUAGE as the transcript.
- If the transcript is in Romanian, write the notes in Romanian.
- If the transcript is in English, write the notes in English.
- If the transcript is mixed (e.g., Romanian with English technical terms), preserve that mix naturally.
- DO NOT default to English if the transcript is in another language.

Core Principles
- Use ONLY information from the provided transcript and user's personal notes
- Do not invent, assume, or extrapolate facts not present in the source material
- Preserve the original language of the transcript (do not translate)
- Where user's personal notes conflict with transcript, prefer the user's notes
- If information is unclear or incomplete, write "[Unclear]" rather than guessing

Processing Steps
1. First, identify all speakers and their contributions
2. Extract substantive updates, decisions, and commitments (not meeting mechanics)
3. Identify implicit action items (e.g., "I'll send...", "We need to...", "I completed...")
4. Distinguish between informational updates and actionable decisions
5. Format according to the structure below

Output Format:

## 🧾 Summary
[Write 2-3 sentences capturing the meeting's purpose, main topics discussed, and key outcomes. Focus on substantive content, not logistics like timing or minute-takers.]

## 💬 Key Discussion Points
• [Substantive point 1 with relevant details]
• [Substantive point 2 with relevant details]
• [Continue for all significant topics discussed]

(Focus on business content, decisions, updates, and insights—not procedural elements)

## ✅ Decisions Made
• [Decision 1 with brief context if relevant]
• [Decision 2]

(If no clear decisions were made, write "None")

## 📌 Action Items
• **[Action description]** ([Person Name/Role] if mentioned, otherwise write "Unassigned")
• **[Action description]** ([Owner])

Action items include:
- Explicit commitments ("I will...", "X needs to...")
- Completed tasks mentioned for tracking ("I completed...")
- Implicit next steps strongly implied by discussion
- Requests for feedback or follow-up

(If no action items exist, write "None")

## ❓ Open Questions
• [Unanswered question or issue raised]
• [Topic requiring further discussion]

(If no open questions, write "None")

---

CRITICAL: At the very end of your response, on its own line, output a concise meeting title (3-6 words) prefixed with "TITLE:"
Example: "TITLE: Team Weekly Updates Meeting"

 What NOT to Include
- Meeting start/end times unless they're relevant to decisions
- Who is taking minutes (unless it's an action item assignment)
- Apologies/absences unless they impact decisions
- General greetings and pleasantries
- Overly granular details that don't add value

 Handling Edge Cases
- If someone mentions completing work: include as action item with "[Completed]" prefix
- If feedback is requested: create action item "Provide feedback on [topic] ([Relevant people])"
- If capacity/resource issues mentioned: flag as both discussion point AND potential action item
- If strategic updates are deferred: note under Open Questions if timing is unclear`
      const userPrompt = `Personal notes (guidance only; do not include in output):\n\n"""\n${notes}\n"""\n\nTranscript (may include speaker labels):\n\n"""\n${transcript}\n"""`

      deps.sendProgress('Notto: writing meeting notes...')
      const result = await chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
      deps.sendProgress('Notto: processing completed.')
      return { ok: true, text: result.text }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.transcribeRecording, async (evt, params: { recordingId: string; deleteInput?: boolean; isAIMode?: boolean; isMeetingMode?: boolean }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ text: '' })
    }
    const deleteInput = !!params?.deleteInput
    try {
      const recordingId = params?.recordingId
      const audioPath = recordingId ? deps.tempRecordingStore.resolvePath(recordingId) : null
      if (!audioPath || !fs.existsSync(audioPath)) return { ok: false, message: 'Recording not found' }

      deps.sendProgress(`Reading audio file: ${path.basename(audioPath)}`)
      const outputBuffer = await fsp.readFile(audioPath)

      deps.sendProgress(`Transcribing audio (${Math.round(outputBuffer.length / 1024)}KB)...`)
      const text = await transcribeWav(outputBuffer, { isAIMode: !!params.isAIMode })

      if (deleteInput) {
        deps.tempRecordingStore.release(recordingId)
        await safeUnlink(audioPath)
      }

      if (!text) return { ok: false, message: 'No speech detected in audio' }
      deps.sendProgress('Transcription complete.')
      return { ok: true, text }
    } catch (e: any) {
      if (deleteInput && params?.recordingId) {
        const audioPath = deps.tempRecordingStore.resolvePath(params.recordingId)
        deps.tempRecordingStore.release(params.recordingId)
        if (audioPath) {
          try { await safeUnlink(audioPath) } catch { }
        }
      }
      console.error('Transcription error:', e)
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.transcribeBuffer, async (evt, params: { wavBuffer: ArrayBuffer; isAIMode?: boolean; isMeetingMode?: boolean }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ text: '' })
    }
    try {
      if (!params?.wavBuffer) {
        return { ok: false, message: 'Missing wavBuffer' }
      }

      const outputBuffer = Buffer.from(params.wavBuffer)
      let screenshotBase64: string | undefined
      const screenshotId = deps.getAiModeScreenshotId()
      deps.sendProgress(`[Main] isAIMode=${params.isAIMode}, aiModeScreenshotId=${screenshotId}`)
      if (params.isAIMode && screenshotId) {
        try {
          const base64 = await screenshotHelper.getScreenshotBase64(screenshotId)
          if (base64) {
            screenshotBase64 = base64
            deps.sendProgress(`[Main] Including screenshot (${Math.round(base64.length / 1024)}KB) with AI mode request`)
          } else {
            deps.sendProgress(`[Main] getScreenshotBase64 returned null for id: ${screenshotId}`)
          }
          await screenshotHelper.deleteScreenshot(screenshotId)
          deps.clearAiModeScreenshotId()
        } catch (ssErr: any) {
          deps.sendProgress(`[Main] Failed to get screenshot: ${ssErr?.message ?? 'Unknown error'}`)
        }
      } else if (params.isAIMode && !screenshotId) {
        deps.sendProgress('[Main] AI mode but no screenshot ID - screenshot capture may have failed')
      }

      const text = await transcribeWav(outputBuffer, { isAIMode: !!params.isAIMode, screenshotBase64 })

      if (!text) return { ok: false, message: 'No speech detected in audio' }
      return { ok: true, text }
    } catch (e: any) {
      deps.sendProgress(`[Main] transcribeBuf ERROR: ${e?.message ?? String(e)}`)
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.deepgramTranscribeDictation, async (evt, params: { wavBuffer: ArrayBuffer }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ text: '' })
    }
    try {
      if (!params?.wavBuffer) return { ok: false, message: 'Missing wavBuffer' }

      const outputBuffer = Buffer.from(params.wavBuffer)
      const text = await transcribeWav(outputBuffer)
      return { ok: true, text }
    } catch (e: any) {
      deps.sendProgress(`[Dictation] Transcription error: ${e?.message ?? String(e)}`)
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.audio.deepgramGetToken, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ token: '', expiresIn: 0 })
    }
    try {
      if (!getLiveDictationKey()) {
        return { ok: false, message: 'Live dictation needs Deepgram as the transcription provider' }
      }
      // The renderer only learns that streaming is available; the key stays in the main process.
      return { ok: true, token: 'local', expiresIn: 3600 }
    } catch (e: any) {
      deps.sendProgress(`[Deepgram] Token error: ${e?.message}`)
      return { ok: false, message: e?.message ?? 'Unknown error' }
    }
  })

  ipcMain.handle(IPC.invoke.audio.deepgramStartStream, async (evt, params: { token: string }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deps.sendProgress('[Deepgram] Stream already active')
        return { ok: true, alreadyActive: true }
      }

      deepgramTranscript = ''
      deepgramFinalTranscript = ''
      lastFinalizedText = ''
      deepgramConnected = false

      const wsUrl = new URL('wss://api.deepgram.com/v1/listen')
      wsUrl.searchParams.set('model', getLiveDictationModel())
      wsUrl.searchParams.set('language', deps.getPrefs().dictationLanguage || 'multi')
      wsUrl.searchParams.set('smart_format', 'true')
      wsUrl.searchParams.set('filler_words', 'false')
      wsUrl.searchParams.set('interim_results', 'true')
      wsUrl.searchParams.set('endpointing', 'false')
      wsUrl.searchParams.set('encoding', 'linear16')
      wsUrl.searchParams.set('sample_rate', '16000')
      wsUrl.searchParams.set('channels', '1')

      deps.sendProgress('[Deepgram] Connecting to WebSocket...')
      const deepgramKey = getLiveDictationKey()
      if (!deepgramKey) return { ok: false, message: 'Deepgram API key is not configured' }
      deepgramWs = new WebSocket(wsUrl.toString(), {
        headers: {
          Authorization: `Token ${deepgramKey}`
        }
      })

      return await new Promise<{ ok: boolean; message?: string }>((resolve) => {
        let settled = false
        const settle = (result: { ok: boolean; message?: string }) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(result)
        }

        const timeout = setTimeout(() => {
          if (!deepgramConnected) {
            settle({ ok: false, message: normalizeDeepgramStartFailure() })
          }
        }, 5000)

        deepgramWs!.on('open', () => {
          deepgramConnected = true
          deepgramLastAudioAt = Date.now()
          chunksSent = 0
          totalBytesSent = 0
          deps.sendProgress('[Deepgram] WebSocket connected!')
          startDeepgramKeepAlive()
          settle({ ok: true })
        })

        deepgramWs!.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString())
            if (msg.type !== 'Results') return

            const transcript = msg.channel?.alternatives?.[0]?.transcript || ''
            const isFinal = msg.is_final

            if (transcript) {
              if (isFinal) {
                const trimmedTranscript = transcript.trim()
                if (trimmedTranscript && trimmedTranscript !== lastFinalizedText) {
                  if (deepgramFinalTranscript.length > 0 && deepgramFinalTranscript.endsWith(trimmedTranscript)) {
                    lastFinalizedText = trimmedTranscript
                  } else {
                    let textToAdd = trimmedTranscript
                    if (deepgramFinalTranscript.length > 0) {
                      const existingWords = deepgramFinalTranscript.split(/\s+/)
                      const newWords = trimmedTranscript.split(/\s+/)
                      let overlapCount = 0
                      for (let count = Math.min(5, existingWords.length); count >= 1; count -= 1) {
                        const existingEnd = existingWords.slice(-count).join(' ').toLowerCase()
                        const newStart = newWords.slice(0, count).join(' ').toLowerCase()
                        if (existingEnd === newStart) {
                          overlapCount = count
                          break
                        }
                      }
                      if (overlapCount > 0) {
                        textToAdd = newWords.slice(overlapCount).join(' ')
                      }
                    }

                    if (textToAdd.trim()) {
                      deepgramFinalTranscript += (deepgramFinalTranscript ? ' ' : '') + textToAdd.trim()
                    }
                    lastFinalizedText = trimmedTranscript
                    deps.sendProgress(`[Deepgram] Final: "${transcript.substring(0, 30)}..."`)
                  }
                }
              } else {
                deepgramTranscript = transcript
              }
            }

            try {
              deps.getMainWindow()?.webContents.send(IPC.event.mainToRenderer.deepgramTranscript, {
                interim: deepgramTranscript,
                final: deepgramFinalTranscript,
                isFinal
              })
            } catch { }
          } catch (e) {
            console.error('[Deepgram] Message parse error:', e)
          }
        })

        deepgramWs!.on('error', (err) => {
          deps.sendProgress(`[Deepgram] WebSocket error: ${err.message}`)
          if (!deepgramConnected) {
            settle({ ok: false, message: normalizeDeepgramStartFailure({ message: err.message }) })
          }
        })

        deepgramWs!.on('close', (code, reasonBuffer) => {
          const reason = reasonBuffer ? reasonBuffer.toString() : ''
          deps.sendProgress('[Deepgram] WebSocket closed')
          stopDeepgramKeepAlive()
          deepgramConnected = false
          if (!settled) {
            settle({ ok: false, message: normalizeDeepgramStartFailure({ code, reason }) })
          }
        })
      })
    } catch (e: any) {
      deps.sendProgress(`[Deepgram] startStream error: ${e?.message}`)
      return { ok: false, message: e?.message ?? 'Unknown error' }
    }
  })

  ipcMain.handle(IPC.invoke.audio.deepgramSendChunk, async (evt, params: { chunk: ArrayBuffer }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
        return { ok: false, message: 'WebSocket not connected' }
      }
      const buffer = Buffer.from(params.chunk)
      deepgramWs.send(buffer)
      deepgramLastAudioAt = Date.now()
      chunksSent += 1
      totalBytesSent += buffer.length
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message }
    }
  })

  ipcMain.handle(IPC.invoke.audio.deepgramStopStream, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ text: '' })
    }
    try {
      if (!deepgramWs) {
        return { ok: true, text: deepgramFinalTranscript || deepgramTranscript }
      }

      stopDeepgramKeepAlive()
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(JSON.stringify({ type: 'CloseStream' }))
        await waitForWsClose(deepgramWs, 500)
      }
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close()
      }

      deepgramWs = null
      deepgramConnected = false
      const finalText = (deepgramFinalTranscript || deepgramTranscript).trim()
      deps.sendProgress(`[Deepgram] Stream stopped, final text: "${finalText.substring(0, 50)}..."`)

      deepgramTranscript = ''
      deepgramFinalTranscript = ''
      lastFinalizedText = ''
      return { ok: true, text: finalText }
    } catch (e: any) {
      deps.sendProgress(`[Deepgram] stopStream error: ${e?.message}`)
      return { ok: false, message: e?.message, text: deepgramFinalTranscript || deepgramTranscript }
    }
  })
}
