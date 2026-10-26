import type { SendOutcome } from './sender'

type Payload = Record<string, unknown>
type SendFn = (payload: Payload) => Promise<SendOutcome | boolean>

const MAX_QUEUE = 10_000
const RETRY_DELAYS_S = [1, 2, 4, 8, 16, 30, 60]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class LogQueue {
  private readonly sendFn: SendFn
  private readonly items: Payload[] = []
  private draining = false

  constructor(sendFn: SendFn) {
    this.sendFn = sendFn
  }

  enqueue(payload: Payload): void {
    if (this.items.length >= MAX_QUEUE) return
    this.items.push(payload)
    if (!this.draining) {
      setImmediate(() => void this.drain())
    }
  }

  private async drain(): Promise<void> {
    this.draining = true
    let retryIndex = 0

    while (this.items.length > 0) {
      let done = false
      try {
        const outcome = await this.sendFn(this.items[0])
        // 'sent' and 'drop' both finish this record; true is accepted as 'sent'.
        done = outcome === true || outcome === 'sent' || outcome === 'drop'
      } catch {
        // never propagate
      }

      if (done) {
        this.items.shift()
        retryIndex = 0
      } else {
        const delaySec = RETRY_DELAYS_S[Math.min(retryIndex, RETRY_DELAYS_S.length - 1)]
        retryIndex++
        await sleep(delaySec * 1000)
      }
    }

    this.draining = false
  }
}
