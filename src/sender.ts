const BASE_URL = 'https://api.sovergate.com'
const TIMEOUT_MS = 2000

export async function send(
  apiKey: string,
  payload: Record<string, unknown>,
  baseUrl = BASE_URL,
): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const response = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    clearTimeout(timer)
    return response.status < 400
  } catch {
    return false
  }
}
