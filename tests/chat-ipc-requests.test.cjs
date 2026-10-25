const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')
const { loadTsWithMocks } = require('./helpers/load-ts-with-mocks.cjs')
const { IPC } = loadTsModule(path.join(__dirname, '../src/shared/ipcChannels.ts'))

class AiNotConfiguredError extends Error {}

function setup(chatCompletion) {
  const handlers = new Map()
  const events = []
  const requests = []
  let active = null
  const { registerChatIpcHandlers } = loadTsWithMocks(path.join(__dirname, '../src/main/chatIpc.ts'), {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, clipboard: {} },
    '../shared/ipcChannels': { IPC },
    './chatAttachmentManager': {},
    '../shared/chatAttachments': { serializeAttachmentContext: () => ({ text: '', imageDataUrls: [] }) },
    '../shared/noteSearch': loadTsModule(path.join(__dirname, '../src/shared/noteSearch.ts')),
    '../shared/chatOverlaySystemPrompt': { buildChatOverlaySystemPrompt: (notes) => `prompt${notes ? `:${notes}` : ''}` },
    './ai/aiClient': {
      AiNotConfiguredError,
      chatCompletion: (options) => { requests.push(options); return chatCompletion(options) },
    },
  })
  const deps = {
    notesRepository: { isValidId: () => true, read: async () => 'note body' },
    getPrefs: () => ({}), sendProgress: () => {},
    isTrustedRendererEvent: event => event?.trusted === true,
    blockedInvokeResult: (fallback = {}) => ({ ...fallback, ok: false, message: 'blocked' }),
    getActiveChatAbortController: () => active,
    setActiveChatAbortController: controller => { active = controller },
    getLastTranscriptText: () => 'private transcript'
  }
  registerChatIpcHandlers(deps)
  const event = { trusted: true, sender: { send: (...args) => events.push(args) } }
  return { handlers, event, events, requests, deps, getActive: () => active }
}
const params = { messages: [{ role: 'user', content: 'hello' }], stream: false }

test('an old request cannot clear a new request controller or publish a late result', async () => {
  const pending = []
  const state = setup((options) => new Promise((resolve, reject) => {
    pending.push(resolve)
    options.signal.addEventListener('abort', () => reject(options.signal.reason))
  }))
  const send = state.handlers.get(IPC.invoke.chat.send)
  const first = send(state.event, params)
  await new Promise(resolve => setImmediate(resolve))
  const second = send(state.event, params)
  await new Promise(resolve => setImmediate(resolve))
  const secondController = state.getActive()
  assert.equal((await first).ok, false)
  assert.equal(state.getActive(), secondController)
  pending[1]({ ok: true, text: 'current' })
  assert.equal((await second).text, 'current')
  assert.equal(state.getActive(), null)
  assert.deepEqual(state.events, [])
})

test('chat sends the system prompt, selected notes and the conversation to the configured model', async () => {
  const state = setup(async () => ({ ok: true, text: 'answer' }))
  const result = await state.handlers.get(IPC.invoke.chat.withNotes)(state.event, { ...params, notesContext: ['2026-01-01 1200 - Plan.txt'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.sources.noteIds, ['2026-01-01 1200 - Plan.txt'])
  const [request] = state.requests
  assert.equal(request.stream, false)
  assert.equal(request.messages[0].role, 'system')
  assert.match(request.messages[0].content, /note body/)
  assert.deepEqual(request.messages[1], { role: 'user', content: 'hello' })
  assert.equal(state.getActive(), null)
})

test('with no notes selected, Chat with Notes searches all notes and cites the matches', async () => {
  const state = setup(async () => ({ ok: true, text: 'answer' }))
  const files = {
    '2026-01-01 1200 - Weekly sync.txt': 'Morgan will publish the blog on Friday.',
    '2026-01-02 0900 - Client call.txt': 'Acme asked for single sign-on.',
  }
  state.deps.notesRepository.list = async () => Object.keys(files).map((id, index) => ({ id, mtime: index }))
  state.deps.notesRepository.read = async (id) => files[id]
  const result = await state.handlers.get(IPC.invoke.chat.send)(state.event, {
    messages: [{ role: 'user', content: 'When does Morgan publish the blog?' }], stream: false, searchAllNotes: true,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.sources.noteIds, ['2026-01-01 1200 - Weekly sync.txt'])
  assert.match(state.requests[0].messages[0].content, /publish the blog/)
  assert.doesNotMatch(state.requests[0].messages[0].content, /single sign-on/)
})

test('a missing provider or key is reported as a setup step', async () => {
  const state = setup(async () => { throw new AiNotConfiguredError('Choose a chat model in Settings → AI Providers.') })
  const result = await state.handlers.get(IPC.invoke.chat.send)(state.event, params)
  assert.equal(result.ok, false)
  assert.equal(result.needsSetup, true)
  assert.match(result.message, /Settings → AI Providers/)
})

test('untrusted renderers cannot read the last transcript or send chat', async () => {
  const state = setup(() => { throw new Error('must not call') })
  assert.deepEqual(await state.handlers.get(IPC.invoke.chat.getLastTranscript)({ trusted: false }),
    { ok: false, message: 'blocked', text: '' })
  assert.equal((await state.handlers.get(IPC.invoke.chat.send)({ trusted: false }, params)).ok, false)
  assert.equal(state.requests.length, 0)
})
