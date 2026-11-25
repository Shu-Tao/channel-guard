/**
 * channel-guard —— Host 半身。
 *
 * 三层结构，逐层可独立开关（见 cordis.patch.yml）：
 *   1. buddySystem      按内容改写 system 指纹（零风险，默认开）
 *   2. codeartsAdapter  自建 codearts adapter 接管路由（默认关）
 *   3. diagnose         全渠道只读诊断 + 一键修复报告（默认开）
 *
 * 设计原则：能自动修的自动修，不能自动修的（凭据过期、需要重新登录）
 * 如实报告并给出下一步，不假装自动化。
 *
 * @module channel-guard
 */

import { apply as applySystemGuard } from './lib/system-prompt-apply.js'
export { guardText, inspectText } from './lib/system-guard.js'
import { createDiagnoseService } from './lib/diagnose.js'

export const name = 'channel-guard'

/** 需要一个能发 HTTP 的宿主；credentials 与 llm 是按需注入的。 */
export const inject = []

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - loader 行配置
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const settings = {
    buddySystem: config.buddySystem !== false,
    codeartsAdapter: config.codeartsAdapter === true,
    diagnose: config.diagnose !== false,
  }

  logger.info?.(
    `channel-guard: buddySystem=${settings.buddySystem} ` +
    `codeartsAdapter=${settings.codeartsAdapter} diagnose=${settings.diagnose}`,
  )

  // ── 第 1 层：system 指纹改写 ───────────────────────────────────────────────
  if (settings.buddySystem) {
    applySystemGuard(ctx, { logger })
  }

  // ── 第 3 层：诊断服务 ─────────────────────────────────────────────────────
  if (settings.diagnose) {
    try {
      const service = createDiagnoseService({ ctx, logger })
      // 暴露成 ctx 上的服务名，供工具/UI 调用；宿主没有服务注册表时降级为普通对象。
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

  // ── 第 2 层：codearts adapter（默认关，见 README 的验证步骤） ─────────────
  if (settings.codeartsAdapter) {
    logger.warn?.(
      'channel-guard: codeartsAdapter 已启用，但它与 our-free-model 争同一 provider 路由；' +
      '先确认 which one wins，见 docs/DETAIL.md',
    )
  }
}
