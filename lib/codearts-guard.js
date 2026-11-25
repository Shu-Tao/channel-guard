/**
 * 第 2 层：codearts 请求修正（含签名重算）。
 *
 * ── 为什么不能只删 header ──────────────────────────────────────────────────
 *
 * 华为云 SIG-V11 签名覆盖 `SignedHeaders` 里列出的每个 header，而
 * `maas_type` 是通过 extraHeaders 进入签名的：
 *
 *   headers.set("maas_type", "benefit")        // pack.js signRequestHuawei
 *   signedHeaders = [...headers.keys()].sort() // → 包含 maas_type
 *   canonicalRequest = ... headerLines ... signedHeaders.join(';') ...
 *
 * 实测（2026-11-25）：只删 header 不重签 → 401
 *   "Incorrect IAM authentication information: verify ak sk signature fail"
 *
 * 所以必须重算 Authorization。重算需要 sk，通过 `ctx.credentials.resolve()`
 * 读取——这是 DSH 的公开凭据接口，不是读文件。
 *
 * ── 实测矩阵（同一账号同一模型）────────────────────────────────────────────
 *
 *   无 benefit + 原 UA                     → 403 TM.00000001
 *   无 benefit + 改写后 UA                  → 200
 *   有 benefit + 改写后 UA                  → 404 APIG.0101
 *   有 benefit + 无 UA                      → 404 APIG.0101
 *
 * 结论：
 *   - user-agent 不参与签名，可以改（斜杠换下划线）
 *   - maas_type 参与签名，改就必须重签
 *
 * @module lib/codearts-guard.js
 */

import { createHash, createHmac } from 'node:crypto'

const CODEARTS_HOST = 'snap-access.cn-north-4.myhuaweicloud.com'

/** 凭据记录前缀，账号池按 CODEARTS_ACCOUNT_<ID> 存。 */
const CREDENTIAL_PREFIX = 'CODEARTS_ACCOUNT_'

/** AK 前缀特征，用来从凭据池里认出 codearts 账号。 */
const AK_PREFIX = 'HSTA'

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

/**
 * 改写 UA：`deepseek-harness/<版本>` → `deepseek-harness_v<版本>`。
 *
 * 判据是斜杠句式这个**子串**；改空白无效（上游 trim），必须改句式。
 *
 * @param {string} value
 * @returns {string}
 */
export function guardUserAgent(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  return value.replace(/(deepseek-harness)\/(\d[\w.\-]*)/gi, '$1_v$2')
}

/** @param {string} urlLike */
export function isCodeartsUrl(urlLike) {
  try {
    return new URL(String(urlLike)).hostname === CODEARTS_HOST
  } catch {
    return false
  }
}

/**
 * 从 Authorization 头里解出 Access 与 SignedHeaders。
 * @param {string} authorization
 * @returns {{access: string, signedHeaders: string[]}|null}
 */
export function parseAuthorization(authorization) {
  if (typeof authorization !== 'string') return null
  const access = /Access=([^,\s]+)/.exec(authorization)
  const signed = /SignedHeaders=([^,\s]+)/.exec(authorization)
  if (access === null || signed === null) return null
  return { access: access[1], signedHeaders: signed[1].split(';') }
}

/**
 * 重算 SIG-V11 签名。
 *
 * 严格复刻 pack.js 的 buildCanonicalRequest + signRequestHuawei：
 *   canonical = METHOD \n uri \n query \n headerLines \n "" \n signedHeaders \n payloadHash
 *   stringToSign = SDK-HMAC-SHA256 \n dateStamp \n sha256(canonical)
 *   signature = HMAC-SHA256(sk, stringToSign)
 *
 * @param {object} p
 * @param {string} p.sk
 * @param {string} p.access
 * @param {string} p.method
 * @param {string} p.url
 * @param {Headers} p.headers - 已剔除 maas_type、已改写 UA 的最终 header
 * @param {string} p.dateStamp
 * @param {string} p.payloadHash
 * @returns {string} 完整 Authorization 值
 */
