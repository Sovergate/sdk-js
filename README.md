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

## Options

```typescript
init({
  apiKey: 'sov_prod_xxxx',     // required
  baseUrl: 'https://...',      // default: https://api.sovergate.com
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
- Never throws: if setup fails, the SDK logs a `console.warn` and stays out of the way
- Leaves your client unchanged: `create()` still returns the provider SDK's own
  object, so `.withResponse()` and `.asResponse()` keep working
- 2 second timeout on every HTTP call to Sovergate
- If Sovergate is unreachable, records are queued in memory (up to 10,000) and
  retried with exponential backoff

## Current limitations

- Streaming calls (`stream: true`) are passed through untouched but not logged yet.
- PII placeholders are positional (`[EMAIL_REDACTED_1]`) and not correlatable across logs.
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
