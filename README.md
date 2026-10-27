# sovergate

TypeScript / JavaScript SDK for [Sovergate](https://sovergate.com): EU AI Act
Article 12 audit logging for LLM calls, with PII scrubbed inside your own
infrastructure.

> **Early access.** The SDK is published as an alpha and the hosted ingest
> service is not generally available yet. APIs may change before 1.0.

## How it works

Your app keeps calling OpenAI or Anthropic directly. Sovergate does not proxy
or intercept the request. After a call completes, the SDK takes a copy,
scrubs personal data **locally**, and sends the scrubbed copy to Sovergate in
the background.

```
Your app ─────────────────────────────► OpenAI / Anthropic
              │
              └──► scrub PII locally ──► Sovergate (async, fire and forget)
```

## Install

```bash
npm install sovergate@alpha
```

Requires Node.js 18+. Ships ESM and CommonJS builds with TypeScript types.
No runtime dependencies.

## Quick start

```typescript
import OpenAI from 'openai'
import { init, instrument } from 'sovergate'

const openai = new OpenAI()

init({ apiKey: 'sov_prod_xxxx' })
instrument(openai)

// Your existing code is unchanged
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
})
// The response is returned immediately; logging happens in the background
```

Anthropic works the same way:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { init, instrument } from 'sovergate'

const client = new Anthropic()
init({ apiKey: 'sov_prod_xxxx' })
instrument(client)
```

### Streaming

Streamed calls are logged too: `create({ stream: true })` on both providers, plus
the `chat.completions.stream()` and `messages.stream()` helpers. Your app gets
the same stream object and every chunk unchanged as soon as it arrives; the SDK
keeps a copy of the text and logs it once the stream ends. If your app stops
reading part-way, what it had received up to that point is logged.

OpenAI only reports token counts for a stream when you ask for them:

```ts
client.chat.completions.create({ ..., stream: true, stream_options: { include_usage: true } })
```

Without that option the record is still logged, with 0 tokens. The SDK never
adds the option itself, because it changes the chunks your app receives.

## Stable PII tokens (recommended)

By default, detected PII is replaced with positional placeholders
(`[EMAIL_REDACTED_1]`), which are not correlatable between logs. Pass a
`piiKey` to replace values with deterministic, irreversible HMAC-SHA256 tokens
instead. The same value always maps to the same token, so Sovergate can count
unique people, IBANs and so on without ever receiving the raw values.

```typescript
init({ apiKey: 'sov_prod_xxxx', piiKey: process.env.SOVERGATE_PII_KEY })
```

The `piiKey` is your secret. Keep it stable, and never send it to us: it stays
on your infrastructure, and without it the tokens cannot be reversed. The Python
SDK produces the same tokens for the same key, so services in both languages
count a person once.

## Options

```typescript
init({
  apiKey: 'sov_prod_xxxx',     // required
  baseUrl: 'https://...',      // default: https://api.sovergate.com
  piiKey: '<your-secret>',     // stable PII tokens (see above)
  debug: true,                 // print SDK internals to console.debug
})
```

## What is sent to Sovergate

For each completed call, one JSON record:

| Field | Content |
|---|---|
| `model` | Model name returned by the provider |
| `messages` | Your prompt messages, **after** PII scrubbing |
| `response` | The model's text output, **after** PII scrubbing |
| `prompt_tokens`, `completion_tokens` | Token counts from the provider |
| `latency_ms`, `timestamp` | Call duration and start time |
| `finish_reason` | Why the model stopped |
| `pii_detections` | Category and placeholder of each scrubbed item, never the original value |

Never sent: the raw prompt or response, your LLM provider API key, or request
headers.

### What the scrubber detects

Regex-based, applied to every text part of the prompt and response: email
addresses, IP addresses, IBANs, phone numbers, dates of birth, ID numbers, and
names that follow a title (Mr, Mrs, Ms, Dr, Prof). Other personal data, such
as names without a title, is **not** detected yet, so keep data minimisation in
mind when you build prompts. The code is in [`src/scrubber.ts`](src/scrubber.ts).

## Guarantees

- Never blocks the event loop: logging runs via `setImmediate`
- Never keeps your process alive: a script or job exits normally even while
  records are waiting to be retried
- Never throws: if setup fails, the SDK logs a `console.warn` and stays out of the way
- Leaves your client unchanged: `create()` still returns the provider SDK's own
  object, so `.withResponse()` and `.asResponse()` keep working, and streams keep
  their `.controller`, `.tee()` and `.toReadableStream()`
- 2 second timeout on every HTTP call to Sovergate
- If Sovergate is unreachable, records are queued in memory (up to 10,000) and
  retried with exponential backoff
- A record Sovergate permanently rejects (for example after a key is revoked) is
  dropped with a `console.warn`, so it never blocks the records behind it

## Current limitations

- Only the text of a response is logged, streamed or not; tool calls are not.
- The retry queue is in memory, so queued records are lost if the process exits.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
