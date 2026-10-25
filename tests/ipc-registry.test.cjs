const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload.ts'), 'utf8')

test('main process orchestration no longer registers IPC handlers inline', () => {
  assert.match(mainSource, /import\s+\{\s*IPC\s*\}\s+from\s+'\.\/shared\/ipcChannels'/)
  assert.doesNotMatch(mainSource, /\bipcMain\.(handle|on)\b/)
  assert.doesNotMatch(mainSource, /webContents\.send\('/)
})

test('preload no longer exposes a generic invoke bridge', () => {
  assert.doesNotMatch(preloadSource, /\binvoke:\s*\(channel\b/)
  assert.doesNotMatch(preloadSource, /ipcRenderer\.invoke\(channel\b/)
})
