import { scrub, scrubMessages } from './scrubber'

type Enqueue = (payload: Record<string, unknown>) => void

const PATCHED = Symbol.for('sovergate.patched')

function utcnow(): string {
  return new Date().toISOString()
}

/**
 * Returns the provider's own result unchanged in behaviour, but notifies `onData`
 * the first time the app reads the parsed result (await / .then / .withResponse).
 *
 * The OpenAI and Anthropic SDKs return an APIPromise with extra methods
 * (.withResponse(), .asResponse()) and parse the body lazily. Wrapping create()
 * in an async function would drop those methods, and reading the result eagerly
 * would consume the body before an app calling .asResponse() can. A Proxy keeps
 * the original object, its prototype and its laziness intact.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function observe(result: any, onData: (data: any) => void): any {
  if (!result || typeof result.then !== 'function') return result

  let seen = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const notify = (data: any): void => {
    if (seen) return
    seen = true
    try {
      onData(data)
    } catch {
      // never let logging errors surface to the caller
    }
  }

  try {
    return new Proxy(result, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value

        if (prop === 'then') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (onFulfilled?: any, onRejected?: any) =>
            value.call(
              target,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (data: any) => {
                notify(data)
                return typeof onFulfilled === 'function' ? onFulfilled(data) : data
              },
              onRejected,
            )
        }

        if (prop === 'withResponse') {
          return (...args: unknown[]) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            value.apply(target, args).then((withResponse: any) => {
              notify(withResponse?.data)
              return withResponse
            })
        }

        return value.bind(target)
      },
    })
  } catch {
    return result
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isStream(opts: any): boolean {
  return opts?.stream === true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patchOpenAI(client: any, enqueue: Enqueue): void {
  const completions = client.chat.completions
  if (completions[PATCHED]) return
  const original = completions.create.bind(completions)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completions.create = (opts: any, ...rest: unknown[]) => {
    const requestAt = utcnow()
    const t0 = performance.now()

    const result = original(opts, ...rest)

    // Streams can only be read once and belong to the app; they are not logged yet.
    if (isStream(opts)) return result

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return observe(result, (response: any) => {
      const latencyMs = Math.round(performance.now() - t0)

      setImmediate(() => {
        try {
          const messages = opts?.messages ?? []
          const model = opts?.model ?? ''
          const [scrubbedMessages, detections] = scrubMessages(messages)
          const choice = response?.choices?.[0]
          const responseText: string = choice?.message?.content ?? ''
          const scrubbedResponse = responseText ? scrub(responseText).text : ''
          const usage = response?.usage

          enqueue({
            model: response?.model ?? model,
            messages: scrubbedMessages,
            response: scrubbedResponse,
            prompt_tokens: usage?.prompt_tokens ?? 0,
            completion_tokens: usage?.completion_tokens ?? 0,
            latency_ms: latencyMs,
            timestamp: requestAt,
            finish_reason: choice?.finish_reason ?? null,
            pii_detections: detections.map(d => ({ category: d.category, placeholder: d.placeholder })),
          })
        } catch {
          // never let logging errors surface to the caller
        }
      })
    })
  }
  completions[PATCHED] = true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patchAnthropic(client: any, enqueue: Enqueue): void {
  const messagesApi = client.messages
  if (messagesApi[PATCHED]) return
  const original = messagesApi.create.bind(messagesApi)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messagesApi.create = (opts: any, ...rest: unknown[]) => {
    const requestAt = utcnow()
    const t0 = performance.now()

    const result = original(opts, ...rest)

    // Streams can only be read once and belong to the app; they are not logged yet.
    if (isStream(opts)) return result

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return observe(result, (response: any) => {
      const latencyMs = Math.round(performance.now() - t0)

      setImmediate(() => {
        try {
          const messages = opts?.messages ?? []
          const system = opts?.system
          const model = opts?.model ?? ''

          const allMessages = system
            ? [{ role: 'system', content: system }, ...messages]
            : messages

          const [scrubbedMessages, detections] = scrubMessages(allMessages)

          const responseText: string = (response?.content ?? [])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((b: any) => b.type === 'text')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((b: any) => b.text as string)
            .join('')

          const scrubbedResponse = responseText ? scrub(responseText).text : ''
          const usage = response?.usage

          enqueue({
            model: response?.model ?? model,
            messages: scrubbedMessages,
            response: scrubbedResponse,
            prompt_tokens: usage?.input_tokens ?? 0,
            completion_tokens: usage?.output_tokens ?? 0,
            latency_ms: latencyMs,
            timestamp: requestAt,
            finish_reason: response?.stop_reason ?? null,
            pii_detections: detections.map(d => ({ category: d.category, placeholder: d.placeholder })),
          })
        } catch {
          // never let logging errors surface to the caller
        }
      })
    })
  }
  messagesApi[PATCHED] = true
}
