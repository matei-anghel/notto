const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')
const { loadTsWithMocks } = require('./helpers/load-ts-with-mocks.cjs')

const providers = loadTsModule(path.join(__dirname, '../src/shared/aiProviders.ts'))
const { readChatCompletionResponse } = loadTsModule(path.join(__dirname, '../src/shared/chatCompletionResponse.ts'))

function loadClient(keys = {}) {
  const client = loadTsWithMocks(path.join(__dirname, '../src/main/ai/aiClient.ts'), {
    '../../shared/aiProviders': providers,
    '../../shared/chatCompletionResponse': { readChatCompletionResponse },
    './keyStore': { getApiKey: (id) => keys[id] || null },
  })
  let settings = providers.defaultAiSettings()
  client.configureAiClient(() => settings)
  return { client, set: (next) => { settings = providers.normalizeAiSettings({ ...settings, ...next }) } }
}

function captureFetch(t, respond) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return respond(String(url), init)
  })
  return calls
}

const sse = (lines) => new Response(new ReadableStream({
  start(controller) {
    for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
    controller.close()
  }
}))

test('nothing configured: requests fail with a setup message and no network call', async (t) => {
  const calls = captureFetch(t, () => { throw new Error('must not fetch') })
  const { client, set } = loadClient()
  await assert.rejects(client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }), /Choose a chat model/)
  set({ chat: { provider: 'openai', model: 'gpt-5.5' } })
  await assert.rejects(client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }), /Add your OpenAI API key/)
  assert.equal(calls.length, 0)
})

test('OpenAI-compatible chat posts the model and messages with the stored key', async (t) => {
  const calls = captureFetch(t, () => Response.json({ choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }] }))
  const { client, set } = loadClient({ groq: 'gsk-test' })
  set({ chat: { provider: 'groq', model: 'openai/gpt-oss-120b' } })
  const result = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.text, 'Hello!')
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk-test')
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], stream: false })
})

test('local providers need no key and honor a custom server URL', async (t) => {
  const calls = captureFetch(t, () => Response.json({ choices: [{ message: { content: 'local' } }] }))
  const { client, set } = loadClient()
  set({ chat: { provider: 'ollama', model: 'llama3.2' }, baseUrls: { ollama: 'http://192.168.1.5:11434/v1/' } })
  assert.equal((await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).text, 'local')
  assert.equal(calls[0].url, 'http://192.168.1.5:11434/v1/chat/completions')
  assert.equal(calls[0].init.headers.Authorization, undefined)
})

test('an unreachable local server explains where Notto looked', async (t) => {
  captureFetch(t, () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
  const { client, set } = loadClient()
  set({ chat: { provider: 'lmstudio', model: 'qwen' } })
  await assert.rejects(client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }), /ECONNREFUSED.*localhost:1234/)
})

test('image requests use the vision model, falling back to the chat model', async (t) => {
  const calls = captureFetch(t, () => Response.json({ choices: [{ message: { content: 'seen' } }] }))
  const { client, set } = loadClient({ openai: 'sk-a', google: 'g-key' })
  set({ chat: { provider: 'openai', model: 'gpt-5.5' } })
  const image = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'what is this' }]
  await client.chatCompletion({ messages: [{ role: 'user', content: image }] })
  assert.match(calls[0].url, /api\.openai\.com/)
  set({ vision: { provider: 'google', model: 'gemini-3.5-flash' } })
  await client.chatCompletion({ messages: [{ role: 'user', content: image }] })
  assert.match(calls[1].url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions/)
  assert.equal(JSON.parse(calls[1].init.body).model, 'gemini-3.5-flash')
})

test('Anthropic gets a separate system prompt, merged turns and base64 image blocks', () => {
  const { client } = loadClient()
  const converted = client.toAnthropicMessages([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'first' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }, { type: 'text', text: 'second' }] },
    { role: 'assistant', content: 'ok' },
  ])
  assert.equal(converted.system, 'Be brief.')
  assert.equal(converted.messages.length, 2)
  assert.deepEqual(converted.messages[0].content, [
    { type: 'text', text: 'first' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'second' },
  ])
})

test('Anthropic streaming yields text deltas and requires message_stop', async (t) => {
  const calls = captureFetch(t, () => sse([
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]))
  const { client, set } = loadClient({ anthropic: 'sk-ant-test' })
  set({ chat: { provider: 'anthropic', model: 'claude-sonnet-5-5' } })
  const chunks = []
  const result = await client.chatCompletion({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], stream: true, onChunk: (c) => chunks.push(c) })
  assert.equal(result.text, 'Hello')
  assert.deepEqual(chunks, ['Hel', 'lo'])
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-test')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.system, 'sys')
  assert.equal(body.max_tokens > 0, true)

  captureFetch(t, () => sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"cut"}}\n\n']))
  await assert.rejects(client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: true }), /ended before completion/)
})

test('provider errors name the provider, status and a hint without leaking the key', async (t) => {
  captureFetch(t, () => Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }))
  const { client, set } = loadClient({ openai: 'sk-secret-value' })
  set({ chat: { provider: 'openai', model: 'gpt-5.5' } })
  await assert.rejects(client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
    assert.match(error.message, /OpenAI error 401: Incorrect API key provided/)
    assert.match(error.message, /Check the API key/)
    assert.doesNotMatch(error.message, /sk-secret-value/)
    return true
  })
})

test('transcription uses multipart for OpenAI-compatible APIs and raw audio for Deepgram', async (t) => {
  const calls = captureFetch(t, (url) => url.includes('deepgram')
    ? Response.json({ results: { channels: [{ alternatives: [{ transcript: ' deepgram text ' }] }] } })
    : Response.json({ text: ' whisper text ' }))
  const { client, set } = loadClient({ groq: 'gsk', deepgram: 'dg-key' })
  const wav = Buffer.from('RIFF....WAVE')

  set({ transcription: { provider: 'groq', model: 'whisper-large-v3-turbo' } })
  assert.equal(await client.transcribeAudio(wav, { language: 'ro' }), 'whisper text')
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions')
  const form = calls[0].init.body
  assert.equal(form.get('model'), 'whisper-large-v3-turbo')
  assert.equal(form.get('language'), 'ro')

  set({ transcription: { provider: 'deepgram', model: 'nova-3' } })
  assert.equal(await client.transcribeAudio(wav, { language: 'multi' }), 'deepgram text')
  const url = new URL(calls[1].url)
  assert.equal(url.pathname, '/v1/listen')
  assert.equal(url.searchParams.get('model'), 'nova-3')
  assert.equal(url.searchParams.get('language'), 'multi')
  assert.equal(calls[1].init.headers.Authorization, 'Token dg-key')
  assert.equal(client.getLiveDictationKey(), 'dg-key')
})

test('settings from the renderer are normalized to known providers and capabilities', () => {
  const settings = providers.normalizeAiSettings({
    chat: { provider: 'deepgram', model: 'nova-3' },
    transcription: { provider: 'anthropic', model: 'x' },
    vision: { provider: 'nope', model: 'y' },
    baseUrls: { ollama: ' http://localhost:11434/v1/ ', custom: 'javascript:alert(1)', unknown: 'http://x' },
  })
  assert.deepEqual(settings.chat, { provider: '', model: '' })
  assert.deepEqual(settings.transcription, { provider: '', model: '' })
  assert.deepEqual(settings.vision, { provider: '', model: '' })
  assert.deepEqual(settings.baseUrls, { ollama: 'http://localhost:11434/v1' })
})
