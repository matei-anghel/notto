const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const builderConfigPath = path.join(root, 'electron-builder.yml')
const builderConfig = fs.readFileSync(builderConfigPath, 'utf8')

function assertSectionHasIcon(sectionName, iconPath) {
  const sectionPattern = new RegExp(
    `^${sectionName}:\\r?\\n(?:^[ \\t].*\\r?\\n)*?^[ \\t]+icon:\\s+${iconPath.replace('.', '\\.')}$`,
    'm'
  )

  assert.match(
    builderConfig,
    sectionPattern,
    `${sectionName} packaging must declare ${iconPath} so builds do not fall back to the Electron default icon`
  )
}

test('electron-builder keeps explicit app icons for packaged targets', () => {
  assertSectionHasIcon('win', 'build/icon.ico')
  assertSectionHasIcon('mac', 'build/icon.icns')
  assertSectionHasIcon('linux', 'build/icon.png')
})

test('nsis installer keeps explicit Windows installer icons', () => {
  assert.match(builderConfig, /^[ \t]+installerIcon:\s+icon\.ico$/m)
  assert.match(builderConfig, /^[ \t]+uninstallerIcon:\s+icon\.ico$/m)
})

test('packaging icon assets exist on disk', () => {
  for (const relativePath of ['build/icon.ico', 'build/icon.icns', 'build/icon.png']) {
    assert.equal(
      fs.existsSync(path.join(root, relativePath)),
      true,
      `${relativePath} must exist for packaging`
    )
  }
})


test('packaging includes every local HTML page loaded by the main process', () => {
  const mainSource = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8')
  for (const match of mainSource.matchAll(/['"]([a-z-]+\.html)['"]/g)) {
    assert.ok(builderConfig.includes('"' + match[1] + '"'), `${match[1]} must be included in installer files`)
  }
})
