const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const {
  areMacPermissionsSatisfied,
  shouldAcknowledgeSystemAudioCapturePreflight
} = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'permissionUtils.ts'))

test('areMacPermissionsSatisfied requires effective screen capture, not just granted status elsewhere', () => {
  assert.equal(areMacPermissionsSatisfied({
    microphoneStatus: 'granted',
    screenEffective: false,
    accessibilityTrusted: true,
    automationApproved: true,
    inputMonitoringApproved: true,
    systemAudioCapturePreflightAcknowledged: true
  }), false)

  assert.equal(areMacPermissionsSatisfied({
    microphoneStatus: 'granted',
    screenEffective: true,
    accessibilityTrusted: true,
    automationApproved: true,
    inputMonitoringApproved: true,
    systemAudioCapturePreflightAcknowledged: true
  }), true)
})

test('shouldAcknowledgeSystemAudioCapturePreflight only passes on real progress', () => {
  assert.equal(shouldAcknowledgeSystemAudioCapturePreflight({
    preflightStarted: false,
    screenEffective: false
  }), false)

  assert.equal(shouldAcknowledgeSystemAudioCapturePreflight({
    preflightStarted: true,
    screenEffective: false
  }), true)

  assert.equal(shouldAcknowledgeSystemAudioCapturePreflight({
    preflightStarted: false,
    screenEffective: true
  }), true)
})
