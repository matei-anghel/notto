const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { JSDOM } = require('jsdom')
const createDOMPurify = require('dompurify')
const { marked } = require('marked')

function streamingRenderer() {
  const source = fs.readFileSync(path.join(__dirname, '../src/chat.ts'), 'utf8')
  const parsed = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set(['protectMathExpressions', 'restoreMathExpressions', 'flushTokenBuffer'])
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map(node => node.getText(parsed)).join('\n')
  assert.equal(functions.includes('flushTokenBuffer'), true)
  const { window } = new JSDOM('<div id="chat"></div>')
  const context = vm.createContext({
    document: window.document, chatContainer: window.document.getElementById('chat'),
    DOMPurify: createDOMPurify(window), marked, markdownCache: new Map(), tokenBuffer: '',
    renderKaTeXMath: async () => {}, attachCodeBlockScrollListeners: () => {}, smoothResize: () => {}, console,
  })
  vm.runInContext(ts.transpile(functions, { target: ts.ScriptTarget.ES2020 }), context)
  return { context, window, render: text => {
    window.document.getElementById('streaming-response')?.remove()
    context.tokenBuffer = text
    vm.runInContext('flushTokenBuffer()', context)
    return window.document.getElementById('streaming-response')
  } }
}

test('streamed markdown and restored math cannot inject event handlers or script URLs', () => {
  const { render, window } = streamingRenderer()
  try {
    for (const payload of [
      '<img src=x onerror="window.pwned=1"><a href="javascript:alert(1)">bad</a>',
      '$$<img src=x onerror="window.pwned=1">$$',
      '<svg onload="window.pwned=1"></svg>'
    ]) {
      const result = render(payload)
      assert.equal(result.querySelector('[onerror], [onload], [href^="javascript:"]'), null)
    }
  } finally { window.close() }
})

test('stream cache distinguishes different answers with equal lengths and prefixes', () => {
  const { render, window } = streamingRenderer()
  try {
    const prefix = 'a'.repeat(60)
    assert.equal(render(prefix + ' first').textContent.trim(), prefix + ' first')
    assert.equal(render(prefix + ' other').textContent.trim(), prefix + ' other')
  } finally { window.close() }
})
