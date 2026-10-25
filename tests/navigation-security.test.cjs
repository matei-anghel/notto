const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const { loadTsWithMocks } = require('./helpers/load-ts-with-mocks.cjs')
const opened = []
const { isTrustedAppUrl, isTrustedAppFrame, guardAppNavigation } = loadTsWithMocks(
  path.join(__dirname, '../src/main/navigationSecurity.ts'),
  { electron: { shell: { openExternal: async url => { opened.push(url) } } } }
)
const root = path.resolve(__dirname, '..')
const page = name => pathToFileURL(path.join(root, name)).href

test('only known local application pages are trusted', () => {
  assert.equal(isTrustedAppUrl(page('chat.html') + '?mode=test', root), true)
  for (const url of ['https://example.com/chat.html', page('attachments/evil.html'), page('../chat.html'), 'about:blank', 'javascript:alert(1)']) {
    assert.equal(isTrustedAppUrl(url, root), false, url)
  }
})

test('remote documents and subframes cannot inherit a trusted window IPC identity', () => {
  const mainFrame = { url: page('index.html') }
  const sender = { mainFrame }
  assert.equal(isTrustedAppFrame({ sender, senderFrame: mainFrame }, root), true)
  assert.equal(isTrustedAppFrame({ sender, senderFrame: { url: page('index.html') } }, root), false)
  mainFrame.url = 'https://example.com'
  assert.equal(isTrustedAppFrame({ sender, senderFrame: mainFrame }, root), false)
})

test('navigation guards keep external pages and popups outside the application', () => {
  opened.length = 0
  const contents = new EventEmitter()
  contents.setWindowOpenHandler = handler => { contents.popup = handler }
  guardAppNavigation(contents, root)
  assert.deepEqual(contents.popup({ url: 'https://example.com' }), { action: 'deny' })
  contents.popup({ url: 'file:///C:/Windows/system.ini' })
  let prevented = false
  contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://example.com/next')
  assert.equal(prevented, true)
  prevented = false
  contents.emit('will-navigate', { preventDefault: () => { prevented = true } }, page('permissions.html'))
  assert.equal(prevented, false)
  assert.deepEqual(opened, ['https://example.com', 'https://example.com/next'])
})
