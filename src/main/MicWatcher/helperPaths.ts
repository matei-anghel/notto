import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

function getAppRoot(): string {
  try {
    return app.getAppPath()
  } catch {
    return process.cwd()
  }
}

function getPlatformArchDir(): string {
  return `${process.platform}-${process.arch}`
}

function getResourceRoots(): string[] {
  const appRoot = getAppRoot()
  return Array.from(new Set([
    path.join(appRoot, 'resources', 'bin'),
    path.join(process.cwd(), 'resources', 'bin')
  ]))
}

export function getMicWatcherHelperCandidates(helperName: string): string[] {
  const archDir = getPlatformArchDir()
  const candidates: string[] = []

  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', archDir, helperName))
  }

  for (const root of getResourceRoots()) {
    candidates.push(path.join(root, archDir, helperName))
  }

  return Array.from(new Set(candidates))
}

export function resolveMicWatcherHelper(helperName: string): string | null {
  for (const candidate of getMicWatcherHelperCandidates(helperName)) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function describeMicWatcherHelperResolution(helperName: string): {
  helperName: string;
  resolvedPath: string | null;
  candidates: string[];
} {
  const candidates = getMicWatcherHelperCandidates(helperName)
  const resolvedPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null

  return {
    helperName,
    resolvedPath,
    candidates
  }
}
