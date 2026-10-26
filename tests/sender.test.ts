// The sender must tell temporary failures (retry) from permanent rejections (drop).
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { LogQueue } from '../src/queue'
import { send } from '../src/sender'

function serverReturning(status: number): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.statusCode = status
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

describe('send()', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  test.each([
    [200, 'sent'],
    [400, 'drop'], // invalid record: retrying can never succeed
    [401, 'drop'], // unknown or revoked key
    [413, 'drop'], // record too large
    [429, 'retry'], // rate limited: temporary
    [503, 'retry'], // server unavailable: temporary
  ])('HTTP %i → %s', async (status, expected) => {
    const { server, url } = await serverReturning(status)
    try {
      expect(await send('sov_test_key', {}, url)).toBe(expected)
    } finally {
      server.close()
    }
  })

  test('unreachable server → retry', async () => {
    expect(await send('sov_test_key', {}, 'http://127.0.0.1:9')).toBe('retry')
  })
})

test('a dropped record does not block the next one', async () => {
  const attempts: number[] = []
  const queue = new LogQueue(async payload => {
    attempts.push(payload.n as number)
    return payload.n === 1 ? 'drop' : 'sent'
  })

  queue.enqueue({ n: 1 })
  queue.enqueue({ n: 2 })
  await new Promise(resolve => setTimeout(resolve, 100)) // well under the 1s retry delay

  expect(attempts).toEqual([1, 2])
})
