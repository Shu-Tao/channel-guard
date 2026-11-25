# 渠道守卫 / Channel Guard

一键检查并修复 DSH 各渠道「模型无法使用」的问题。

## 现在覆盖什么（2026-11-25 实测）

| 渠道 | 故障 | 状态 |
|---|---|---|
| **buddy** | 上游按 system 文本指纹拒绝（400 / code 11128） | ✅ **插件独立修复** |
| **codearts** | user-agent 被拦截（403）、`maas_type` 头失效（404） | ✅ **插件独立修复** |
| 全渠道 | — | ✅ 诊断，按「可自动修／需你动手／修不了」分类 |

**决定性验证**：把 `pack.js` 还原成完全纯净的原版（md5 `c98485f0…`，零补丁），
两个渠道仍然都返回 200。插件不再需要任何 vendor 文件修改。

## 它修的是什么

上游根据**客户端特征**拒绝请求，而不是你的账号或额度有问题。三类具体手段：

### 1. system 文本指纹（buddy）

上游有两条独立规则：

1. system 开头命中 `^\s*You are an AI agent powered by DeepSeek Harness`
2. 同时含两条 @-路径短语（AND 匹配）

**两处都必须改。** 只修第一条，请求仍然 400。

插件的做法是在 `system-prompt/assemble` 里改写，**按内容过滤而不是按 provider**——
因为 DSH 44.7.0 的 `AssembleContext` 只有 `{ scope?, signal? }`，
`PromptPresentation.variables` 从不含 provider，任何依赖 provider 判断渠道的实现都会静默失效。

### 2. user-agent 句式（codearts）

上游对 `deepseek-harness/<版本>` 这个**子串**返回 403（`TM.00000001`「网络繁忙」）。

实测矩阵（同账号同模型）：

| user-agent | 结果 |
|---|---|
| `deepseek-harness/44.7.0 (+https://…)` | 403 |
| 不发送 | 200 |
| `deepseek-harness`（无版本） | 200 |
| `DeepSeek-Harness/44.7.0`（改大小写） | 200 |
| `deepseek-harness 44.7.0`（空格代替斜杠） | 429（限流，未拦） |
| ` deepseek-harness/44.7.0`（前导空格） | **403**（上游 trim，空格无效） |

判据是斜杠句式。插件改成 `deepseek-harness_v<版本>`，保留版本归属。

### 3. 失效的 `maas_type: benefit` 头（codearts）

上游撤掉了 benefit 路由，带着这个头会得到 404 `APIG.0101`。
插件对 `deepseek-v4.1-flash` / `glm-5.3-flash` 会自动加这个头——所以这两个模型必然失败。

**关键难点：这个头参与华为云签名。**

```
headers.set("maas_type", "benefit")          // pack.js 签名前
signedHeaders = [...headers.keys()].sort()   // → 包含 maas_type
canonicalRequest = … signedHeaders.join(';') …
```

所以只删 header 会得到 **401**（`verify ak sk signature fail`）。
必须重算 Authorization，这需要 `secret_access_key`，通过 `ctx.credentials.resolve()` 读取。

插件完整重算了 SIG-V11：

```
canonical     = METHOD \n uri \n query \n headerLines \n "" \n signedHeaders \n payloadHash
stringToSign  = SDK-HMAC-SHA256 \n dateStamp \n sha256(canonical)
signature     = HMAC-SHA256(sk, stringToSign)
```

实测：带 benefit 的请求原样发 → 403；经插件处理后 → **200**。

## 为什么不注册自己的 adapter

看起来最干净的做法是注册同名 provider 接管路由，但 DSH 明确堵死了：

```js
prepareRoutes(providers, adapter, owned) {
  if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider))
    throw new LlmError(`an adapter for provider "${provider}" is already registered`,
                       'DUPLICATE_ADAPTER')
}
```

`codearts` / `buddy` 已被 `our-free-model` 注册，再注册直接抛异常。
而 `this.adapters` 是私有 Map，没有公开替换入口。

**可行落点**：`createChannelFetch` 的底层是

```js
const fetchImpl = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init)
```

所有渠道 adapter 共用它。包装 `globalThis.fetch` 能拦到全部出网请求，
且不改任何 vendor 文件。插件只对 `snap-access.cn-north-4.myhuaweicloud.com`
这一个主机生效，其他域名原样转发。


## 架构

```
channel-guard/
├── index.js                    入口，三层按 config 装配
├── lib/
│   ├── system-guard.js         ① 纯函数：指纹改写 + 文本检查
│   ├── system-prompt-apply.js  ① 宿主接线：挂 system-prompt/assemble
│   ├── codearts-guard.js       ② UA 改写 + 去 benefit 头 + SIG-V11 重签
│   ├── fetch-apply.js          ② 宿主接线：包装 globalThis.fetch
│   └── diagnose.js             ③ 全渠道诊断 + 错误分类器
└── cordis.patch.yml            层开关
```

三层开关：

```yaml
config:
  buddySystem: true     # ① system 指纹改写
  codeartsFetch: true   # ② codearts 请求修正
  diagnose: true        # ③ 诊断服务
  debug: false          # 打开后记录每次改写
```

## 安装

```bash
cd "C:/Users/25759/.dsh/profiles/desktop"
NODE="C:/Users/25759/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
PNPM="E:/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
"$NODE" "$PNPM" add "link:D:/DeepSeek Harness/projects/channel-guard"
```

**两个必须做的后续步骤，缺一则插件不生效且没有任何报错：**

1. **`pnpm add` 不写 bundles**，必须手动加进 `package.json`：
   ```json
   "dsh": { "profile": { "bundles": [ … , "channel-guard" ] } }
   ```
