/**
 * 第 3 层：全渠道诊断。
 *
 * 目标不是「报告一堆状态码」，而是回答一个问题：
 * **这个渠道现在能不能用？如果不能，是该我动手还是该你动手？**
 *
 * 所以每个结果都带 `action`：
 *   - 'ok'         可用，不用管
 *   - 'auto'       插件可以自动修
 *   - 'manual'     需要人工（重新登录、去控制台开通）
 *   - 'give-up'    上游政策变更，修不了
 *
 * 设计约束（从踩过的坑来）：
 *   1. 每个 provider 只发 1 次请求，max_tokens 极小，失败不重试。
 *      429 会被上游计入风控，重试三次等于三次推进同一个坑。
 *   2. 网关会把上游的 4xx 包成自己的 502，所以**不能只看 status**，
 *      必须先读响应体里的真实错误码。
 *   3. 选模型要跳过已下架的型号（deepseek-v3.2 就是被下架的那种），
 *      否则好渠道会被探成坏的。
 *
 * @module lib/diagnose.js
 */

/** 已知在各端点长期存在的模型名，只用于挑探针，不是白名单。 */
const KNOWN_GOOD_MODELS = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'glm-5.3-flash',
  'kimi-k2.6',
  'qwen4-max',
]

/** 某些 provider 有明确的探针偏好。 */
const PREFERRED = {
  buddy: 'deepseek-v4.1-flash',
  trae: 'deepseek-v4.1-flash',
}

/** 默认跳过的 provider：用户确认可用且是主力，不浪费额度。 */
const DEFAULT_SKIP = new Set(['trae'])

/** 已知无解的上游政策问题，直接给出结论不必再探。 */
const KNOWN_DEAD = {
  'our-free-model': '免费额度已被上游关闭（throttled / region-blocked），不值得修',
  'our-free-model-region': '地区封锁，本机直连无解',
}

/**
 * 从错误体判断真实原因。
 * @param {number} status
 * @param {string} body
 * @returns {{kind: string, action: string, verdict: string}}
 */
export function classify(status, body) {
  const text = String(body ?? '')

  if (status === 200 || status === 201) {
    return { kind: 'ok', action: 'ok', verdict: '可用' }
  }

  // ── 先读响应体的真码，再看 status ──────────────────────────────────────
  if (/11128|unapproved channel/i.test(text)) {
    return { kind: 'fingerprint', action: 'auto', verdict: 'system 文本指纹被拦截（本插件可修）' }
  }
  if (/11140|安全审核|safety review/i.test(text)) {
    return { kind: 'content-policy', action: 'manual', verdict: '账号级安全策略拦截，需换账号' }
  }
  if (/chat_completions_disabled/i.test(text)) {
    return { kind: 'protocol', action: 'manual', verdict: '上游停用 chat/completions，需改协议' }
  }
  if (/client_not_allowed/i.test(text)) {
    return { kind: 'client-gate', action: 'give-up', verdict: '上游按客户端白名单拦截，UA 伪装无效' }
  }
  if (/not available in your country/i.test(text)) {
    return { kind: 'region', action: 'give-up', verdict: '地区封锁' }
  }
  if (/Free usage limit reached/i.test(text)) {
    return { kind: 'quota', action: 'give-up', verdict: '免费额度已耗尽（上游转付费）' }
  }
  if (/额度已用尽|没有可用权益/i.test(text)) {
    return { kind: 'quota', action: 'manual', verdict: '该账号在此模型无权益，等重置或换模型' }
  }
  if (/APIG\.0101|API does not exist/i.test(text)) {
    return { kind: 'benefit-header', action: 'auto', verdict: 'maas_type 头已失效（本插件可修）' }
  }
  if (/TM\.00000001|网络繁忙/i.test(text)) {
    return { kind: 'ua-block', action: 'auto', verdict: 'user-agent 被定向拦截（本插件可修）' }
  }
  if (/Model not exist|model_not_found/i.test(text)) {
    return { kind: 'model-id', action: 'auto', verdict: '探针选到了下架模型，换模型即可，渠道本身正常' }
  }

  // ── 兜底：看 status ────────────────────────────────────────────────────
  if (status === 401 || status === 403) {
    return { kind: 'auth', action: 'manual', verdict: '凭据失效或权限不足，需重新登录' }
  }
  if (status === 429) {
    return { kind: 'quota', action: 'manual', verdict: '额度或频率受限' }
  }
  if (status >= 500) {
    return { kind: 'upstream', action: 'manual', verdict: '上游 5xx，可能暂时性故障' }
  }
  return { kind: 'unknown', action: 'manual', verdict: `未归类（HTTP ${status}）` }
}

