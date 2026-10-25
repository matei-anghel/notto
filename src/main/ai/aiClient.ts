import {
  getAiProvider,
  type AiProviderId,
  type AiProviderInfo,
  type AiSettings,
  type AiTask,
} from '../../shared/aiProviders'
import { readChatCompletionResponse } from '../../shared/chatCompletionResponse'
import { getApiKey } from './keyStore'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatCompletionOptions {
  messages: ChatMessage[]
  /** Defaults to 'vision' when any message carries an image, otherwise 'chat'. */
  task?: 'chat' | 'vision'
  stream?: boolean
  onChunk?: (text: string) => void
  signal?: AbortSignal
  maxTokens?: number
}

/** Thrown when the user has not picked a provider/model or added a key yet. */
export class AiNotConfiguredError extends Error {
  readonly code = 'ai-not-configured'
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8192
const TASK_LABEL: Record<AiTask, string> = { chat: 'chat', vision: 'image', transcription: 'transcription' }

let getSettings: () => AiSettings = () => { throw new Error('AI client is not configured') }

export function configureAiClient(settingsGetter: () => AiSettings): void {
  getSettings = settingsGetter
}

interface ResolvedTarget {
  provider: AiProviderInfo
  model: string
  baseUrl: string
  apiKey: string | null
}

function resolveBaseUrl(provider: AiProviderInfo, settings: AiSettings): string {
  return (settings.baseUrls[provider.id] || provider.baseUrl).replace(/\/+$/, '')
}

function resolveProvider(providerId: AiProviderId, settings: AiSettings): Omit<ResolvedTarget, 'model'> {
  const provider = getAiProvider(providerId)
  if (!provider) throw new AiNotConfiguredError(`Unknown AI provider "${providerId}"`)
  const apiKey = getApiKey(provider.id)
  if (provider.requiresKey && !apiKey) {
    throw new AiNotConfiguredError(`Add your ${provider.label} API key in Settings → AI Providers.`)
  }
  return { provider, baseUrl: resolveBaseUrl(provider, settings), apiKey }
}

export function resolveTask(task: AiTask): ResolvedTarget {
  const settings = getSettings()
  let selection = settings[task]
  if (task === 'vision' && !selection.provider) selection = settings.chat
  if (!selection.provider || !selection.model) {
    throw new AiNotConfiguredError(`Choose a ${TASK_LABEL[task]} model in Settings → AI Providers.`)
  }
  return { ...resolveProvider(selection.provider, settings), model: selection.model }
}

/** True when a provider and model are chosen for the task (the key may still be missing). */
export function isTaskConfigured(task: AiTask): boolean {
  try {
    resolveTask(task)
    return true
  } catch {
    return false
  }
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function describeHttpError(provider: AiProviderInfo, response: Response): Promise<Error> {
  let detail = ''
  try {
    const body = await response.text()
    try {
      const parsed = JSON.parse(body)
      detail = parsed?.error?.message || parsed?.message || parsed?.err_msg || body
    } catch {
      detail = body
    }
  } catch { }
  const hint = response.status === 401 || response.status === 403
    ? ' Check the API key in Settings → AI Providers.'
    : response.status === 429 ? ' Rate limit or quota reached on your provider account.' : ''
  return new Error(`${provider.label} error ${response.status}: ${String(detail).slice(0, 300).trim()}${hint}`)
}

function describeNetworkError(target: Omit<ResolvedTarget, 'model'>, error: any): Error {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return error
  const where = target.provider.local ? ` Is it running at ${target.baseUrl}?` : ''
  return new Error(`Could not reach ${target.provider.label}: ${error?.cause?.code || error?.message || error}.${where}`)
}

function openAiHeaders(target: Omit<ResolvedTarget, 'model'>): Record<string, string> {
  const headers: Record<string, string> = {}
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`
  if (target.provider.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/matei-anghel/notto'
    headers['X-Title'] = 'Notto'
  }
  return headers
}

function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<{ ok: true; text: string; streaming?: boolean }> {
  const target = resolveTask(options.task ?? (hasImages(options.messages) ? 'vision' : 'chat'))
  return target.provider.api === 'anthropic'
    ? anthropicChat(target, options)
    : openAiChat(target, options)
}

async function openAiChat(target: ResolvedTarget, options: ChatCompletionOptions) {
  const stream = !!options.stream
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...openAiHeaders(target) },
      body: JSON.stringify({
        model: target.model,
        messages: options.messages,
        stream,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
      signal: withTimeout(options.signal),
    })
  } catch (error) {
    throw describeNetworkError(target, error)
  }
  if (!response.ok) throw await describeHttpError(target.provider, response)
  return readChatCompletionResponse(response, stream, options.onChunk, options.signal)
}

function toAnthropicImage(url: string) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url)
  return match
    ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
    : { type: 'image', source: { type: 'url', url } }
}

/** Anthropic takes the system prompt separately and requires alternating user/assistant turns. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: any[] } {
  const textOf = (content: ChatMessage['content']) => typeof content === 'string'
    ? content
    : content.filter((part) => part.type === 'text').map((part: any) => part.text).join('\n')
  const system = messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n\n')
  const turns: any[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : toAnthropicImage(part.image_url.url))
    const previous = turns[turns.length - 1]
    if (previous && previous.role === message.role) previous.content.push(...blocks)
    else turns.push({ role: message.role, content: blocks })
  }
  return { system, messages: turns }
}

async function anthropicChat(target: ResolvedTarget, options: ChatCompletionOptions) {
  const stream = !!options.stream
  const { system, messages } = toAnthropicMessages(options.messages)
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': target.apiKey || '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages,
        stream,
      }),
      signal: withTimeout(options.signal),
    })
  } catch (error) {
    throw describeNetworkError(target, error)
  }
  if (!response.ok) throw await describeHttpError(target.provider, response)
  return readAnthropicResponse(response, stream, options.onChunk, options.signal)
}

export async function readAnthropicResponse(
  response: Response,
  stream: boolean,
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string; streaming?: boolean }> {
  const requireText = (text: string) => {
    if (!text.trim()) throw new Error('Empty response from AI')
    return text
  }
  if (!stream) {
    const data: any = await response.json()
    if (data?.type === 'error') throw new Error(data.error?.message || 'Anthropic returned an error')
    const text = (data?.content || []).filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('')
    return { ok: true, text: requireText(text) }
  }
  if (!response.body) throw new Error('AI response has no stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let finished = false
  const consume = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload) return
    const data = JSON.parse(payload)
    if (data?.type === 'error') throw new Error(data.error?.message || 'Anthropic stream error')
    if (data?.type === 'message_stop') finished = true
    if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
      fullText += data.delta.text
      onChunk?.(data.delta.text)
    }
  }
  try {
    while (!finished) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) consume(line)
      if (done) {
        if (buffer.trim()) consume(buffer)
        break
      }
    }
    signal?.throwIfAborted()
    if (!finished) throw new Error('AI stream ended before completion')
    return { ok: true, text: requireText(fullText), streaming: true }
  } finally {
    try { await reader.cancel() } catch { }
    reader.releaseLock()
  }
}

/** Largest WAV the configured transcription provider accepts in one request. */
export function getTranscriptionChunkBytes(): number {
  const { provider } = resolveTask('transcription')
  return provider.api === 'deepgram' ? 100 * 1024 * 1024 : 24 * 1024 * 1024
}

export async function transcribeAudio(wav: Buffer, options: { language?: string; signal?: AbortSignal } = {}): Promise<string> {
  const target = resolveTask('transcription')
  const language = options.language && !['auto', 'multi'].includes(options.language) ? options.language : ''
  let response: Response
  try {
    if (target.provider.api === 'deepgram') {
      const url = new URL(`${target.baseUrl}/listen`)
      url.searchParams.set('model', target.model)
      url.searchParams.set('language', language || 'multi')
      url.searchParams.set('smart_format', 'true')
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${target.apiKey}`, 'Content-Type': 'audio/wav' },
        body: new Uint8Array(wav),
        signal: withTimeout(options.signal),
      })
    } else {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', target.model)
      form.append('response_format', 'json')
      if (language) form.append('language', language)
      response = await fetch(`${target.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: openAiHeaders(target),
        body: form,
        signal: withTimeout(options.signal),
      })
    }
  } catch (error) {
    throw describeNetworkError(target, error)
  }
  if (!response.ok) throw await describeHttpError(target.provider, response)
  const data: any = await response.json()
  const text = target.provider.api === 'deepgram'
    ? data?.results?.channels?.[0]?.alternatives?.[0]?.transcript
    : data?.text
  return typeof text === 'string' ? text.trim() : ''
}

/** Deepgram key for live dictation streaming, or null when live streaming is not configured. */
export function getLiveDictationKey(): string | null {
  const settings = getSettings()
  if (!settings.liveDictation || settings.transcription.provider !== 'deepgram') return null
  return getApiKey('deepgram')
}

export function getLiveDictationModel(): string {
  return getSettings().transcription.model || 'nova-3'
}

/** Model ids the provider reports, for the settings model picker. */
export async function listModels(providerId: AiProviderId): Promise<string[]> {
  const target = resolveProvider(providerId, getSettings())
  if (!target.provider.canListModels) return []
  const headers: Record<string, string> = target.provider.api === 'anthropic'
    ? { 'x-api-key': target.apiKey || '', 'anthropic-version': ANTHROPIC_VERSION }
    : openAiHeaders(target)
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/models`, { headers, signal: withTimeout() })
  } catch (error) {
    throw describeNetworkError(target, error)
  }
  if (!response.ok) throw await describeHttpError(target.provider, response)
  const data: any = await response.json()
  const entries: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  return entries
    .map((entry) => String(entry?.id ?? entry?.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}
