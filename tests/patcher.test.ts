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

  test('patching twice does not log twice', async () => {
    const client = openai(jsonFetch(openAIBody))
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)
    patchOpenAI(client, enqueue)

    await client.chat.completions.create(prompt as never)
    await flush()
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  test('streams are returned untouched and not logged', async () => {
    const original = jest.fn((_opts: unknown) => 'the-stream')
    const client = { chat: { completions: { create: original } } }
    const enqueue = jest.fn()
    patchOpenAI(client, enqueue)

    const result = client.chat.completions.create({ ...prompt, stream: true } as never)
    await flush()

    expect(result).toBe('the-stream')
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
