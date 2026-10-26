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

// Each rule: [category, regex (must have g flag), placeholder base]
// Order matters — IP before phone to avoid dotted-quad false matches.
const RULES: Array<[string, RegExp, string]> = [
  ['email',     /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,                              'EMAIL_REDACTED'],
  ['ip',        /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,                                                        'IP_REDACTED'],
  ['iban',      /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,                                                    'IBAN_REDACTED'],
  // (?<![\w+]) instead of \b so a leading "+" is part of the match, not left behind
  ['phone',     /(?<![\w+])\+?\d[\d\s\-(). ]{5,14}\d\b/g,                                            'PHONE_REDACTED'],
  ['dob',       /\b(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\b/g,   'DOB_REDACTED'],
  ['id_number', /\b[A-Z]{1,3}\d{6,9}\b/g,                                                              'ID_REDACTED'],
  ['name',      /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?: [A-Z][a-z]+)*\b/g,                       'NAME_REDACTED'],
]

/**
 * Numbers placeholders across one whole record (all messages and the response),
 * so the same value always gets the same placeholder and two different values
 * never share one.
 */
export class ScrubContext {
  private readonly seen = new Map<string, number>()
  private readonly next = new Map<string, number>()

  placeholder(base: string, value: string): string {
    const key = `${base}\u0000${value.replace(/[\s-]/g, '').toLowerCase()}`
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
