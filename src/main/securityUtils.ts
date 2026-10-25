import * as path from 'node:path'

export function isTrustedSenderId(senderId: number | null | undefined, trustedIds: number[]): boolean {
  return typeof senderId === 'number' && trustedIds.includes(senderId)
}

export function isPathWithinRoots(targetPath: string, roots: string[]): boolean {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false

  const resolvedTarget = path.resolve(targetPath)

  return roots.some((root) => {
    if (typeof root !== 'string' || !root.trim()) return false
    const resolvedRoot = path.resolve(root)
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)
  })
}

export function isAllowedTempRecordingPath(targetPath: string, tempRoot: string): boolean {
  if (!isPathWithinRoots(targetPath, [tempRoot])) return false
  const basename = path.basename(targetPath)
  return /^recording-.*\.(wav|webm)$/i.test(basename)
}

export function shouldRestoreClipboardText(currentText: string, pastedText: string): boolean {
  return currentText === pastedText
}

export function didFocusTargetChange(before: string | null, after: string | null): boolean {
  if (!before || !after) return false
  return before !== after
}
