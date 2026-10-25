const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8')

test('main window bootstrap loads packaged html instead of localhost', () => {
  assert.match(mainSource, /mainWindow\.loadFile\(path\.join\(__dirname, '\.\.', 'index\.html'\)\)/)
  assert.doesNotMatch(mainSource, /http:\/\/127\.0\.0\.1/)
})
