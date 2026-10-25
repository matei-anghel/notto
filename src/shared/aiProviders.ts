/**
 * Catalog of AI providers Notto can talk to with the user's own API keys (or local servers).
 * Shared by the main process (requests) and the settings UI (pickers). Model lists are only
 * suggestions: any model id the provider accepts can be typed in, and OpenAI-compatible
 * providers can list their live models.
 */

export type AiProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'fireworks'
  | 'cerebras'
  | 'perplexity'
  | 'deepgram'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

/** Wire protocol used to reach the provider. */
export type AiProviderApi = 'openai' | 'anthropic' | 'deepgram'

export interface AiProviderInfo {
  id: AiProviderId
  label: string
  api: AiProviderApi
  /** Default endpoint; users can override it (e.g. a proxy or a different local port). */
  baseUrl: string
  /** Local servers run without a key. */
  requiresKey: boolean
  local?: boolean
  supportsChat: boolean
  supportsTranscription: boolean
  /** Whether GET {baseUrl}/models lists the available models. */
  canListModels: boolean
  chatModels: string[]
  transcriptionModels: string[]
  keyUrl?: string
}

export const AI_PROVIDERS: readonly AiProviderInfo[] = [
  {
    id: 'openai', label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: true, canListModels: true,
    chatModels: ['gpt-5.5', 'gpt-5-mini', 'gpt-4.1'],
    transcriptionModels: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    transcriptionModels: [],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google', label: 'Google Gemini', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview'],
    transcriptionModels: [],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter', label: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['openai/gpt-5.5', 'anthropic/claude-sonnet-5-5', 'google/gemini-3.5-flash', 'openai/gpt-oss-120b'],
    transcriptionModels: [],
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq', label: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: true, canListModels: true,
    chatModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    transcriptionModels: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral', label: 'Mistral', api: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: true, canListModels: true,
    chatModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    transcriptionModels: ['voxtral-mini-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek', label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['deepseek-chat', 'deepseek-reasoner'],
    transcriptionModels: [],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'xai', label: 'xAI (Grok)', api: 'openai', baseUrl: 'https://api.x.ai/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['grok-4', 'grok-4-fast'],
    transcriptionModels: [],
    keyUrl: 'https://console.x.ai',
  },
  {
    id: 'together', label: 'Together AI', api: 'openai', baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: true, canListModels: true,
    chatModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput'],
    transcriptionModels: ['openai/whisper-large-v3'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'fireworks', label: 'Fireworks AI', api: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    transcriptionModels: [],
    keyUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'cerebras', label: 'Cerebras', api: 'openai', baseUrl: 'https://api.cerebras.ai/v1',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['gpt-oss-120b', 'llama-3.3-70b'],
    transcriptionModels: [],
    keyUrl: 'https://cloud.cerebras.ai',
  },
  {
    id: 'perplexity', label: 'Perplexity', api: 'openai', baseUrl: 'https://api.perplexity.ai',
    requiresKey: true, supportsChat: true, supportsTranscription: false, canListModels: false,
    chatModels: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    transcriptionModels: [],
    keyUrl: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'deepgram', label: 'Deepgram', api: 'deepgram', baseUrl: 'https://api.deepgram.com/v1',
    requiresKey: true, supportsChat: false, supportsTranscription: true, canListModels: false,
    chatModels: [],
    transcriptionModels: ['nova-3', 'nova-2'],
    keyUrl: 'https://console.deepgram.com',
  },
  {
    id: 'ollama', label: 'Ollama (local)', api: 'openai', baseUrl: 'http://localhost:11434/v1',
    requiresKey: false, local: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: ['llama3.2', 'qwen3', 'gemma3'],
    transcriptionModels: [],
  },
  {
    id: 'lmstudio', label: 'LM Studio (local)', api: 'openai', baseUrl: 'http://localhost:1234/v1',
    requiresKey: false, local: true, supportsChat: true, supportsTranscription: false, canListModels: true,
    chatModels: [],
    transcriptionModels: [],
  },
  {
    // vLLM, llama.cpp server, LocalAI, Jan, speaches / faster-whisper-server, or any proxy.
    id: 'custom', label: 'Custom OpenAI-compatible', api: 'openai', baseUrl: 'http://localhost:8000/v1',
    requiresKey: false, local: true, supportsChat: true, supportsTranscription: true, canListModels: true,
    chatModels: [],
    transcriptionModels: ['whisper-1', 'Systran/faster-whisper-large-v3'],
  },
]

export type AiTask = 'chat' | 'vision' | 'transcription'

export interface AiTaskSelection {
  provider: AiProviderId | ''
  model: string
}

export interface AiSettings {
  /** Chat overlay, meeting notes, AI mode and speaking trainer. */
  chat: AiTaskSelection
  /** Requests that include images (screenshots, AI mode). Empty provider = use the chat model. */
  vision: AiTaskSelection
  /** Dictation and meeting transcription. */
  transcription: AiTaskSelection
  /** Stream dictation live over Deepgram's WebSocket when Deepgram is the transcription provider. */
  liveDictation: boolean
  /** Per-provider endpoint overrides. */
  baseUrls: Partial<Record<AiProviderId, string>>
}

export function defaultAiSettings(): AiSettings {
  return {
    chat: { provider: '', model: '' },
    vision: { provider: '', model: '' },
    transcription: { provider: '', model: '' },
    liveDictation: true,
    baseUrls: {},
  }
}

export function getAiProvider(id: string | undefined | null): AiProviderInfo | undefined {
  return AI_PROVIDERS.find((provider) => provider.id === id)
}

function normalizeSelection(value: any, task: AiTask): AiTaskSelection {
  const provider = getAiProvider(value?.provider)
  const usable = provider && (task === 'transcription' ? provider.supportsTranscription : provider.supportsChat)
  return {
    provider: usable ? provider.id : '',
    model: usable && typeof value?.model === 'string' ? value.model.trim() : '',
  }
}

/** Coerce stored or renderer-supplied settings into a valid shape. */
export function normalizeAiSettings(value: any): AiSettings {
  const defaults = defaultAiSettings()
  const baseUrls: AiSettings['baseUrls'] = {}
  if (value?.baseUrls && typeof value.baseUrls === 'object') {
    for (const [id, url] of Object.entries(value.baseUrls)) {
      if (getAiProvider(id) && typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
        baseUrls[id as AiProviderId] = url.trim().replace(/\/+$/, '')
      }
    }
  }
  return {
    chat: normalizeSelection(value?.chat, 'chat'),
    vision: normalizeSelection(value?.vision, 'vision'),
    transcription: normalizeSelection(value?.transcription, 'transcription'),
    liveDictation: typeof value?.liveDictation === 'boolean' ? value.liveDictation : defaults.liveDictation,
    baseUrls,
  }
}

/** What the settings UI receives: settings, the catalog, and which keys exist (never the keys). */
export interface AiSettingsSnapshot {
  ok: true
  settings: AiSettings
  providers: readonly AiProviderInfo[]
  encrypted: boolean
  keys: Partial<Record<AiProviderId, { last4: string }>>
}