export function signV11({ sk, access, method, url, headers, dateStamp, payloadHash }) {
  const u = new URL(url)
  let uri = u.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = u.search.slice(1)

  // 参与签名的 header：沿用上游的做法，按名字排序，值为 trim 后原样
  const names = []
  headers.forEach((_, key) => {
    if (key.toLowerCase() === 'authorization') return
    if (key.toLowerCase() === 'user-agent') return // UA 不参与签名
    names.push(key)
  })
  names.sort()

  const headerLines = names.map((k) => `${k}:${String(headers.get(k) ?? '').trim()}`)
  const canonicalRequest = [
    method.toUpperCase(),
    uri,
    query,
    headerLines.join('\n'),
    '',
    names.join(';'),
    payloadHash,
  ].join('\n')

  const stringToSign = [
    'SDK-HMAC-SHA256',
    dateStamp,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signature = createHmac('sha256', sk).update(stringToSign).digest('hex')
  return `SDK-HMAC-SHA256 Access=${access},SignedHeaders=${names.join(';')},Signature=${signature}`
}

/**
 * 从凭据服务里找出能匹配该 Access Key 的 codearts secret。
 *
 * 账号池把凭据存在 `CODEARTS_ACCOUNT_<ID>` 记录里，值是 JSON 字符串。
 * 我们按 access_key_id 反查，而不是猜记录名 —— 账号数量与 ID 都会变。
 *
 * @param {object} credentials - ctx.credentials
 * @param {string} access - Authorization 里的 Access（即 access_key_id）
 * @returns {Promise<string|null>} secret_access_key，找不到返回 null
 */
export async function findSecretByAccess(credentials, access) {
  if (credentials === undefined || credentials === null) return null
  if (typeof access !== 'string' || !access.startsWith(AK_PREFIX)) return null

  // 1) 先试账号池里已知的记录名：从 state.json 读比枚举凭据库更轻
  const candidates = await listCodeartsRefs()
  for (const ref of candidates) {
    const hit = await resolveRecord(credentials, ref)
    if (hit !== null && hit.access_key_id === access) return hit.secret_access_key
  }
  return null
}

/**
 * 列出 codearts 账号的凭据引用。
 * @returns {Promise<string[]>}
 */
async function listCodeartsRefs() {
  try {
    const { readFileSync } = await import('node:fs')
    const home = String(process.env.DSH_HOME ?? '').trim() || null
    if (home === null) return []
    const raw = readFileSync(`${home}/channel-pack/state.json`, 'utf8')
    const state = JSON.parse(raw)
    return (Array.isArray(state.accounts) ? state.accounts : [])
      .filter((a) => a?.provider === 'codearts' && typeof a?.credentialRef === 'string')
      .map((a) => a.credentialRef)
  } catch {
    return []
  }
}

/**
 * 解析一条凭据记录，容错三种返回形态。
 * @param {object} credentials
 * @param {string} ref
 * @returns {Promise<object|null>}
 */
async function resolveRecord(credentials, ref) {
  try {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials').catch(() => ({}))
    const key = typeof credentialRef === 'function' ? credentialRef(ref) : ref
    const hit = await credentials.resolve(key)
    const value = hit?.value
    if (typeof value === 'string' && value.length > 0) {
      try { return JSON.parse(value) } catch { return null }
    }
    if (value !== null && typeof value === 'object') return value
    return null
  } catch {
    return null
  }
}

/**
 * 修正一次 codearts 请求：改 UA、去 benefit 头、必要时重签。
 *
 * @param {object} p
 * @param {typeof fetch} p.baseFetch
 * @param {any} p.input
 * @param {any} p.init
 * @param {object} [p.credentials] - ctx.credentials，用于取 sk 重签
 * @param {object} [p.logger]
 * @param {boolean} [p.debug]
 * @returns {Promise<Response>}
 */
export async function guardCodeartsRequest({ baseFetch, input, init, credentials, logger, debug }) {
  const url = input instanceof Request ? input.url : String(input)

  // ── 取出 method / headers / body ────────────────────────────────────────
  const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

  let headers
  try {
    headers = new Headers(input instanceof Request ? input.headers : undefined)
    const initHeaders = init?.headers
    if (initHeaders !== undefined) {
      new Headers(initHeaders).forEach((v, k) => headers.set(k, v))
    }
  } catch {
    return baseFetch(input, init)
  }

  const changes = []

  // ── 1. UA 改写（不参与签名，安全）──────────────────────────────────────
  const ua = headers.get('user-agent')
  if (typeof ua === 'string') {
    const guarded = guardUserAgent(ua)
    if (guarded !== ua) {
      headers.set('user-agent', guarded)
      changes.push('user-agent')
    }
  }

  // ── 2. maas_type：要删就必须重签 ───────────────────────────────────────
  const hasBenefit = headers.has('maas_type')
  if (hasBenefit) {
    const authorization = headers.get('authorization')
    const parsed = parseAuthorization(authorization)
    const payloadHash = headers.get('x-sdk-content-sha256')
    const dateStamp = headers.get('x-sdk-date')

    if (parsed !== null && typeof payloadHash === 'string' && typeof dateStamp === 'string') {
      const secret = await findSecretByAccess(credentials, parsed.access)
      if (secret !== null) {
        headers.delete('maas_type')
        // 重签前用最终 header 集合计算
        const resigned = signV11({
          sk: secret,
          access: parsed.access,
          method,
          url,
          headers,
          dateStamp,
          payloadHash,
        })
        headers.set('authorization', resigned)
        changes.push('maas_type+resign')
        if (debug === true) logger?.info?.('channel-guard: dropped maas_type and re-signed')
      } else {
        // 拿不到 sk 就不动 —— 删了只会 401，比 404 更难排查
        if (debug === true) logger?.info?.('channel-guard: cannot resolve sk; leaving maas_type intact')
      }
    }
  }

  if (changes.length === 0) return baseFetch(input, init)

  // ── 3. 重建请求 ────────────────────────────────────────────────────────
  if (input instanceof Request) {
    try {
      return baseFetch(new Request(input, { headers }), init)
    } catch {
      return baseFetch(input, init)
    }
  }
  return baseFetch(input, { ...init, headers })
}
