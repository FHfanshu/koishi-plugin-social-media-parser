const assert = require('node:assert/strict')

const { toCanonicalXiaohongshuUrl } = require('../lib/parsers/xiaohongshu.js')
const { detectPlatformByUrl, normalizeInputUrl } = require('../lib/utils/url.js')

const cnShortUrl = 'http://xhslink.cn/o/9qwUCkbIw7c'
assert.equal(detectPlatformByUrl(cnShortUrl), 'xiaohongshu')
assert.equal(normalizeInputUrl(cnShortUrl), cnShortUrl)

const redirectTarget = new URL('http://www.xiaohongshu.com/explore')
redirectTarget.searchParams.set('target_note_id', '6a606235000000001102ea9f')
redirectTarget.searchParams.set('xsec_token', 'captcha-token=')
const captchaUrl = new URL('https://www.xiaohongshu.com/website-login/captcha')
captchaUrl.searchParams.set('redirectPath', redirectTarget.toString())

assert.equal(
  toCanonicalXiaohongshuUrl(captchaUrl.toString()),
  'https://www.xiaohongshu.com/discovery/item/6a606235000000001102ea9f?xsec_token=captcha-token%3D&xsec_source=pc_user'
)

console.log('xiaohongshu regression checks passed')
