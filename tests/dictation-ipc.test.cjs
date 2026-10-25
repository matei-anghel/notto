const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const { IPC } = loadTsModule(path.join(__dirname, '..', 'src', 'shared', 'ipcChannels.ts'))

function loadDictationIpcModule() {
  const handlers = new Map()
  const listeners = new Map()
  const mockElectron = {
    BrowserWindow: {
      getFocusedWindow: () => null
    },
    clipboard: {
      readText: () => '',
      writeText: () => {}
    },
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
    const mod = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'dictationIpc.ts'))
    return { registerDictationIpcHandlers: mod.registerDictationIpcHandlers, handlers, listeners }
  } finally {
    Module._load = originalLoad
  }
}

const dictationIpcModule = loadDictationIpcModule()

test('dictation mic error clears suppression and handsfree state', async () => {
  const { registerDictationIpcHandlers, handlers } = dictationIpcModule
  handlers.clear()
  const calls = []

  registerDictationIpcHandlers({
    getPrefs: () => ({}),
    savePrefs: () => {},
    sendProgress: () => {},
    isTrustedRendererEvent: () => true,
    blockedInvokeResult: (fallback = {}) => ({ ...fallback, ok: false, message: 'blocked' }),
    getMainWindow: () => ({
      webContents: { send: (...args) => calls.push(['main', ...args]) }
    }),
    getChatWindow: () => ({
      webContents: { send: (...args) => calls.push(['chat', ...args]) }
    }),
    closePromptWindow: () => {},
    ensureNotesFloatWindowVisible: () => {},
    getHudWindow: () => null,
    hideHudWindow: () => {},
    getHudCloseTimeout: () => null,
    setHudCloseTimeout: () => {},
    getDictationOrigin: () => 'global',
    setDictationOrigin: (value) => calls.push(['origin', value]),
    getDictationActive: () => false,
    setDictationActive: (value) => calls.push(['dictationActive', value]),
    setAiModeActive: (value) => calls.push(['aimodeActive', value]),
    setHandsFreeActive: (value) => calls.push(['handsFreeActive', value]),
    setKeepHudUntilPaste: (value) => calls.push(['keepHudUntilPaste', value]),
    setChatInitiatedDictation: (value) => calls.push(['chatInitiatedDictation', value]),
    setMicSuppressUntilInactive: (value) => calls.push(['micSuppressUntilInactive', value]),
    setCurrentMicSessionDismissed: (value) => calls.push(['currentMicSessionDismissed', value]),
    toggleDictation: () => {}
  })

  const result = await handlers.get(IPC.invoke.ui.dictationMicError)({})
  assert.equal(result.ok, true)
  assert.deepEqual(calls.slice(0, 6), [
    ['dictationActive', false],
    ['handsFreeActive', false],
    ['keepHudUntilPaste', false],
    ['chatInitiatedDictation', false],
    ['origin', 'global'],
    ['micSuppressUntilInactive', false]
  ])
  assert.ok(calls.some((entry) => entry[0] === 'currentMicSessionDismissed' && entry[1] === false))
})

test('AI mode mic error also clears suppression state', async () => {
  const { registerDictationIpcHandlers, handlers } = dictationIpcModule
  handlers.clear()
  const calls = []

  registerDictationIpcHandlers({
    getPrefs: () => ({}),
    savePrefs: () => {},
    sendProgress: () => {},
    isTrustedRendererEvent: () => true,
    blockedInvokeResult: (fallback = {}) => ({ ...fallback, ok: false, message: 'blocked' }),
    getMainWindow: () => ({
      webContents: { send: (...args) => calls.push(['main', ...args]) }
    }),
    getChatWindow: () => ({
      webContents: { send: (...args) => calls.push(['chat', ...args]) }
    }),
    closePromptWindow: () => {},
    ensureNotesFloatWindowVisible: () => {},
    getHudWindow: () => null,
    hideHudWindow: () => {},
    getHudCloseTimeout: () => null,
    setHudCloseTimeout: () => {},
    getDictationOrigin: () => 'chat',
    setDictationOrigin: (value) => calls.push(['origin', value]),
    getDictationActive: () => false,
    setDictationActive: (value) => calls.push(['dictationActive', value]),
    setAiModeActive: (value) => calls.push(['aimodeActive', value]),
    setHandsFreeActive: (value) => calls.push(['handsFreeActive', value]),
    setKeepHudUntilPaste: (value) => calls.push(['keepHudUntilPaste', value]),
    setChatInitiatedDictation: (value) => calls.push(['chatInitiatedDictation', value]),
    setMicSuppressUntilInactive: (value) => calls.push(['micSuppressUntilInactive', value]),
    setCurrentMicSessionDismissed: (value) => calls.push(['currentMicSessionDismissed', value]),
    toggleDictation: () => {}
  })

  const result = await handlers.get(IPC.invoke.ui.aimodeMicError)({})
  assert.equal(result.ok, true)
  assert.ok(calls.some((entry) => entry[0] === 'aimodeActive' && entry[1] === false))
  assert.ok(calls.some((entry) => entry[0] === 'handsFreeActive' && entry[1] === false))
  assert.ok(calls.some((entry) => entry[0] === 'keepHudUntilPaste' && entry[1] === false))
  assert.ok(calls.some((entry) => entry[0] === 'chatInitiatedDictation' && entry[1] === false))
  assert.ok(calls.some((entry) => entry[0] === 'origin' && entry[1] === 'global'))
  assert.ok(calls.some((entry) => entry[0] === 'micSuppressUntilInactive' && entry[1] === false))
  assert.ok(calls.some((entry) => entry[0] === 'currentMicSessionDismissed' && entry[1] === false))
})
