const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

for (const location of ['src/shared/chatCompletionResponse.ts']) {
  const { readChatCompletionResponse } = loadTsModule(path.join(__dirname, '..', location))
  test(`${location}: handles UTF-8 boundaries and an unterminated final frame`, async () => {
    const bytes = new TextEncoder().encode('data:{"choices":[{"delta":{"content":"caf\u00e9"},"finish_reason":"stop"}]}')
    const chunks = []
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } })
    const result = await readChatCompletionResponse(new Response(body), true, chunk => chunks.push(chunk))
    assert.equal(result.text, 'caf\u00e9')
    assert.deepEqual(chunks, ['caf\u00e9'])
  })
  test(`${location}: surfaces provider errors after partial output`, async () => {
    const body = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"provider failed"}}\n\n'
    await assert.rejects(readChatCompletionResponse(new Response(body), true), /provider failed/)
  })
  test(`${location}: rejects streams that disconnect before completion`, async () => {
    await assert.rejects(readChatCompletionResponse(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n'), true), /ended before completion/)
  })
  test(`${location}: rejects empty responses and JSON errors`, async () => {
    await assert.rejects(readChatCompletionResponse(new Response('data: [DONE]\n'), true), /Empty response/)
    await assert.rejects(readChatCompletionResponse(Response.json({ error: { message: 'invalid model' } }), false), /invalid model/)
  })
  test(`${location}: stops on DONE and releases the stream`, async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"done"}}]}\ndata: [DONE]\ndata: invalid\n')
    assert.equal((await readChatCompletionResponse(response, true)).text, 'done')
    assert.equal(response.body.locked, false)
  })
}
