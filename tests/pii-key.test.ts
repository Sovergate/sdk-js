// init({ piiKey }) must reach every record of the clients instrumented afterwards.
import { init, instrument, shutdown } from '../src/index'
import { send } from '../src/sender'

jest.mock('../src/sender', () => ({ send: jest.fn(async () => 'sent') }))

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

function fakeOpenAI() {
  return {
    chat: {
      completions: {
        create: jest.fn(async (_opts: unknown) => ({ model: 'gpt-4o', choices: [{ message: { content: 'ok' } }] })),
      },
    },
  }
}

const call = (client: ReturnType<typeof fakeOpenAI>) =>
  client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Contact jane.doe@example.com today' }] })

afterEach(() => {
  shutdown()
  jest.mocked(send).mockClear()
})

test('with a piiKey, records carry the same token the Python SDK gives', async () => {
  init({ apiKey: 'sov_test_x', piiKey: 'customer-secret-key' })
  const client = fakeOpenAI()
  instrument(client)

  await call(client)
  await settle()

  const payload = jest.mocked(send).mock.calls[0][1] as { messages: { content: string }[] }
  expect(payload.messages[0].content).toBe('Contact [EMAIL_REDACTED_4c0cd879eb65] today')
})

test('without a piiKey, placeholders are numbered', async () => {
  init({ apiKey: 'sov_test_x' })
  const client = fakeOpenAI()
  instrument(client)

  await call(client)
  await settle()

  const payload = jest.mocked(send).mock.calls[0][1] as { messages: { content: string }[] }
  expect(payload.messages[0].content).toBe('Contact [EMAIL_REDACTED_1] today')
})
