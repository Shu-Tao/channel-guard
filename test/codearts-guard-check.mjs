/**
 * codearts 守卫的验证：签名重算是核心，必须用真实请求验证。
 *
 * 用法：
 *   node test/codearts-guard-check.mjs          # 纯逻辑
 *   node test/codearts-guard-check.mjs --live   # 含真实请求（消耗少量额度）
 */
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import {
  guardUserAgent, isCodeartsUrl, parseAuthorization, signV11, guardCodeartsRequest,
} from '../lib/codearts-guard.js'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('=== 1. UA 改写 ===')
for (const [input, want, label] of [
  ['deepseek-harness/44.7.0 (+https://x)', 'deepseek-harness_v44.7.0 (+https://x)', '标准'],
  ['deepseek-harness/44.7.0', 'deepseek-harness_v44.7.0', '最短'],
  ['deepseek-harness', 'deepseek-harness', '无版本不改'],
  ['curl/8.4.0', 'curl/8.4.0', '无关不改'],
  ['', '', '空串'],
]) {
  const got = guardUserAgent(input)
  check(label, got === want, `got "${got}"`)
}
check('null 安全', guardUserAgent(null) === null)
check('幂等', guardUserAgent(guardUserAgent('deepseek-harness/1.0')) === 'deepseek-harness_v1.0')

console.log('\n=== 2. URL 识别 ===')
check('codearts 识别', isCodeartsUrl('https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions'))
check('其他域名排除', isCodeartsUrl('https://copilot.tencent.com/v2/chat/completions') === false)

console.log('\n=== 3. Authorization 解析 ===')
{
  const auth = 'SDK-HMAC-SHA256 Access=HSTA3Sxxx, SignedHeaders=content-type;host;maas_type;x-sdk-date, Signature=abc123'
  const p = parseAuthorization(auth)
  check('解出 Access', p?.access === 'HSTA3Sxxx')
  check('解出 SignedHeaders', Array.isArray(p?.signedHeaders) && p.signedHeaders.includes('maas_type'))
  check('非法输入返回 null', parseAuthorization('garbage') === null)
  check('null 安全', parseAuthorization(null) === null)
}

console.log('\n=== 4. 签名算法自洽性 ===')
{
  // 用固定输入手算，验证 signV11 的规范化形式与 pack.js 一致
  const url = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions'
  const h = new Headers({
    host: 'snap-access.cn-north-4.myhuaweicloud.com',
    'x-sdk-date': '20260101T000000Z',
    'x-sdk-content-sha256': 'payloadhash',
    'x-security-token': 'st',
    'content-type': 'application/json',
  })
  const sig = signV11({
    sk: 'testsk', access: 'HSTA123', method: 'POST', url, headers: h,
    dateStamp: '20260101T000000Z', payloadHash: 'payloadhash',
  })
  check('返回带 SDK-HMAC-SHA256 前缀', sig.startsWith('SDK-HMAC-SHA256 Access=HSTA123'))
  check('SignedHeaders 不含 user-agent', !sig.includes('user-agent'))

  // 同样的输入应得到同样的签名（确定性）
  const sig2 = signV11({
    sk: 'testsk', access: 'HSTA123', method: 'POST', url, headers: h,
    dateStamp: '20260101T000000Z', payloadHash: 'payloadhash',
  })
  check('签名确定性', sig === sig2)

  // 换 sk 必须变
  const sig3 = signV11({
    sk: 'othersk', access: 'HSTA123', method: 'POST', url, headers: h,
    dateStamp: '20260101T000000Z', payloadHash: 'payloadhash',
  })
  check('换 sk 签名必变', sig !== sig3)
}

// ── 可选真实请求 ────────────────────────────────────────────────────────────
if (process.argv.includes('--live')) {
  console.log('\n=== 5. 真实请求：模拟带 benefit 的完整链路 ===')

  const raw = readFileSync('C:/Users/25759/.dsh/.credentials.yaml', 'utf8')
  const seg = raw.slice(raw.indexOf('CODEARTS_ACCOUNT_'))
  const g = (k) => { const m = new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`).exec(seg); return m ? m[1] : '' }
  const ak = g('access_key_id'), sk = g('secret_access_key'), st = g('security_token')

  // 伪造一个「能按 access 查到 sk」的凭据服务，模拟 ctx.credentials
  const fakeCredentials = {
    async resolve(ref) {
      const name = typeof ref === 'string' ? ref : ref?.ref ?? ''
      if (!String(name).startsWith('CODEARTS_ACCOUNT_')) return undefined
      return {
        value: JSON.stringify({ access_key_id: ak, secret_access_key: sk, security_token: st }),
        source: 'test',
      }
    },
  }

  const url = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions'
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8, stream: false,
  })

  /** 构造一个「已签好但带 benefit」的请求，模拟 pack.js 的行为。 */
  function buildSignedWithBenefit() {
    const u = new URL(url)
    let uri = u.pathname
    if (!uri.endsWith('/')) uri += '/'
    const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const payloadHash = createHash('sha256').update(Buffer.from(body)).digest('hex')
    const h = new Map([
      ['host', u.host], ['x-sdk-date', dateStamp],
      ['x-sdk-content-sha256', payloadHash], ['x-security-token', st],
      ['maas_type', 'benefit'], ['content-type', 'application/json'],
    ])
    const names = [...h.keys()].sort()
    const ch = names.map(k => `${k}:${String(h.get(k)).trim()}`).join('\n') + '\n'
    const cr = ['POST', uri, '', ch, names.join(';'), payloadHash].join('\n')
    const sts = ['SDK-HMAC-SHA256', dateStamp, createHash('sha256').update(cr).digest('hex')].join('\n')
    h.set('authorization', `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', sk).update(sts).digest('hex')}`)
    h.set('user-agent', 'deepseek-harness/44.7.0')
    return Object.fromEntries(h)
  }

  const headers = buildSignedWithBenefit()
  console.log('  原始请求带: maas_type=benefit, UA=deepseek-harness/44.7.0')
  console.log('  预期（不经守卫）: 403 或 404')

  // 先验证未经守卫的原始请求确实失败
  const beforeRes = await fetch(url, { method: 'POST', headers, body })
  const beforeText = await beforeRes.text()
  console.log(`  未经守卫: ${beforeRes.status} ${beforeText.slice(0, 80).replace(/[\u0000-\u001f]/g, ' ')}`)
  check('未经守卫的请求被拒（证明问题存在）', beforeRes.status !== 200, `status=${beforeRes.status}`)

  // 再经守卫
  const res = await guardCodeartsRequest({
    baseFetch: fetch, input: url,
    init: { method: 'POST', headers, body },
    credentials: fakeCredentials, debug: true,
    logger: { info: (m) => console.log('    [guard]', m) },
  })
  const text = await res.text()
  console.log(`  经守卫后:   ${res.status} ${text.slice(0, 100).replace(/[\u0000-\u001f]/g, ' ')}`)
  check('经守卫后返回 200', res.status === 200, `status=${res.status}`)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
