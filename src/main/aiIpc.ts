import { ipcMain } from 'electron'
import { IPC } from '../shared/ipcChannels'
import { AI_PROVIDERS, getAiProvider, normalizeAiSettings, type AiSettings } from '../shared/aiProviders'
import { configureAiClient, listModels } from './ai/aiClient'
import { describeApiKeys, setApiKey } from './ai/keyStore'

interface AiIpcDependencies {
  getAiSettings: () => AiSettings
  setAiSettings: (settings: AiSettings) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
}

export function registerAiIpcHandlers(deps: AiIpcDependencies): void {
  configureAiClient(deps.getAiSettings)

  const snapshot = () => ({
    ok: true as const,
    settings: deps.getAiSettings(),
    providers: AI_PROVIDERS,
    ...describeApiKeys(),
  })

  ipcMain.handle(IPC.invoke.ai.getSettings, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    return snapshot()
  })

  ipcMain.handle(IPC.invoke.ai.setSettings, async (evt, next: unknown) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    deps.setAiSettings(normalizeAiSettings(next))
    return snapshot()
  })

  ipcMain.handle(IPC.invoke.ai.setKey, async (evt, providerId: string, key: string) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    const provider = getAiProvider(providerId)
    if (!provider) return { ok: false, message: `Unknown provider: ${providerId}` }
    try {
      setApiKey(provider.id, typeof key === 'string' ? key : '')
      return snapshot()
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // Doubles as the "test connection" check: it fails on a bad key or an unreachable server.
  ipcMain.handle(IPC.invoke.ai.listModels, async (evt, providerId: string) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult({ models: [] })
    const provider = getAiProvider(providerId)
    if (!provider) return { ok: false, models: [], message: `Unknown provider: ${providerId}` }
    try {
      return { ok: true, models: await listModels(provider.id) }
    } catch (e: any) {
      return { ok: false, models: [], message: e?.message ?? String(e) }
    }
  })
}
