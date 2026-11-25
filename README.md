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

### 前置：确认你的 DSH 装在哪

不同平台的路径不一样。先找到 `node_modules` 所在的 profile 目录：

```bash
# 看 DSH_HOME（多数安装会设这个环境变量）
echo "$DSH_HOME"          # Linux / macOS
echo $env:DSH_HOME        # Windows PowerShell

# 没设的话，profile 通常在：
#   Linux / macOS   ~/.dsh/profiles/<profile-name>/
#   Windows         %USERPROFILE%\.dsh\profiles\<profile-name>\
```

`<profile-name>` 一般是 `desktop`、`web` 或 `tui`。

### 第 1 步：把插件放进 profile

**不要用软链接。** `pnpm add link:` 装出来是 symlink，
而 DSH 加载器不跟随 symlink —— 表现为 `enabled: true` 但 `fiberPhase: null`，永不激活。

```bash
PROFILE="$DSH_HOME/profiles/desktop"     # 按实际情况改

# 方式 A：从 release 包解压
unzip channel-guard-*.zip -d /tmp
cp -r /tmp/channel-guard "$PROFILE/node_modules/channel-guard"

# 方式 B：从源码目录拷（开发时用）
cp -r ./channel-guard "$PROFILE/node_modules/channel-guard"

# 方式 C：不经包管理器，直接拷进 node_modules 也算安装
```

### 第 2 步：加进 bundles 列表

**这是最容易漏的一步。** 包管理器只写 `dependencies`，**不会写** `bundles`。
缺了它，文件在、也不报错，但插件永远不会被加载。

编辑 `$PROFILE/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...已有的其他插件...",
        "channel-guard"
      ]
    }
  }
}
```

### 第 3 步：重载

重启 DSH，或在宿主里切换一次该插件的启停开关。

**确认真的激活了**：插件列表里

```
moduleName = channel-guard
enabled    = true
fiberPhase = active        ← 必须是 active，不是 null
```

如果 `fiberPhase` 还是 `null`，回到第 1 步检查是不是用了软链接。

## 验证

在插件目录下跑（不碰 DSH，不发请求）：

```bash
cd channel-guard
node test/offline-check.mjs           # 47 项：指纹改写 + 错误分类器
node test/codearts-guard-check.mjs    # 19 项：UA 改写 + 签名算法
```

两项都应输出 `0 失败`。这两份测试自带 fixture，克隆下来就能跑，不依赖任何本机文件。

### 可选：用真实凭据验证签名重算

`--live` 会真的向上游发请求（消耗少量额度），验证「带 `maas_type` 的请求能否被修复」。

```bash
# 凭据位置按平台自动推断，也可以用 DSH_HOME 指定
DSH_HOME=~/.dsh node test/codearts-guard-check.mjs --live
```

期望输出：

```
未经守卫: 403 {"error_code":"TM.00000001",…}   ← 证明问题存在
经守卫后: 200 {"id":"as-…",…}                   ← 证明修好了
```

若上游限流会返回 429，测试会自动识别并说明「已不再是 403/404，签名重算生效」，
不会误报成失败。

### 端到端验证（证明不依赖任何 vendor 补丁）

把 `dsh-our-free-model` 的 `pack.js` 还原成纯净原版，再发一句话：

```bash
cd "$PROFILE/node_modules/dsh-our-free-model/vendor/channel-pack"
cp pack.js.orig pack.js     # 若没有 .orig，从插件包重新解出
```

然后对 buddy 和 codearts 各发一句。两个都应该正常出字。
这就是「插件独立生效」的证明。

## 出问题时怎么办

### 先跑自检

按上面「第 3 步」的清单逐项自检。三个最常见的失败点：

1. `fiberPhase` 不是 `active` → 多半是软链接
2. 插件列表里根本没有它 → `bundles` 没注册
3. 列表里有但改写不生效 → 层开关被关，或 `lib/` 文件缺失

跑 `node test/offline-check.mjs` 可以进一步定位逻辑层问题。

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
