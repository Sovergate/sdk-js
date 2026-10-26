import { send } from './sender'
import { LogQueue } from './queue'
import { patchOpenAI, patchAnthropic } from './patcher'

export interface InitOptions {
  apiKey: string
  baseUrl?: string
  debug?: boolean
}

const state: {
  apiKey: string | null
  baseUrl: string
  queue: LogQueue | null
} = {
  apiKey: null,
  baseUrl: 'https://api.sovergate.com',
  queue: null,
}

export function init({ apiKey, baseUrl = 'https://api.sovergate.com', debug = false }: InitOptions): void {
  try {
    state.apiKey = apiKey
    state.baseUrl = baseUrl.replace(/\/$/, '')

    if (debug) {
      console.debug('[sovergate] init baseUrl=%s', state.baseUrl)
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
      patchOpenAI(client, enqueue)
      return
    }

    if (client?.messages) {
      patchAnthropic(client, enqueue)
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
}
