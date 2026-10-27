import { ScrubContext, scrub, scrubMessages } from './scrubber'

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
      get(target, prop, proxy) {
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value

        // The native .catch() and .finally() would call the target's own then(),
        // skipping the hook below; route them through the proxy's then().
        if (prop === 'catch' || prop === 'finally') {
          return (...args: unknown[]) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (Promise.prototype[prop] as (...a: unknown[]) => Promise<any>).apply(proxy, args)
        }

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

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // never let logging errors surface to the caller
  }
}

/** Rebuilds, from a stream's chunks, the parts of the full response that are logged. */
interface StreamCollector {
  add(chunk: unknown): void
  /** The response as a non-streamed call would have returned it, or null if nothing arrived. */
  response(): unknown
}

/**
 * Logs a provider stream once it ends, is abandoned part-way, or fails. Only the
 * stream object's own async iterator is replaced: the app gets the same object
 * (its class, `.controller`, `.tee()` and `.toReadableStream()` keep working) and
 * every chunk unchanged as it arrives. A copy of the text is collected on the side.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function instrumentStream(stream: any, collector: StreamCollector, done: (response: unknown) => void): void {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return
  const iterate = stream[Symbol.asyncIterator]

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    safely(() => {
      const response = collector.response()
      if (response) done(response)
    })
  }

  stream[Symbol.asyncIterator] = function () {
    const iterator = iterate.call(this)
    return {
      async next(...args: unknown[]) {
        let result
        try {
          result = await iterator.next(...args)
        } catch (err) {
          finish()
          throw err
        }
        if (result.done) finish()
        else safely(() => collector.add(result.value))
        return result
      },
      // `break` out of a for await loop lands here.
      async return(value?: unknown) {
        finish()
        return typeof iterator.return === 'function' ? iterator.return(value) : { done: true, value }
      },
      async throw(err?: unknown) {
        finish()
        if (typeof iterator.throw === 'function') return iterator.throw(err)
        throw err
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openAIStreamCollector(): StreamCollector {
  let seen = false
  let model: string | undefined
  let finishReason: string | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let usage: any
  const parts: string[] = []
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    add(chunk: any) {
      seen = true
      model = chunk?.model ?? model
      // Only sent when the app asks for it with stream_options: { include_usage: true }.
      usage = chunk?.usage ?? usage
      for (const choice of chunk?.choices ?? []) {
        if ((choice?.index ?? 0) !== 0) continue
        if (choice?.delta?.content) parts.push(choice.delta.content)
        finishReason = choice?.finish_reason ?? finishReason
      }
    },
    response() {
      if (!seen) return null
      return { model, choices: [{ message: { content: parts.join('') }, finish_reason: finishReason }], usage }
    },
  }
}

function anthropicStreamCollector(): StreamCollector {
  let seen = false
  let model: string | undefined
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  const parts: string[] = []
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    add(event: any) {
      seen = true
      if (event?.type === 'message_start') {
        model = event.message?.model
        inputTokens = event.message?.usage?.input_tokens ?? 0
        outputTokens = event.message?.usage?.output_tokens ?? 0
      } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        parts.push(event.delta.text)
      } else if (event?.type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? stopReason
        outputTokens = event.usage?.output_tokens ?? outputTokens
        inputTokens = event.usage?.input_tokens ?? inputTokens
      }
    },
    response() {
      if (!seen) return null
      return {
        model,
        content: [{ type: 'text', text: parts.join('') }],
        stop_reason: stopReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BuildPayload = (opts: any, response: any, requestAt: string, latencyMs: number, piiKey?: string) => Record<string, unknown>

/**
 * Wraps `target.create`. Plain calls are logged when the app reads the result;
 * streamed calls when the stream ends, so their latency covers the whole response.
 * The provider SDKs' own `.stream()` helpers call `create({ stream: true })`, so
 * they are covered too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapCreate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
  enqueue: Enqueue,
  build: BuildPayload,
  collector: () => StreamCollector,
  piiKey?: string,
): void {
  if (target[PATCHED]) return
  const original = target.create.bind(target)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target.create = (opts: any, ...rest: unknown[]) => {
    const requestAt = utcnow()
    const t0 = performance.now()

    const result = original(opts, ...rest)

    const done = (response: unknown): void => {
      const latencyMs = Math.round(performance.now() - t0)
      setImmediate(() => safely(() => enqueue(build(opts, response, requestAt, latencyMs, piiKey))))
    }

    if (isStream(opts)) return observe(result, (stream: unknown) => instrumentStream(stream, collector(), done))
    return observe(result, done)
  }
  target[PATCHED] = true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildOpenAIPayload(opts: any, response: any, requestAt: string, latencyMs: number, piiKey?: string) {
  const messages = opts?.messages ?? []
  const model = opts?.model ?? ''
  const context = new ScrubContext(piiKey)
  const [scrubbedMessages, promptDetections] = scrubMessages(messages, context)
  const choice = response?.choices?.[0]
  const responseText: string = choice?.message?.content ?? ''
  const scrubbedResult = responseText ? scrub(responseText, context) : null
  const scrubbedResponse = scrubbedResult?.text ?? ''
  const detections = [...promptDetections, ...(scrubbedResult?.detections ?? [])]
  const usage = response?.usage

  return {
    model: response?.model ?? model,
    messages: scrubbedMessages,
    response: scrubbedResponse,
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    latency_ms: latencyMs,
    timestamp: requestAt,
    finish_reason: choice?.finish_reason ?? null,
    pii_detections: detections.map(d => ({ category: d.category, placeholder: d.placeholder })),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAnthropicPayload(opts: any, response: any, requestAt: string, latencyMs: number, piiKey?: string) {
  const messages = opts?.messages ?? []
  const system = opts?.system
  const model = opts?.model ?? ''

  const allMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages

  const context = new ScrubContext(piiKey)
  const [scrubbedMessages, promptDetections] = scrubMessages(allMessages, context)

  const responseText: string = (response?.content ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((b: any) => b.type === 'text')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => b.text as string)
    .join('')

  const scrubbedResult = responseText ? scrub(responseText, context) : null
  const scrubbedResponse = scrubbedResult?.text ?? ''
  const detections = [...promptDetections, ...(scrubbedResult?.detections ?? [])]
  const usage = response?.usage

  return {
    model: response?.model ?? model,
    messages: scrubbedMessages,
    response: scrubbedResponse,
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    latency_ms: latencyMs,
    timestamp: requestAt,
    finish_reason: response?.stop_reason ?? null,
    pii_detections: detections.map(d => ({ category: d.category, placeholder: d.placeholder })),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patchOpenAI(client: any, enqueue: Enqueue, piiKey?: string): void {
  wrapCreate(client.chat.completions, enqueue, buildOpenAIPayload, openAIStreamCollector, piiKey)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patchAnthropic(client: any, enqueue: Enqueue, piiKey?: string): void {
  wrapCreate(client.messages, enqueue, buildAnthropicPayload, anthropicStreamCollector, piiKey)
}
