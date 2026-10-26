// init() / instrument() must never throw into the host application.
import { init, instrument, shutdown } from '../src/index'

describe('never throws into the host app', () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    shutdown()
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    shutdown()
    warn.mockRestore()
  })

  test('instrument() before init() warns and leaves the client untouched', () => {
    const create = jest.fn()
    const client = { chat: { completions: { create } } }

    expect(() => instrument(client)).not.toThrow()
    expect(client.chat.completions.create).toBe(create)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('before init'))
  })

  test('unsupported client warns instead of throwing', () => {
    init({ apiKey: 'sov_test_x', baseUrl: 'http://127.0.0.1:9' })

    expect(() => instrument({})).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported client'))
  })

  test('broken client warns instead of throwing', () => {
    init({ apiKey: 'sov_test_x', baseUrl: 'http://127.0.0.1:9' })
    const broken = { chat: { completions: {} } } // no create()

    expect(() => instrument(broken)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('instrument() failed'),
      expect.anything(),
    )
  })

  test('init() with bad arguments does not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => init({ apiKey: 'sov_test_x', baseUrl: 42 as any })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('init failed'),
      expect.anything(),
    )
  })
})
