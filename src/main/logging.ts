import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { appendFile } from 'node:fs/promises'

const logQueue: string[] = []
let flushing = false
let resolvedPath: string | null = null

function resolveLogFilePath(): string {
  if (resolvedPath) {
    return resolvedPath
  }

  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    resolvedPath = path.join(dir, 'notto.log')
  } catch (error) {
    console.error('Failed to resolve log file path:', error)
    resolvedPath = path.join(process.cwd(), 'notto.log')
  }

  return resolvedPath
}

async function flushQueue(): Promise<void> {
  if (flushing) {
    return
  }

  flushing = true
  while (logQueue.length > 0) {
    const batch = logQueue.splice(0, 50)
    try {
      const filePath = resolveLogFilePath()
      const payload = batch.join('\n') + '\n'
      await appendFile(filePath, payload, { encoding: 'utf8' })
    } catch (error) {
      console.error('Failed to flush log batch:', error)
      logQueue.unshift(...batch)
      break
    }
  }
  flushing = false
}

export function queueLogLine(line: string): void {
  logQueue.push(line)
  if (!flushing) {
    void flushQueue()
  }
}

export function getLogFilePath(): string {
  return resolveLogFilePath()
}
