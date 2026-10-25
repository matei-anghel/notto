const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const { IPC } = loadTsModule(path.join(__dirname, '..', 'src', 'shared', 'ipcChannels.ts'))

function loadAudioIpcModule(tempRoot) {
  const handlers = new Map()
  const listeners = new Map()
  const mockElectron = {
    app: {
      getPath: (name) => {
        if (name === 'temp') return tempRoot
        return tempRoot
      }
    },
    BrowserWindow: {},
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler)
    }
  }

  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return mockElectron
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const mod = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'audioIpc.ts'))
    return { registerAudioIpcHandlers: mod.registerAudioIpcHandlers, handlers, listeners }
  } finally {
    Module._load = originalLoad
  }
}

test('wav recorder skips paused chunks and resumes cleanly', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notto-audio-test-'))
  const { registerAudioIpcHandlers, handlers } = loadAudioIpcModule(tempRoot)
  let paused = false

  registerAudioIpcHandlers({
    getPrefs: () => ({}),
    sendProgress: () => {},
    isTrustedRendererEvent: () => true,
    blockedInvokeResult: (fallback = {}) => ({ ...fallback, ok: false, message: 'blocked' }),
    tempRecordingStore: {
      register: (filePath) => ({ id: 'recording-1', filePath }),
      resolvePath: () => null,
      release: () => {}
    },
    isRecordingPaused: () => paused,
    getAiModeScreenshotId: () => null,
    clearAiModeScreenshotId: () => {},
    getMainWindow: () => null
  })

  const start = await handlers.get(IPC.invoke.audio.wavrecStart)()
  assert.equal(start.ok, true)

  paused = true
  const pausedChunk = await handlers.get(IPC.invoke.audio.wavrecChunk)({}, new Int16Array([1000, -1000]).buffer)
  assert.equal(pausedChunk.ok, true)
  assert.equal(pausedChunk.paused, true)
  assert.equal(pausedChunk.bytes, 0)

  paused = false
  const resumedChunk = await handlers.get(IPC.invoke.audio.wavrecChunk)({}, new Int16Array([1000, -1000]).buffer)
  assert.equal(resumedChunk.ok, true)
  assert.equal(resumedChunk.bytes, 4)

  const stop = await handlers.get(IPC.invoke.audio.wavrecStop)()
  assert.equal(stop.ok, true)
  assert.equal(stop.bytes, 48)
  assert.equal(stop.recordingId, 'recording-1')
})
