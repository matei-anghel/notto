const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const {
  evaluateHelperClientCount,
  hasExternalMicUsageFromPmset,
  scanPmsetForMicUsageCandidates
} = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'MicWatcher', 'macosDetection.ts'))
const { shouldShowMicPrompt } = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'micSessionState.ts'))

test('evaluateHelperClientCount treats a single active client as active on macOS', () => {
  assert.equal(evaluateHelperClientCount(1), 'active')
  assert.equal(evaluateHelperClientCount(0), 'inactive')
  assert.equal(evaluateHelperClientCount(-1), 'unknown')
})

test('scanPmsetForMicUsageCandidates captures built-in mic and audio tap assertions', () => {
  const sample = `
pid 453(coreaudiod): [0x01] PreventUserIdleSystemSleep named: "com.apple.audio.AudioTap-123.context.preventuseridlesleep"
\tCreated for PID: 746.
\tResources: audio-in C572340F-B6F8-4638-BC64-4FCD28BF392E
pid 453(coreaudiod): [0x02] PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep"
\tCreated for PID: 55420.
\tResources: audio-in BuiltInMicrophoneDevice
`

  assert.deepEqual(scanPmsetForMicUsageCandidates(sample), {
    hasWebRtcAssertion: false,
    createdForPids: [746, 55420]
  })
})

test('hasExternalMicUsageFromPmset ignores Notto and ignored apps but detects real external callers', async () => {
  const sample = `
pid 55328(Google Chrome): [0x0001] 00:00:07 NoIdleSleepAssertion named: "WebRTC has active PeerConnections"
pid 453(coreaudiod): [0x02] PreventUserIdleSystemSleep named: "com.apple.audio.AudioTap-123.context.preventuseridlesleep"
\tCreated for PID: 999.
\tResources: audio-in USBMic
pid 453(coreaudiod): [0x03] PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep"
\tCreated for PID: 321.
\tResources: audio-in BuiltInMicrophoneDevice
`

  const resolver = async (pid) => {
    if (pid === 999) return '/Applications/Notto.app/Contents/MacOS/Notto'
    if (pid === 321) return '/Applications/Voice Memos.app/Contents/MacOS/Voice Memos'
    return '/Applications/zoom.us.app/Contents/MacOS/zoom.us'
  }

  const active = await hasExternalMicUsageFromPmset(sample, {
    ownPid: 999,
    ignoredApps: ['voice memos'],
    getProcessName: resolver
  })

  assert.equal(active, true)
})

test('shouldShowMicPrompt stays false while dictation owns the session', () => {
  assert.equal(shouldShowMicPrompt({
    micSuppressUntilInactive: false,
    dictationActive: true,
    aiModeActive: false,
    chatInitiatedDictation: false,
    currentMicSessionDismissed: false,
    isMeetingActive: false
  }), false)

  assert.equal(shouldShowMicPrompt({
    micSuppressUntilInactive: false,
    dictationActive: false,
    aiModeActive: false,
    chatInitiatedDictation: false,
    currentMicSessionDismissed: false,
    isMeetingActive: false
  }), true)
})
