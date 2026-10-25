const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const root = path.join(__dirname, '..')

test('every supported macOS detection result resolves to a macOS download', () => {
  const source = fs.readFileSync(path.join(root, 'web/download/script.js'), 'utf8')
  const context = vm.createContext({ document: { readyState: 'loading', addEventListener: () => {} } })
  vm.runInContext(source, context)
  const assets = [{ name: 'Notto.dmg', browser_download_url: 'https://example.com/mac' },
    { name: 'Notto.exe', browser_download_url: 'https://example.com/windows' }]
  for (const platform of ['macos', 'macos-tahoe', 'macos-legacy']) {
    assert.equal(context.getAssetForPlatform(assets, platform), 'https://example.com/mac')
  }
  assert.equal(context.getAssetForPlatform(assets, 'windows'), 'https://example.com/windows')
  assert.equal(context.getAssetForPlatform(assets, 'unknown'), null)
})
