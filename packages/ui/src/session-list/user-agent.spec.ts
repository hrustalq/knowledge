import { describe, expect, it } from 'vitest'
import { describeUserAgent } from './user-agent'

describe('describeUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox', 'macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0', 'Edge', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Chrome', 'Linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari', 'iOS'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 YaBrowser/24.10 Mobile Safari/537.36', 'Yandex Browser', 'Android'],
  ])('reads %s', (ua, browser, os) => {
    expect(describeUserAgent(ua)).toEqual({ browser, os })
  })

  it('gives up on what it does not recognise rather than guessing', () => {
    expect(describeUserAgent(null)).toBeNull()
    expect(describeUserAgent('python-requests/2.32')).toBeNull()
    expect(describeUserAgent('curl/8.7.1')).toEqual({ browser: 'curl', os: null })
  })
})
