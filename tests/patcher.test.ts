// The patched create() must behave exactly like the original for the host app.
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { patchAnthropic, patchOpenAI } from '../src/patcher'

const flush = () => new Promise(resolve => setImmediate(resolve))

const openAIBody = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o',
  choices: [
    { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Reply to jane@example.com' } },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
}

const anthropicBody = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: 'Reply to jane@example.com' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 5 },
}

function jsonFetch(body: unknown) {
  return jest.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
}

function failingFetch() {
  return jest.fn(async () =>
    new Response(JSON.stringify({ error: { message: 'bad request' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function openai(fetch: jest.Mock) {
  return new OpenAI({ apiKey: 'sk-test', baseURL: 'http://llm.test/v1', fetch, maxRetries: 0 })
}

function anthropic(fetch: jest.Mock) {
  return new Anthropic({ apiKey: 'sk-ant-test', baseURL: 'http://llm.test', fetch, maxRetries: 0 })
}

const prompt = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Email john@example.com' }] }
const claudePrompt = { ...prompt, model: 'claude-sonnet-5-5', max_tokens: 100 }

describe('OpenAI (real SDK)', () => {
  test('await returns the same data and logs a scrubbed copy once', async () => {
    const client = openai(jsonFetch(openAIBody))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const res = await client.chat.completions.create(prompt as never)
    await flush()

    expect(res.choices[0].message.content).toBe('Reply to jane@example.com')
    expect(enqueue).toHaveBeenCalledTimes(1)
    const payload = enqueue.mock.calls[0][0]
    expect(JSON.stringify(payload)).not.toContain('@example.com')
    expect(payload).toMatchObject({ model: 'gpt-4o', prompt_tokens: 12, completion_tokens: 5 })
    // john@ in the prompt and jane@ in the response: both detected, distinct placeholders
    expect(payload.pii_detections.map((d: { placeholder: string }) => d.placeholder)).toEqual([
      '[EMAIL_REDACTED_1]',
      '[EMAIL_REDACTED_2]',
    ])
  })

  test('.withResponse() still works and is logged', async () => {
    const client = openai(jsonFetch(openAIBody))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const { data, response } = await client.chat.completions.create(prompt as never).withResponse()
    await flush()

    expect(data.choices[0].message.content).toBe('Reply to jane@example.com')
    expect(response.status).toBe(200)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  test('.asResponse() still returns an unread body', async () => {
    const client = openai(jsonFetch(openAIBody))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const raw = await client.chat.completions.create(prompt as never).asResponse()
    await flush()

    expect(raw.bodyUsed).toBe(false)
    expect(((await raw.json()) as { id: string }).id).toBe('chatcmpl-1')
    expect(enqueue).not.toHaveBeenCalled()
  })

  test('API errors reach the app unchanged and nothing is logged', async () => {
    const client = openai(failingFetch())
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    await expect(client.chat.completions.create(prompt as never)).rejects.toBeInstanceOf(OpenAI.APIError)
    await flush()
    expect(enqueue).not.toHaveBeenCalled()
  })

  test('.catch() and .finally() chains are logged too', async () => {
    const client = openai(jsonFetch(openAIBody))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const res = await client.chat.completions.create(prompt as never).catch(() => null).finally(() => undefined)
    await flush()

    expect(res?.id).toBe('chatcmpl-1')
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  test('patching twice does not log twice', async () => {
    const client = openai(jsonFetch(openAIBody))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)
    patchOpenAI(client, enqueue)

    await client.chat.completions.create(prompt as never)
    await flush()
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})

/** A fetch mock answering with server-sent events: [event name or null, data]. */
function sseFetch(events: [string | null, unknown][]) {
  const body = events
    .map(([name, data]) => (name ? `event: ${name}\n` : '') + `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('')
  return jest.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
}

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, usage: unknown = null) => ({
  id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o',
  choices: [{ index: 0, delta, finish_reason }], usage,
})

const openAIStream: [string | null, unknown][] = [
  [null, chunk({ role: 'assistant', content: 'Reply to ' })],
  [null, chunk({ content: 'jane@example.com' })],
  [null, chunk({}, 'stop')],
  // Only sent with stream_options: { include_usage: true }
  [null, { ...chunk({}), choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }],
  [null, '[DONE]'],
]

function expectScrubbed(payload: Record<string, unknown>) {
  expect(JSON.stringify(payload)).not.toContain('@example.com')
  expect(payload).toMatchObject({ prompt_tokens: 12, completion_tokens: 5, response: 'Reply to [EMAIL_REDACTED_2]' })
}

describe('OpenAI streaming (real SDK)', () => {
  test('every chunk reaches the app unchanged, and the call is logged once the stream ends', async () => {
    const client = openai(sseFetch(openAIStream))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const stream = await client.chat.completions.create({ ...prompt, stream: true, stream_options: { include_usage: true } } as never)
    let text = ''
    for await (const c of stream as unknown as AsyncIterable<{ choices: { delta: { content?: string } }[] }>) {
      text += c.choices[0]?.delta.content ?? ''
      expect(enqueue).not.toHaveBeenCalled() // nothing is logged while the app is still reading
    }
    await flush()

    expect(text).toBe('Reply to jane@example.com')
    expect(stream).toHaveProperty('controller') // still the SDK's own Stream object
    expect(enqueue).toHaveBeenCalledTimes(1)
    expectScrubbed(enqueue.mock.calls[0][0])
    expect(enqueue.mock.calls[0][0].finish_reason).toBe('stop')
  })

  test('without include_usage it is logged with 0 tokens', async () => {
    const client = openai(sseFetch([...openAIStream.slice(0, 3), [null, '[DONE]']]))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const stream = await client.chat.completions.create({ ...prompt, stream: true } as never)
    for await (const _ of stream as unknown as AsyncIterable<unknown>) void _
    await flush()

    expect(enqueue.mock.calls[0][0]).toMatchObject({ prompt_tokens: 0, completion_tokens: 0, response: 'Reply to [EMAIL_REDACTED_2]' })
  })

  test('breaking out early logs what the app had received', async () => {
    const client = openai(sseFetch(openAIStream))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const stream = await client.chat.completions.create({ ...prompt, stream: true } as never)
    for await (const _ of stream as unknown as AsyncIterable<unknown>) {
      void _
      break
    }
    await flush()

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][0]).toMatchObject({ response: 'Reply to ', finish_reason: null })
  })

  test('the .stream() helper is logged', async () => {
    const client = openai(sseFetch(openAIStream))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const final = await client.chat.completions.stream({ ...prompt, stream_options: { include_usage: true } } as never).finalChatCompletion()
    await flush()

    expect(final.choices[0].message.content).toBe('Reply to jane@example.com')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expectScrubbed(enqueue.mock.calls[0][0])
  })

  test('.toReadableStream() still works and is logged', async () => {
    const client = openai(sseFetch(openAIStream))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const stream = await client.chat.completions.create({ ...prompt, stream: true } as never)
    const reader = (stream as unknown as { toReadableStream(): ReadableStream }).toReadableStream().getReader()
    while (!(await reader.read()).done) {
      // read it all, as a browser client would
    }
    await flush()

    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  test('a stream that is never read is not logged', async () => {
    const client = openai(sseFetch(openAIStream))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const stream = await client.chat.completions.create({ ...prompt, stream: true } as never)
    ;(stream as unknown as { controller: AbortController }).controller.abort()
    await flush()

    expect(enqueue).not.toHaveBeenCalled()
  })

  test('a non-stream result for stream: true is returned untouched', async () => {
    const original = jest.fn((_opts: unknown) => 'the-stream')
    const client = { chat: { completions: { create: original } } }
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    expect(client.chat.completions.create({ ...prompt, stream: true } as never)).toBe('the-stream')
    await flush()
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('Anthropic (real SDK)', () => {
  test('await returns the same data and logs a scrubbed copy once', async () => {
    const client = anthropic(jsonFetch(anthropicBody))
    const enqueue = jest.fn()
    patchAnthropic(client, enqueue)

    const res = await client.messages.create(claudePrompt as never)
    await flush()

    expect(res.content[0]).toMatchObject({ type: 'text', text: 'Reply to jane@example.com' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const payload = enqueue.mock.calls[0][0]
    expect(JSON.stringify(payload)).not.toContain('@example.com')
    expect(payload).toMatchObject({ prompt_tokens: 12, completion_tokens: 5, finish_reason: 'end_turn' })
  })

  test('.withResponse() and .asResponse() still work', async () => {
    const client = anthropic(jsonFetch(anthropicBody))
    const enqueue = jest.fn()
    patchAnthropic(client, enqueue)

    const { data } = await client.messages.create(claudePrompt as never).withResponse()
    const raw = await client.messages.create(claudePrompt as never).asResponse()
    await flush()

    expect(data.id).toBe('msg_1')
    expect(raw.bodyUsed).toBe(false)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})

const anthropicStream: [string | null, unknown][] = [
  ['message_start', { type: 'message_start', message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply to ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'jane@example.com' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }],
]

describe('Anthropic streaming (real SDK)', () => {
  test('create({ stream: true }) is logged once the stream ends', async () => {
    const client = anthropic(sseFetch(anthropicStream))
    const enqueue = jest.fn()
    patchAnthropic(client, enqueue)

    const stream = await client.messages.create({ ...claudePrompt, stream: true } as never)
    const types: string[] = []
    for await (const event of stream as unknown as AsyncIterable<{ type: string }>) types.push(event.type)
    await flush()

    expect(types.at(-1)).toBe('message_stop')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expectScrubbed(enqueue.mock.calls[0][0])
    expect(enqueue.mock.calls[0][0].finish_reason).toBe('end_turn')
  })

  test('the .stream() helper is logged', async () => {
    const client = anthropic(sseFetch(anthropicStream))
    const enqueue = jest.fn()
    patchAnthropic(client, enqueue)

    const final = await client.messages.stream(claudePrompt as never).finalMessage()
    await flush()

    expect(final.content[0]).toMatchObject({ type: 'text', text: 'Reply to jane@example.com' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expectScrubbed(enqueue.mock.calls[0][0])
  })
})
