const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const {
  isAllowedTempRecordingPath,
  isPathWithinRoots,
  isTrustedSenderId,
  shouldRestoreClipboardText,
  didFocusTargetChange
} = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'securityUtils.ts'))

test('isPathWithinRoots allows children and blocks siblings', () => {
  const root = path.resolve('/tmp/notto')
  assert.equal(isPathWithinRoots(path.join(root, 'recording.wav'), [root]), true)
  assert.equal(isPathWithinRoots(path.resolve('/tmp/notto-elsewhere/recording.wav'), [root]), false)
  assert.equal(isPathWithinRoots(path.resolve('/tmp/notto/../escape.wav'), [root]), false)
})

test('isAllowedTempRecordingPath only permits expected temp recordings', () => {
  const tempRoot = path.resolve('/tmp/notto')
  assert.equal(isAllowedTempRecordingPath(path.join(tempRoot, 'recording-123.wav'), tempRoot), true)
  assert.equal(isAllowedTempRecordingPath(path.join(tempRoot, 'recording-123.webm'), tempRoot), true)
  assert.equal(isAllowedTempRecordingPath(path.join(tempRoot, 'notes.md'), tempRoot), false)
  assert.equal(isAllowedTempRecordingPath(path.resolve('/tmp/other/recording-123.wav'), tempRoot), false)
})

test('isTrustedSenderId only accepts known sender ids', () => {
  assert.equal(isTrustedSenderId(42, [1, 42, 99]), true)
  assert.equal(isTrustedSenderId(7, [1, 42, 99]), false)
  assert.equal(isTrustedSenderId(undefined, [1, 42, 99]), false)
})

test('clipboard restore helper only restores unchanged pasted text', () => {
  assert.equal(shouldRestoreClipboardText('dictated text', 'dictated text'), true)
  assert.equal(shouldRestoreClipboardText('user replaced clipboard', 'dictated text'), false)
})

test('focus change helper only reports when both targets are known and different', () => {
  assert.equal(didFocusTargetChange('Slack', 'Slack'), false)
  assert.equal(didFocusTargetChange('Slack', 'Cursor'), true)
  assert.equal(didFocusTargetChange(null, 'Cursor'), false)
})