2. **不要用软链接**。`link:` 装出来是 symlink，DSH 加载器不跟随，
   表现为 `enabled: true` 但 `fiberPhase: null`（永不激活）。改成实体目录：
   ```bash
   rm node_modules/channel-guard
   cp -r "D:/DeepSeek Harness/projects/channel-guard" node_modules/channel-guard
   ```

然后切一次开关强制重载，确认 `fiberPhase` 变成 `active`。

## 验证

```bash
cd "D:/DeepSeek Harness/projects/channel-guard"
"$NODE" test/offline-check.mjs           # 47 项：指纹改写 + 分类器
"$NODE" test/codearts-guard-check.mjs    # 17 项：UA + 签名算法

# 加 --live 会发真实请求验证签名重算（消耗少量额度）
"$NODE" test/codearts-guard-check.mjs --live
```

`--live` 的期望输出：

```
未经守卫: 403 {"error_code":"TM.00000001",…}     ← 证明问题存在
经守卫后: 200 {"id":"as-…",…}                     ← 证明修好了
```

## 出问题时怎么办

### 先跑自检

```bash
NODE="C:/Users/25759/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
"$NODE" "D:/DeepSeek Harness/projects/dsh-buddy-fix/scripts/selfcheck.mjs"
```

8 项检查会指出具体哪一步没做对（装错位置、软链接、bundles 没注册、源没部署、层被关等）。
每天 09:00 也有定时任务自动跑一次。

### 应急回退到补丁方案

如果插件本身出问题，可以临时回退。**配套工具在 `D:\DeepSeek Harness\projects\dsh-buddy-fix`**。

```bash
# 1. 先停插件（避免两套修复打架，否则难排查）
#    把 cordis.patch.yml 里 buddySystem / codeartsFetch 改成 false，或禁用 include:channel-guard

# 2. 再打补丁（顺序：buddy → UA → benefit）
cd "D:/DeepSeek Harness/projects/dsh-buddy-fix"
"$NODE" scripts/patch-pack.mjs --apply
"$NODE" scripts/patch-codearts-ua.mjs --apply
"$NODE" scripts/patch-codearts-benefit.mjs --apply

# 3. 回滚
copy /Y "...\vendor\channel-pack\pack.js.orig" "...\vendor\channel-pack\pack.js"
```

补丁方案的缺点：改的是 vendored 文件，`pnpm` 重装或插件升级会覆盖。
所以它只适合临时救急。

### 排查上游又改了什么

被拦的请求不扣 token，这条路很便宜。

```bash
cd "D:/DeepSeek Harness/projects/dsh-buddy-fix"
"$NODE" scripts/extract-system-prompt.mjs <会话日志> logs/system-prompt.txt   # 解出完整 system 文本
"$NODE" scripts/replay-upstream.mjs logs/system-prompt.txt                     # 原文本 vs 改写后 A/B 对照
"$NODE" scripts/diagnose-channels.mjs                                          # 全渠道看谁坏了
```

方法论：**先绕过插件直连上游**（通不通决定问题在哪一层），再**逐个请求头做隔离**
（一次只改一个变量），最后对可疑的头做**句式矩阵**（原样 / 改大小写 / 换分隔符 / 调顺序 / 加前导空白）。

## 三个容易踩的坑

这三个都是我在自己机器上踩过的，写在这里避免重复：

### 1. 装了但不加载

`pnpm add` 只写 `dependencies`，**不写 `dsh.profile.bundles`**。
缺这一步，插件文件在、什么都不报，但永远不会被加载。

### 2. 软链接永远不激活

`link:` 装出来是 symlink，DSH 加载器**不跟随**。
表现为 `plugin_manager` 里 `enabled: true` 但 `fiberPhase: null`。

我第一次测 buddy 时它返回 400，差点以为是改写逻辑有 bug，实际是插件根本没被实例化。
必须用实体目录。

### 3. 改 header 破坏了签名

`maas_type` 参与华为云 SIG-V11 签名（`signedHeaders` 里包含它）。
只删 header 会得到 **401**（`verify ak sk signature fail`），比原来的 404 更难排查。
必须重算 Authorization。

## 已知限制

- **需要重新登录的渠道只能报告**：凭据过期、账户级 403 需要你到对应平台登录
- **额度耗尽等重置**：zcode 这类按自然日结算，插件不代劳
- **上游政策变更**：`our-free-model` 免费额度已关闭，`ccswitch` 有客户端白名单，都不尝试绕过
- **codearts 首次请求较慢**：要读凭据并重签，之后同上
- 上游可能再改策略；本插件针对 2026-11 的行为

## 历史脉络

这个插件是几次踩坑的产物，理解过程有助于排查类似问题：

1. **buddy 400** —— 上游按 system 文本指纹拒绝。先写补丁改 `pack.js`，验证通过。
2. **发现社区插件是空操作** —— `dsh-buddy-guard@0.1.2` 靠 `variables.provider` 判断渠道，
   但 DSH 44.7.0 的 `AssembleContext` 没有这个字段，于是 provider 恒为空、原样返回。
   插件加载正常、日志正常、**请求一个字节都没变**。
3. **codearts「API 密钥无效」是假线索** —— 那是 DSH 宿主对 `AUTH` 的固定文案。
   直连上游三个账户全 200，逐个隔离请求头后才发现两个真凶（UA 句式、benefit 头）。
4. **注册 adapter 被堵死** —— `prepareRoutes` 对已注册 provider 直接抛 `DUPLICATE_ADAPTER`。
   改走 fetch 层。
5. **`pack.js` 还原纯净** —— 插件独立撑住两个渠道，不再需要任何 vendor 补丁。

---

## 许可

MIT
