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
