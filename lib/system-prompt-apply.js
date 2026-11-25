/**
 * 第 1 层的宿主接线：把 guardAssembly 挂到 `system-prompt/assemble`。
 *
 * 两个注册选项都是必需的：
 *
 *   global: true
 *     assembly 是全局管道，不按 scope 过滤时才能覆盖每个会话。
 *
 *   prepend: true
 *     链上若存在一个「不调用 next() 的监听器」就会短路后面全部监听器。
 *     dsh-ops 的 discovery 分支里就有 `return prompt.assemble(context)` 这种写法
 *     （见 dsh-ops/lib/discovery/controller.js）。不 prepend 的话，
 *     本插件会加载正常、日志正常，但请求一个字都没变 —— 这是最难查的失效方式。
 *
 * 另外：cordis 的 waterfall 里 `next` 不接受参数，改写只能靠监听器的**返回值**。
 * 写 `next(改过的 options)` 会被直接丢弃。
 *
 * @module lib/system-guard.js 的 apply 部分
 */

import { guardAssembly, inspectText } from './system-guard.js'

/**
 * @param {object} ctx - Cordis 上下文
 * @param {{logger?: object, debug?: boolean}} options
 */
export function apply(ctx, options = {}) {
  const logger = options.logger ?? ctx.logger ?? console
  let adjusted = 0

  if (typeof ctx.on !== 'function') {
    logger.warn?.('channel-guard: ctx.on unavailable; system guard not mounted')
    return
  }

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    // waterfall 约定：先拿内层结果，再在它之上改写。
    let current
    try {
      current = await next()
    } catch (error) {
      // 内层失败必须原样抛出，不能吞掉换成旧 assembly ——
      // 那会把「provider 配置错误」伪装成「提示词不完整」。
      throw error
    }

    try {
      const { assembly: guarded, changed, hits } = guardAssembly(current)
      if (!changed) return current

      adjusted += 1
      if (options.debug === true) {
        const before = inspectText(
          (current.sections ?? []).map(s => s?.text ?? '').join('\n'),
        )
        logger.info?.(
          `channel-guard: rewrote ${hits} section(s) ` +
          `(identity=${before.identity} phraseA=${before.phraseA} phraseB=${before.phraseB})`,
        )
      }
      return guarded
    } catch (error) {
      // 改写失败绝不能阻断提示词组装 —— 宁可原样放行，也不能让会话起不来。
      logger.warn?.(`channel-guard: system rewrite skipped: ${String(error)}`)
      return current
    }
  }, { global: true, prepend: true })

  logger.info?.('channel-guard: system-prompt guard mounted (global, prepend)')

  /** 供诊断读取的计数器。 */
  return {
    get adjusted() { return adjusted },
  }
}
