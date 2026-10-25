const RESUME_GRACE_MS = 30_000

let resumeGraceUntil = 0
let mainWindowVisibleBeforeSleep = false

export function markSystemSuspending(isMainWindowVisible: boolean): void {
  mainWindowVisibleBeforeSleep = isMainWindowVisible
}

export function markSystemResumed(): void {
  resumeGraceUntil = Date.now() + RESUME_GRACE_MS
}

export function isWithinResumeGracePeriod(): boolean {
  return Date.now() < resumeGraceUntil
}

export function wasMainWindowVisibleBeforeSleep(): boolean {
  return mainWindowVisibleBeforeSleep
}
