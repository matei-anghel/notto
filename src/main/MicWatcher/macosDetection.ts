import { isIgnoredMicApp, isSystemProcess } from './meetingApps'

const ASSERTION_HEADER_RE = /^\s*pid\s+\d+\([^)]+\):/
const CREATED_FOR_PID_RE = /Created for PID:\s*(\d+)/i
const AUDIO_IN_RE = /Resources:\s*audio-in\b/i
const MIC_ASSERTION_RE = /(BuiltInMicrophoneDevice|AudioTap)/i

export interface PmsetMicCandidateScan {
  hasWebRtcAssertion: boolean
  createdForPids: number[]
}

function blockHasAudioInput(lines: string[]): boolean {
  return lines.some((line) => AUDIO_IN_RE.test(line) || MIC_ASSERTION_RE.test(line))
}

export function scanPmsetForMicUsageCandidates(output: string): PmsetMicCandidateScan {
  const lines = output.split('\n')
  const createdForPids: number[] = []
  let currentBlock: string[] = []
  let hasWebRtcAssertion = false

  const flushBlock = () => {
    if (!currentBlock.length) return
    if (!blockHasAudioInput(currentBlock)) {
      currentBlock = []
      return
    }

    for (const line of currentBlock) {
      const match = line.match(CREATED_FOR_PID_RE)
      if (match) {
        const pid = Number.parseInt(match[1], 10)
        if (Number.isFinite(pid)) {
          createdForPids.push(pid)
        }
      }
    }

    currentBlock = []
  }

  for (const line of lines) {
    if (line.includes('NoIdleSleepAssertion') && line.includes('WebRTC has active PeerConnections')) {
      hasWebRtcAssertion = true
    }

    if (ASSERTION_HEADER_RE.test(line)) {
      flushBlock()
    }

    if (line.trim()) {
      currentBlock.push(line)
    }
  }

  flushBlock()

  return {
    hasWebRtcAssertion,
    createdForPids: Array.from(new Set(createdForPids))
  }
}

export function evaluateHelperClientCount(numClients: number): 'active' | 'inactive' | 'unknown' {
  if (numClients >= 1) return 'active'
  if (numClients === 0) return 'inactive'
  return 'unknown'
}

export async function hasExternalMicUsageFromPmset(
  output: string,
  options: {
    ownPid: number
    ignoredApps?: string[]
    getProcessName: (pid: number) => Promise<string | null>
  }
): Promise<boolean> {
  const scan = scanPmsetForMicUsageCandidates(output)
  if (scan.hasWebRtcAssertion) {
    return true
  }

  for (const pid of scan.createdForPids) {
    if (pid === options.ownPid) continue

    try {
      const procNameRaw = await options.getProcessName(pid)
      if (!procNameRaw) continue

      const procName = procNameRaw.split('/').pop() || procNameRaw
      if (isSystemProcess(procName) || isIgnoredMicApp(procName, options.ignoredApps || [])) {
        continue
      }

      return true
    } catch {
      continue
    }
  }

  return false
}
