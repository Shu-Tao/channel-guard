/**
 * 第 2 层的宿主接线：把 codearts 修正挂到 fetch 层。
 *
 * 为什么是 fetch 层而不是注册 adapter —— 见 lib/codearts-guard.js 的说明：
 * DSH 的 prepareRoutes 对已注册的 provider 直接抛 DUPLICATE_ADAPTER，
 * 而 codearts 已被 our-free-model 占用。`this.adapters` 是私有 Map，
 * 没有公开替换入口。
 *
 * 可行的落点是 createChannelFetch 的底层：
 *   (options.fetchImpl ?? globalThis.fetch)(input, init)
 * 所有渠道 adapter 共用它，所以包装 globalThis.fetch 能拦到全部出网请求。
 *
 * @module lib/fetch-apply.js
 */

import { guardCodeartsRequest, isCodeartsUrl } from './codearts-guard.js'

/**
 * 包装一个 fetch 函数。
 *
 * 幂等：同一函数重复包装时复用，避免热重载套娃。
 *
 * @param {typeof fetch} baseFetch
 * @param {{credentials?: () => object|undefined, logger?: object, debug?: boolean}} options
 * @returns {{fetch: typeof fetch, stats: () => object}}
 */
export function wrapFetchForCodearts(baseFetch, options = {}) {
  if (typeof baseFetch !== 'function') throw new TypeError('wrapFetchForCodearts requires a fetch')

  if (baseFetch.__channelGuardCodearts === true) {
    return { fetch: baseFetch, stats: baseFetch.__channelGuardCodeartsStats ?? (() => ({})) }
  }

  const counters = {
    total: 0,
    codearts: 0,
    userAgentFixed: 0,
    benefitDropped: 0,
    errors: 0,
  }

  const wrapped = async function channelGuardFetch(input, init) {
    counters.total += 1

    let url
    try {
      url = input instanceof Request ? input.url : String(input)
    } catch {
      return baseFetch(input, init)
    }

    if (!isCodeartsUrl(url)) return baseFetch(input, init)
    counters.codearts += 1

    let credentials
    try {
      credentials = typeof options.credentials === 'function' ? options.credentials() : options.credentials
    } catch {
      credentials = undefined
    }

    try {
      const before = snapshotHeaders(input, init)
      const response = await guardCodeartsRequest({
        baseFetch, input, init, credentials,
        logger: options.logger,
        debug: options.debug === true,
      })
      const after = snapshotHeaders(input, init)
      // 比对统计（guard 内部不返回 changes，这里按 header 差异记账）
      if (before.userAgent !== after.userAgent) counters.userAgentFixed += 1
      if (before.benefit || /resign/i.test(String(before.note))) counters.benefitDropped += 1
      return response
    } catch (error) {
      counters.errors += 1
      // 守卫自身出错时退回原请求 —— 宁可让上游拒，也不能让请求发不出去
      options.logger?.warn?.(`channel-guard: codearts guard failed, falling back: ${String(error)}`)
      return baseFetch(input, init)
    }
  }

  Object.defineProperty(wrapped, '__channelGuardCodearts', { value: true })
  const stats = () => ({ ...counters })
  Object.defineProperty(wrapped, '__channelGuardCodeartsStats', { value: stats })

  return { fetch: wrapped, stats }
}

/** 读取请求的 header 快照，用于记账。 */
function snapshotHeaders(input, init) {
  try {
    const h = new Headers(input instanceof Request ? input.headers : undefined)
    const initHeaders = init?.headers
    if (initHeaders !== undefined) new Headers(initHeaders).forEach((v, k) => h.set(k, v))
    return {
      userAgent: h.get('user-agent'),
      benefit: h.has('maas_type'),
      note: h.has('maas_type') ? 'benefit' : '',
    }
  } catch {
    return { userAgent: null, benefit: false, note: '' }
  }
}

/**
 * 安装 codearts fetch 守卫。
 *
 * @param {{credentials?: () => object|undefined, logger?: object, debug?: boolean}} options
 * @returns {{uninstall: () => void, stats: () => object}}
 */
export function installCodeartsGuard(options = {}) {
  const original = globalThis.fetch
  if (typeof original !== 'function') throw new Error('globalThis.fetch is unavailable')

  const { fetch: wrapped, stats } = wrapFetchForCodearts(original, options)
  globalThis.fetch = wrapped

  options.logger?.info?.('channel-guard: codearts fetch guard installed')

  return {
    stats,
    uninstall() {
      if (globalThis.fetch === wrapped) {
        globalThis.fetch = original
        options.logger?.info?.('channel-guard: codearts fetch guard removed')
      }
    },
  }
}
