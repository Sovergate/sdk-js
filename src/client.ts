import { send } from './sender'
import { LogQueue } from './queue'
import { patchOpenAI, patchAnthropic } from './patcher'

export interface InitOptions {
  apiKey: string
  baseUrl?: string
  /**
   * Secret used to turn detected personal data into stable, irreversible tokens.
   * The same value always maps to the same token, so Sovergate can count unique
   * people without holding the data. Keep it secret and stable: it never leaves
   * your infrastructure. Without it, placeholders are numbered per record.
   */
  piiKey?: string
  debug?: boolean
}

const state: {
  apiKey: string | null
  baseUrl: string
  piiKey: string | undefined
  queue: LogQueue | null
} = {
  apiKey: null,
  baseUrl: 'https://api.sovergate.com',
  piiKey: undefined,
  queue: null,
}

export function init({ apiKey, baseUrl = 'https://api.sovergate.com', piiKey, debug = false }: InitOptions): void {
  try {
    state.apiKey = apiKey
    state.baseUrl = baseUrl.replace(/\/$/, '')
    state.piiKey = piiKey || undefined

    if (debug) {
      console.debug('[sovergate] init baseUrl=%s', state.baseUrl)
      if (!state.piiKey) {
        console.debug('[sovergate] no piiKey set: PII placeholders are numbered per record and not correlatable across logs')
      }
    }

    state.queue = new LogQueue(payload => send(apiKey, payload, state.baseUrl))
  } catch (err) {
    // Never let SDK setup break the host app; logging just stays disabled.
    state.queue = null
    warn('init failed, logging disabled', err)
  }
}

// Never throws: if instrumentation isn't possible, warn and leave the client untouched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function instrument(client: any): void {
  if (!state.queue) {
    warn('instrument() called before init({ apiKey }) — LLM calls will not be logged')
    return
  }

  try {
    const enqueue = state.queue.enqueue.bind(state.queue)

    if (client?.chat?.completions) {
      patchOpenAI(client, enqueue, state.piiKey)
      return
    }

    if (client?.messages) {
      patchAnthropic(client, enqueue, state.piiKey)
      return
    }

    warn(
      'unsupported client — LLM calls will not be logged. Pass an OpenAI or Anthropic ' +
      'client instance, or open an issue at https://github.com/sovergate/sdk-js/issues',
    )
  } catch (err) {
    warn('instrument() failed, LLM calls will not be logged', err)
  }
}

function warn(message: string, err?: unknown): void {
  try {
    console.warn(`[sovergate] ${message}`, ...(err === undefined ? [] : [err]))
  } catch {
    // never propagate
  }
}

export function shutdown(): void {
  state.queue = null
  state.piiKey = undefined
}
