import { ScrubContext, scrub, scrubMessages } from '../src/scrubber'

test('phone with country code is fully scrubbed', () => {
  expect(scrub('Call +49 151 23456789 today').text).toBe('Call [PHONE_REDACTED_1] today')
})

test('email is scrubbed', () => {
  expect(scrub('Mail jane@example.com').text).toBe('Mail [EMAIL_REDACTED_1]')
})

test('placeholders are numbered across a whole record', () => {
  const context = new ScrubContext()
  const [messages] = scrubMessages(
    [
      { role: 'user', content: 'Mail anna@example.com' },
      { role: 'user', content: 'and ben@example.com, cc anna@example.com' },
    ],
    context,
  )
  const response = scrub('Sent to ben@example.com', context)

  expect(messages[0].content).toBe('Mail [EMAIL_REDACTED_1]')
  expect(messages[1].content).toBe('and [EMAIL_REDACTED_2], cc [EMAIL_REDACTED_1]')
  expect(response.text).toBe('Sent to [EMAIL_REDACTED_2]')
})

// Produced by the Python SDK's scrubber with the same key. Both SDKs must give the
// same token for the same value, so a customer's Python and Node services agree.
const PII_KEY = 'customer-secret-key'
const PYTHON_VECTORS: Array<[input: string, keyed: string, positional: string]> = [
  ['Contact jane.doe@example.com today', 'Contact [EMAIL_REDACTED_4c0cd879eb65] today', 'Contact [EMAIL_REDACTED_1] today'],
  ['Contact JANE.DOE@example.com today', 'Contact [EMAIL_REDACTED_4c0cd879eb65] today', 'Contact [EMAIL_REDACTED_1] today'],
  ['IBAN DE89 3704 0044 0532 0130 00 please', 'IBAN [IBAN_REDACTED_3afcd958458e] please', 'IBAN [IBAN_REDACTED_1] please'],
  ['IBAN DE89370400440532013000 please', 'IBAN [IBAN_REDACTED_3afcd958458e] please', 'IBAN [IBAN_REDACTED_1] please'],
  ['Card 4111 1111 1111 1111 expires', 'Card [CARD_REDACTED_dfd46a6da5b0] expires', 'Card [CARD_REDACTED_1] expires'],
  ['Call +49 89 1234567 now', 'Call [PHONE_REDACTED_14e2f7f972c3] now', 'Call [PHONE_REDACTED_1] now'],
  ['Server 192.168.1.10 is down', 'Server [IP_REDACTED_bf6765e225e9] is down', 'Server [IP_REDACTED_1] is down'],
  ['Born 12/05/1984, ID AB1234567', 'Born [DOB_REDACTED_ac2d7c6d7fc2], ID [ID_REDACTED_0be40f7f0e29]', 'Born [DOB_REDACTED_1], ID [ID_REDACTED_1]'],
  ['Ask Dr. Anna Weber about Mr Smith', 'Ask [NAME_REDACTED_a7e1479adcd6] about [NAME_REDACTED_3056743b1444]', 'Ask [NAME_REDACTED_1] about [NAME_REDACTED_2]'],
  ['Héllo ümlaut@exämple.de and user@example.com', 'Héllo ümlaut@exämple.de and [EMAIL_REDACTED_16561e652aea]', 'Héllo ümlaut@exämple.de and [EMAIL_REDACTED_1]'],
]

describe('same output as the Python SDK', () => {
  test.each(PYTHON_VECTORS)('%s', (input, keyed, positional) => {
    expect(scrub(input, new ScrubContext(PII_KEY)).text).toBe(keyed)
    expect(scrub(input).text).toBe(positional)
  })
})

describe('stable PII tokens (piiKey)', () => {
  test('the same value gets the same token in different records', () => {
    const a = scrub('Mail jane@example.com', new ScrubContext(PII_KEY)).text
    const b = scrub('Again: jane@example.com', new ScrubContext(PII_KEY)).text
    expect(a.match(/\[EMAIL_REDACTED_\w+\]/)?.[0]).toBe(b.match(/\[EMAIL_REDACTED_\w+\]/)?.[0])
  })

  test('a different key gives a different token', () => {
    const a = scrub('jane@example.com', new ScrubContext(PII_KEY)).text
    const b = scrub('jane@example.com', new ScrubContext('another-key')).text
    expect(a).not.toBe(b)
  })

  test('the token never contains the value', () => {
    const { text, detections } = scrub('jane@example.com', new ScrubContext(PII_KEY))
    expect(text).not.toContain('jane')
    expect(detections).toEqual([{ category: 'email', placeholder: text }])
  })

  test('a spaced IBAN or card number is caught whole, not as a phone number', () => {
    const { detections } = scrub('DE89 3704 0044 0532 0130 00 and 4111 1111 1111 1111')
    expect(detections.map(d => d.category)).toEqual(['iban', 'id_number'])
  })
})
