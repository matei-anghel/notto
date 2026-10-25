import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAiProvider, type AiProviderId } from '../../shared/aiProviders'

/**
 * API keys live only in the main process, encrypted with the OS credential store
 * (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). The renderer only
 * ever sees whether a key is set and its last four characters.
 */

type StoredKeys = Partial<Record<AiProviderId, string>>

let cache: StoredKeys | null = null

function keysPath(): string {
  return path.join(app.getPath('userData'), 'api-keys.json')
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function load(): StoredKeys {
  if (cache) return cache
  cache = {}
  try {
    const raw = JSON.parse(fs.readFileSync(keysPath(), 'utf8')) as Record<string, { enc?: string; plain?: string }>
    for (const [id, entry] of Object.entries(raw)) {
      if (!getAiProvider(id)) continue
      if (entry.enc && canEncrypt()) cache[id as AiProviderId] = safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))
      else if (entry.plain) cache[id as AiProviderId] = entry.plain
    }
  } catch {
    // Missing or unreadable file: no keys yet.
  }
  return cache
}

function persist(keys: StoredKeys): void {
  const encrypt = canEncrypt()
  const out: Record<string, { enc?: string; plain?: string }> = {}
  for (const [id, key] of Object.entries(keys)) {
    if (!key) continue
    // Without an OS keyring (some Linux setups) the key is stored as-is, readable only by this user.
    out[id] = encrypt ? { enc: safeStorage.encryptString(key).toString('base64') } : { plain: key }
  }
  fs.mkdirSync(path.dirname(keysPath()), { recursive: true })
  fs.writeFileSync(keysPath(), JSON.stringify(out, null, 2), { mode: 0o600 })
}

export function getApiKey(provider: AiProviderId): string | null {
  return load()[provider] || null
}

export function setApiKey(provider: AiProviderId, key: string): void {
  if (!getAiProvider(provider)) throw new Error(`Unknown provider: ${provider}`)
  const keys = { ...load() }
  const trimmed = key.trim()
  if (trimmed) keys[provider] = trimmed
  else delete keys[provider]
  persist(keys)
  cache = keys
}

/** What the settings UI may know about stored keys. */
export function describeApiKeys(): { encrypted: boolean; keys: Partial<Record<AiProviderId, { last4: string }>> } {
  const keys: Partial<Record<AiProviderId, { last4: string }>> = {}
  for (const [id, key] of Object.entries(load())) {
    if (key) keys[id as AiProviderId] = { last4: key.slice(-4) }
  }
  return { encrypted: canEncrypt(), keys }
}