/** 读网关密钥。 */
function readGatewayKey(ctx) {
  // 宿主通常把网关地址/密钥放在环境或设置里；先试环境，再试默认文件。
  const fromEnv = String(process.env.DSH_OPENAI_GATEWAY_API_KEY ?? '').trim()
  if (fromEnv !== '') return fromEnv

  const home = String(process.env.DSH_HOME ?? '').trim() || null
  if (home === null) return null
  try {
    const { readFileSync } = require('node:fs')
    const raw = readFileSync(`${home}/openai-gateway/api-key`, 'utf8').trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}

/**
 * 建诊断服务。
 * @param {{ctx: object, logger?: object}} deps
 */
export function createDiagnoseService({ ctx, logger = console }) {
  const gateway = (() => {
    const port = String(process.env.DSH_OPENAI_GATEWAY_PORT ?? '').trim() || '8326'
    return `http://127.0.0.1:${port}`
  })()

  /**
   * 列出网关里的模型，按 owned_by 分组。
   * @param {string} key
   */
  async function listModels(key) {
    const response = await fetch(`${gateway}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`/v1/models 返回 ${response.status}`)
    const body = await response.json()
    const groups = new Map()
    for (const model of Array.isArray(body.data) ? body.data : []) {
      const owner = String(model.owned_by ?? 'unknown')
      if (!groups.has(owner)) groups.set(owner, [])
      groups.get(owner).push(String(model.id))
    }
    return groups
  }

  /** 挑一个真正存在的模型。 */
  function pickModel(provider, ids) {
    const strip = (id) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id)
    const usable = ids.filter((id) => !/preview|alpha|beta|legacy|deprecated/i.test(id))
    const find = (bare) => ids.find((id) => strip(id) === bare)

    const preferred = PREFERRED[provider] ? find(PREFERRED[provider]) : undefined
    const known = KNOWN_GOOD_MODELS.map(find).find(Boolean)
    return preferred ?? known ?? usable.find((id) => id.includes('/')) ?? usable[0] ?? ids[0]
  }

  /** 一次最小对话请求。 */
  async function probe(key, modelId) {
    const started = Date.now()
    let status = 0
    let text = ''
    try {
      const response = await fetch(`${gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          stream: false,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      status = response.status
      text = await response.text()
    } catch (error) {
      return { status: 0, ms: Date.now() - started, detail: `transport: ${String(error?.message ?? error)}` }
    }

    let detail = ''
    try {
      const parsed = JSON.parse(text)
      detail = parsed?.error?.message ?? parsed?.error?.code ?? ''
      if (detail === '' && Array.isArray(parsed?.choices)) detail = 'choices returned'
    } catch {
      detail = text.slice(0, 200)
    }
    return {
      status,
      ms: Date.now() - started,
      detail: String(detail).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200),
    }
  }

  /**
   * 跑全渠道诊断。
   * @param {{includeTrae?: boolean, only?: string[]}} options
   */
  async function diagnose(options = {}) {
    const key = readGatewayKey(ctx)
    if (key === null) {
      return { ok: false, error: '找不到网关密钥（DSH_OPENAI_GATEWAY_API_KEY 或 $DSH_HOME/openai-gateway/api-key）' }
    }

    let groups
    try {
      groups = await listModels(key)
    } catch (error) {
      return { ok: false, error: `读不到网关模型清单：${String(error?.message ?? error)}` }
    }

    const results = []
    for (const [provider, ids] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (Array.isArray(options.only) && options.only.length > 0 && !options.only.includes(provider)) continue

      if (KNOWN_DEAD[provider] !== undefined) {
        results.push({
          provider, status: null, kind: 'give-up', action: 'give-up',
          verdict: KNOWN_DEAD[provider], detail: '', models: ids.length,
        })
        continue
      }
      if (!options.includeTrae && DEFAULT_SKIP.has(provider)) {
        results.push({
          provider, status: null, kind: 'skipped', action: 'ok',
          verdict: '已确认可用，默认不消耗额度（includeTrae: true 可测）', detail: '', models: ids.length,
        })
        continue
      }

      const modelId = pickModel(provider, ids)
      const outcome = await probe(key, modelId)
      const verdict = classify(outcome.status, outcome.detail)
      results.push({
        provider,
        model: modelId,
        models: ids.length,
        ...outcome,
        ...verdict,
      })
    }

    const needsWork = results.filter((r) => r.action !== 'ok')
    return {
      ok: true,
      at: new Date().toISOString(),
      gateway,
      total: results.length,
      healthy: results.filter((r) => r.action === 'ok').length,
      results,
      summary: {
        autoFixable: needsWork.filter((r) => r.action === 'auto').map((r) => r.provider),
        manual: needsWork.filter((r) => r.action === 'manual').map((r) => r.provider),
        giveUp: needsWork.filter((r) => r.action === 'give-up').map((r) => r.provider),
      },
    }
  }

  return { diagnose, classify, pickModel }
}
