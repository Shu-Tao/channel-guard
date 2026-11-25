/**
 * channel-guard —— Host 半身。
 *
 * 三层结构，逐层可独立开关（见 cordis.patch.yml）：
 *   1. buddySystem     按内容改写 system 指纹（默认开，零风险）
 *   2. codeartsFetch   在 fetch 层修正 codearts 请求（默认开）
 *   3. diagnose        全渠道只读诊断（默认开）
 *
 * 为什么第 2 层走 fetch 层而不是注册 adapter：
 *   DSH 的 prepareRoutes 对已注册 provider 直接抛 DUPLICATE_ADAPTER，
 *   而 codearts 已被 our-free-model 注册，且 adapters 是私有 Map 无替换入口。
 *   createChannelFetch 的底层是 (options.fetchImpl ?? globalThis.fetch)，
 *   所有渠道共用，包装它能拦到全部出网请求。
 *
 * @module channel-guard
 */

import { apply as applySystemGuard } from './lib/system-prompt-apply.js'
export { guardText, inspectText } from './lib/system-guard.js'
export { guardUserAgent, signV11, parseAuthorization } from './lib/codearts-guard.js'
import { createDiagnoseService } from './lib/diagnose.js'
import { installCodeartsGuard } from './lib/fetch-apply.js'

export const name = 'channel-guard'

/** credentials 用于 codearts 续签时取 sk；取不到就降级为只改 UA。 */
export const inject = { optional: ['credentials'] }

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - loader 行配置
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const settings = {
    buddySystem: config.buddySystem !== false,
    codeartsFetch: config.codeartsFetch !== false,
    diagnose: config.diagnose !== false,
    debug: config.debug === true,
  }

  logger.info?.(
    `channel-guard: buddySystem=${settings.buddySystem} ` +
    `codeartsFetch=${settings.codeartsFetch} diagnose=${settings.diagnose}`,
  )

  const disposers = []

  // ── 第 1 层：system 指纹改写 ───────────────────────────────────────────────
  if (settings.buddySystem) {
    try {
      applySystemGuard(ctx, { logger, debug: settings.debug })
    } catch (error) {
      logger.warn?.(`channel-guard: system guard failed to mount: ${String(error)}`)
    }
  }

  // ── 第 2 层：codearts fetch 守卫 ──────────────────────────────────────────
  if (settings.codeartsFetch) {
    try {
      // 凭据晚绑定：composition 可能在插件加载后才发布 credentials
      const credentials = () => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
        } catch {
          return undefined
        }
      }
      const guard = installCodeartsGuard({
        credentials,
        logger,
        debug: settings.debug,
      })
      disposers.push(() => guard.uninstall())
      logger.info?.('channel-guard: codearts fetch guard active')
    } catch (error) {
      logger.warn?.(`channel-guard: codearts guard failed to mount: ${String(error)}`)
    }
  }

  // ── 第 3 层：诊断服务 ─────────────────────────────────────────────────────
  if (settings.diagnose) {
    try {
      const service = createDiagnoseService({ ctx, logger })
      if (typeof ctx.provide === 'function') {
        ctx.provide('channelGuard', service)
      } else {
        globalThis.__channelGuard = service
      }
      logger.info?.('channel-guard: diagnose service ready')
    } catch (error) {
      logger.warn?.(`channel-guard: diagnose service failed to mount: ${String(error)}`)
    }
  }

  // 卸载时还原 fetch，避免插件停用后仍留着包装
  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 卸载失败不影响宿主 */ }
      }
    }, 'channel-guard: fetch guard lifetime')
  }
}
