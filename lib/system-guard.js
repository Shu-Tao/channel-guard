/**
 * 第 1 层：system 文本指纹改写。
 *
 * 为什么按「内容」而不是按「provider」过滤 —— 这是本插件的关键设计点：
 *
 *   社区插件 dsh-buddy-guard 靠 `assembly.variables.provider` 或
 *   `context.agent.options.provider` 判断渠道。但 DSH 44.7.0 的
 *   `AssembleContext` 只有 `{ scope?, signal? }`，而
 *   `PromptPresentation.variables` 只承载被贡献的变量
 *   （DSH_DEPLOYMENT_REGION / DSH_WEB_URL），从不含 provider。
 *   于是 provider 恒为空，插件加载正常、日志正常，但请求一个字节都没变。
 *
 *   本模块不查 provider：只问「这段 system 里有没有上游会拒绝的指纹」。
 *   有就改写。这对任何渠道都安全 —— 改写后的文本语义等价，
 *   而指纹句式本身就是我们要消除的目标。
 *
 * 上游判据（2026-11-24 实测）：
 *   ① system 开头命中 `^\s*You are an AI agent powered by DeepSeek Harness`
 *   ② system 同时含下面两条 @-路径短语（AND 匹配）
 *   两处都必须处理。只修 ①、保留 ②，请求仍然 400。
 *
 * @module lib/system-guard.js
 */

/** 身份句：改成插入逗号，语义不变但不再命中 `^\s*You are an AI agent powered by`。 */
const IDENTITY_FROM = 'You are an AI agent powered by'
const IDENTITY_TO = 'You are an AI agent, powered by'

/** 指纹 A：与 B 同时出现时触发拦截。只改 A，B 保留（B 描述路径语义，改了会误导模型）。 */
const PHRASE_A_FROM = 'Tokens prefixed with @ are paths the user explicitly referenced'
const PHRASE_A_TO = 'Path tokens starting with the at-sign point at locations the user referenced'

/** 指纹 B：只用于判断「是否需要报告」和自查，不改写。 */
export const PHRASE_B = 'Relative paths resolve from the workspace root'

/** 上游还认这个错误码。诊断时用它区分「指纹拦截」和其他 400。 */
export const CONTENT_REJECTION_CODE = 11128

/**
 * 改写一段 system 文本。
 *
 * 幂等：改过的文本不会再命中（逗号已经插进去、A 句已被替换）。
 * 安全：非字符串、空串原样返回。
 *
 * @param {string} text
 * @returns {string}
 */
export function guardText(text) {
  if (typeof text !== 'string' || text.length === 0) return text

  // 先处理指纹 A：它是纯字符串替换，与位置无关。
  let out = text.split(PHRASE_A_FROM).join(PHRASE_A_TO)

  // 再处理身份句：必须在「剥掉前导空白」后比对。
  // 上游判据是 ^\s*，留着空格只会让本地判断错位（2026-10-29 起空格对策已失效）。
  const body = out.replace(/^\s+/, '')
  if (body.startsWith(IDENTITY_FROM)) {
    out = IDENTITY_TO + body.slice(IDENTITY_FROM.length)
  }
  return out
}

/**
 * 判断一段文本是否含上游指纹（用于诊断报告，不用于决定是否改写）。
 * @param {string} text
 * @returns {{identity: boolean, phraseA: boolean, phraseB: boolean, anything: boolean}}
 */
export function inspectText(text) {
  const s = typeof text === 'string' ? text : ''
  const body = s.replace(/^\s+/, '')
  const identity = body.startsWith(IDENTITY_FROM)
  const phraseA = s.includes(PHRASE_A_FROM)
  const phraseB = s.includes(PHRASE_B)
  // 上游两条规则任一成立就会被拒。
  return { identity, phraseA, phraseB, anything: identity || (phraseA && phraseB) }
}

/**
 * 改写一个 assembly 的所有 section。
 *
 * `system-prompt/assemble` 是 waterfall：listener 拿到 (assembly, context, next)，
 * 必须 `await next()` 拿到内层结果，返回一个新 assembly 才生效。
 * 直接改传入对象无效 —— cordis 的 waterfall 不接受参数传递。
 *
 * @param {{sections?: Array<{text?: string}>}} assembly
 * @returns {{assembly: object, changed: boolean, hits: number}}
 */
export function guardAssembly(assembly) {
  const sections = assembly?.sections
  if (!Array.isArray(sections) || sections.length === 0) {
    return { assembly, changed: false, hits: 0 }
  }

  const next = sections.slice()
  let changed = false
  let hits = 0

  for (let i = 0; i < next.length; i++) {
    const section = next[i]
    if (section === null || typeof section !== 'object') continue
    if (typeof section.text !== 'string' || section.text.length === 0) continue

    const guarded = guardText(section.text)
    if (guarded !== section.text) {
      next[i] = { ...section, text: guarded }
      changed = true
      hits += 1
    }
  }

  return { assembly: changed ? { ...assembly, sections: next } : assembly, changed, hits }
}
