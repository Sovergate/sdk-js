const BASE_URL = 'https://api.sovergate.com'
const TIMEOUT_MS = 2000
const RETRYABLE_STATUS = new Set([408, 425, 429])

/**
 * sent:  accepted by the server
 * retry: temporary failure, keep the record and try again later
 * drop:  permanently rejected, retrying the same record can never succeed
 */
export type SendOutcome = 'sent' | 'retry' | 'drop'

export async function send(
  apiKey: string,
  payload: Record<string, unknown>,
  baseUrl = BASE_URL,
): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    timer.unref?.()

    const response = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (response.status < 400) return 'sent'
    if (RETRYABLE_STATUS.has(response.status) || response.status >= 500) return 'retry'

    // 400 (invalid record), 401/403 (bad or revoked key), 413 (too large)...
    // Retrying would block every later record behind this one.
    try {
      console.warn(`[sovergate] ingest rejected a record (HTTP ${response.status}); dropping it`)
    } catch {
      // never propagate
    }
    return 'drop'
  } catch {
    return 'retry'
  } finally {
    clearTimeout(timer)
  }
}
