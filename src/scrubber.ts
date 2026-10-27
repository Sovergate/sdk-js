import { createHmac } from 'node:crypto'

export interface Detection {
  category: string
  placeholder: string
}

export interface ScrubResult {
  text: string
  detections: Detection[]
}

type ContentBlock = { type: string; text?: string } & Record<string, unknown>
export type OpenAIMessage = { role: string; content: string | ContentBlock[] } & Record<string, unknown>

// Hex chars of the HMAC digest shown in a token. 12 hex = 48 bits: enough to keep
// collisions negligible at realistic volumes while staying readable.
const TOKEN_HEX_LEN = 12

// Each rule: [category, regex (must have g flag), placeholder base].
// Kept identical to the Python SDK, so both produce the same tokens for the same key.
const RULES: Array<[string, RegExp, string]> = [
  ['email',     /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,                              'EMAIL_REDACTED'],
  // IP before phone: the phone rule would otherwise swallow dotted quads
  ['ip',        /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,                                                        'IP_REDACTED'],
  // IBAN: tolerate the usual 4-character grouping ("DE89 3704 0044 ...") so a spaced
  // IBAN can't leak its digits to the phone rule
  ['iban',      /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,                                          'IBAN_REDACTED'],
  // Card numbers before phone, so the whole grouped number (13–20 digits) is caught.
  // Reported as id_number: the ingest API has no card category.
  ['id_number', /\b\d{4}(?:[ -]?\d{4}){2,4}\b/g,                                                       'CARD_REDACTED'],
  // (?<![\w+]) instead of \b so a leading "+" is part of the match, not left behind
  ['phone',     /(?<![\w+])\+?\d[\d\s\-().]{5,14}\d\b/g,                                             'PHONE_REDACTED'],
  ['dob',       /\b(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\b/g,   'DOB_REDACTED'],
  ['id_number', /\b[A-Z]{1,3}\d{6,9}\b/g,                                                              'ID_REDACTED'],
  // Names last: a broad heuristic, applied only after a title
  ['name',      /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?: [A-Z][a-z]+)*\b/g,                       'NAME_REDACTED'],
]

/** Folds formatting differences (spaced IBAN, email case) so one value gets one placeholder. */
function normalize(value: string): string {
  return value.replace(/[\s-]/g, '').toLowerCase()
}

/**
 * Chooses the placeholder for each detected value in one record (all messages and
 * the response).
 *
 * With a `piiKey`, each value becomes a deterministic, irreversible HMAC token:
 * the same value gets the same token in every log, so Sovergate can count unique
 * people without ever holding the value. The key never leaves your infrastructure.
 *
 * Without a key, placeholders are numbered within the record: the same value
 * always gets the same number and two values never share one, but numbers can't
 * be matched across records.
 */
export class ScrubContext {
  private readonly seen = new Map<string, number>()
  private readonly next = new Map<string, number>()

  constructor(private readonly piiKey?: string) {}

  placeholder(base: string, value: string): string {
    if (this.piiKey) {
      const digest = createHmac('sha256', this.piiKey).update(normalize(value), 'utf8').digest('hex')
      return `[${base}_${digest.slice(0, TOKEN_HEX_LEN)}]`
    }

    const key = `${base}\u0000${normalize(value)}`
    let n = this.seen.get(key)
    if (n === undefined) {
      n = (this.next.get(base) ?? 0) + 1
      this.next.set(base, n)
      this.seen.set(key, n)
    }
    return `[${base}_${n}]`
  }
}

export function scrub(text: string, context: ScrubContext = new ScrubContext()): ScrubResult {
  if (!text) return { text, detections: [] }

  const detections: Detection[] = []

  let result = text
  for (const [category, pattern, basePlaceholder] of RULES) {
    pattern.lastIndex = 0
    result = result.replace(pattern, match => {
      const placeholder = context.placeholder(basePlaceholder, match)
      detections.push({ category, placeholder })
      return placeholder
    })
  }

  return { text: result, detections }
}

export function scrubMessages(
  messages: OpenAIMessage[],
  context: ScrubContext = new ScrubContext(),
): [OpenAIMessage[], Detection[]] {
  const allDetections: Detection[] = []
  const scrubbed: OpenAIMessage[] = []

  for (const msg of messages) {
    const content = msg.content
    if (typeof content === 'string') {
      const result = scrub(content, context)
      scrubbed.push({ ...msg, content: result.text })
      allDetections.push(...result.detections)
    } else if (Array.isArray(content)) {
      const newBlocks = content.map(block => {
        if (block.type === 'text' && typeof block.text === 'string') {
          const result = scrub(block.text, context)
          allDetections.push(...result.detections)
          return { ...block, text: result.text }
        }
        return block
      })
      scrubbed.push({ ...msg, content: newBlocks })
    } else {
      scrubbed.push(msg)
    }
  }

  return [scrubbed, allDetections]
}
