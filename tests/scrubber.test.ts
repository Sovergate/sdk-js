import { scrub } from '../src/scrubber'

test('phone with country code is fully scrubbed', () => {
  expect(scrub('Call +49 151 23456789 today').text).toBe('Call [PHONE_REDACTED_1] today')
})

test('email is scrubbed', () => {
  expect(scrub('Mail jane@example.com').text).toBe('Mail [EMAIL_REDACTED_1]')
})
