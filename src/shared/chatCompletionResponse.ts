/** Read provider responses without treating errors or truncated frames as success. */
export async function readChatCompletionResponse(
  response: Response,
  stream: boolean,
  onChunk?: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string; streaming?: boolean; usage?: unknown }> {
  const checkError = (data: any) => {
    if (data?.error || data?.choices?.[0]?.finish_reason === 'error') {
      throw new Error(data?.error?.message || 'AI provider returned an error')
    }
  }
  const checkText = (text: unknown): string => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response from AI')
    return text
  }

  signal?.throwIfAborted()
  if (!stream) {
    const data: any = await response.json()
    checkError(data)
    return { ok: true, text: checkText(data?.choices?.[0]?.message?.content), usage: data?.usage }
  }
  if (!response.body) throw new Error('AI response has no stream')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let finished = false
  let hasCompletion = false
  const consumeLine = async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') { finished = true; return }
    if (!payload) return
    const data = JSON.parse(payload)
    checkError(data)
    if (data?.choices?.[0]?.finish_reason) hasCompletion = true
    const content = data?.choices?.[0]?.delta?.content
    if (typeof content === 'string' && content) {
      fullText += content
      await onChunk?.(content)
    }
  }

  try {
    while (!finished) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        await consumeLine(line)
        if (finished) break
      }
      if (done) {
        if (!finished && buffer.trim()) await consumeLine(buffer)
        break
      }
    }
    signal?.throwIfAborted()
    if (!finished && !hasCompletion) throw new Error('AI stream ended before completion')
    return { ok: true, text: checkText(fullText), streaming: true }
  } finally {
    try { await reader.cancel() } catch { }
    reader.releaseLock()
  }
}
