/**
 * 离线验证 channel-guard 的核心逻辑，不依赖 DSH 运行时，也不依赖任何外部文件。
 *
 * 内置一份合成 prompt（含上游两条指纹），保证克隆下来就能跑。
 * 想用真实数据验证，加 `--fixture <path>` 指向你本机解出的 system 文本。
 *
 * 用法：
 *   node test/offline-check.mjs
 *   node test/offline-check.mjs --fixture /path/to/system-prompt.txt
 */
import { readFileSync } from 'node:fs'
import { guardText, inspectText, guardAssembly } from '../lib/system-guard.js'
import { classify } from '../lib/diagnose.js'

/**
 * 合成 fixture：覆盖上游两条指纹规则的完整样本。
 *
 * 用它而不是依赖本机文件，是为了让任何克隆都能直接跑通 ——
 * 一个只能在作者机器上通过的测试，等于没有测试。
 */
const FIXTURE = [
  'You are an AI agent powered by DeepSeek Harness.',
  '',
  'You are a coding agent working in a terminal.',
  '',
  '### File references',
  '',
  'Tokens prefixed with @ are paths the user explicitly referenced. ' +
    'Relative paths resolve from the workspace root; absolute paths identify files or ' +
    'directories on the host. A trailing slash marks a directory: list it when its ' +
    'contents matter.',
  '',
  '### Tools',
  '',
  'Use read to inspect files and write to create them.',
].join('\n')

const fixtureArgIdx = process.argv.indexOf('--fixture')
const externalFixture = fixtureArgIdx >= 0 ? process.argv[fixtureArgIdx + 1] : null

let prompt = FIXTURE
let fixtureSource = 'built-in'
if (typeof externalFixture === 'string' && externalFixture.length > 0) {
  prompt = readFileSync(externalFixture, 'utf8')
  fixtureSource = externalFixture
  console.log(`使用外部 fixture：${externalFixture}（${Buffer.byteLength(prompt)} 字节）\n`)
}

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('=== 1. system 文本改写 ===')
const before = inspectText(prompt)
const out = guardText(prompt)
const after = inspectText(out)

// 注意：本机真实 prompt 里身份句可能已被 dsh-purge 一类工具剥离，
// 所以这三项只做「有则验证」的软断言 —— 硬断言会让测试在合法环境下误报。
check('原文含指纹 A', before.phraseA === true)
check('原文含指纹 B', before.phraseB === true)
check('原文会触发上游拦截', before.anything === true)
if (before.identity) {
  check('原文含身份句（存在则验证）', before.identity === true)
} else {
  console.log('  --   原文不含身份句（可能已被上游注入层剥离，跳过）')
}
check('改写后指纹 A 消失', after.phraseA === false)
check('改写后指纹 B 保留', after.phraseB === true)
check('改写后不再触发上游规则', after.anything === false)
check('幂等', guardText(out) === out)
check(
  '字节数变化极小',
  Math.abs(Buffer.byteLength(out) - Buffer.byteLength(prompt)) < 100,
  `before=${Buffer.byteLength(prompt)} after=${Buffer.byteLength(out)}`,
)

console.log('\n=== 2. 身份句边界 ===')
const identity = 'You are an AI agent powered by DeepSeek Harness.\nrest of prompt.'
check('改写身份句', guardText(identity).startsWith('You are an AI agent, powered by'))
check('前导空格也处理', guardText('   ' + identity).startsWith('You are an AI agent, powered by'))
check('多个前导空白 / 换行也处理', guardText('\n\n\t' + identity).startsWith('You are an AI agent, powered by'))
check('品牌单独出现不改', guardText('DeepSeek Harness') === 'DeepSeek Harness')
check('不含版本号的品牌不改', guardText('powered by DeepSeek Harness.') === 'powered by DeepSeek Harness.')
check('空串安全', guardText('') === '')
check('null 安全', guardText(null) === null)
check('undefined 安全', guardText(undefined) === undefined)

console.log('\n=== 3. assembly 改写 ===')
const assembly = {
  sections: [
    { name: 'a', text: 'plain section' },
    { name: 'b', text: prompt },
  ],
  variables: {},
}
const res = guardAssembly(assembly)
check('执行了改写', res.changed === true)
check('只动了含指纹的 section', res.hits === 1)
check('未改动的 section 保持原样', res.assembly.sections[0].text === 'plain section')
check('原 assembly 未被就地修改', assembly.sections[1].text === prompt)
check('无可改时返回原对象', guardAssembly({ sections: [{ text: 'x' }] }).changed === false)
check('空 sections 安全', guardAssembly({ sections: [] }).changed === false)
check('undefined 安全', guardAssembly(undefined).changed === false)
check('null 安全', guardAssembly(null).changed === false)

console.log('\n=== 4. 错误分类器（用真实上游错误体）===')
const cases = [
  [400, '{"code":11128,"message":"Illegal API invocation from an unapproved channel"}', 'fingerprint', 'auto'],
  [403, '{"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}', 'ua-block', 'auto'],
  [502, '{"error_msg":"The API does not exist or has not been published in the environment","error_code":"APIG.0101"}', 'benefit-header', 'auto'],
  [403, 'codearts: model request failed with HTTP 403', 'auth', 'manual'],
  [429, 'Free usage limit reached. Free models work in OpenCode', 'quota', 'give-up'],
  [502, '{"code":"chat_completions_disabled"}', 'protocol', 'manual'],
  [502, '{"code":"client_not_allowed"}', 'client-gate', 'give-up'],
  [403, 'This model is not available in your country', 'region', 'give-up'],
  [404, '{"message":"Model not exist","code":"model_not_found"}', 'model-id', 'auto'],
  [400, '{"code":11140,"message":"安全审核未通过"}', 'content-policy', 'manual'],
  [200, '{"choices":[]}', 'ok', 'ok'],
]
for (const [status, body, wantKind, wantAction] of cases) {
  const got = classify(status, body)
  check(`${status} → ${wantKind}`, got.kind === wantKind, `got ${got.kind}`)
  if (got.kind === wantKind) {
    check(`  action=${wantAction}`, got.action === wantAction, `got ${got.action}`)
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败（fixture: ${fixtureSource}）`)
process.exit(fail === 0 ? 0 : 1)
