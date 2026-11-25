# 渠道守卫 / Channel Guard

一键检查并修复 DSH 各渠道「模型无法使用」的问题。

## 它解决什么

DSH 接入的第三方模型渠道会因**上游的客户端识别策略**而失败，而界面给出的错误文案往往
指向错误方向。本插件把「诊断」和「修复」分开，能自动修的自动修，不能的如实报告。

已覆盖的三类故障：

| 故障 | 界面看到的样子 | 真实原因 | 本插件 |
|---|---|---|---|
| buddy 渠道 | `请求被拦截，请重新发送` / `Illegal API invocation from an unapproved channel` | 上游按 system 文本指纹拒绝（身份句开头，或两条 @-路径短语同时出现） | ✅ 自动改写 |
| codearts 渠道 | `API 密钥无效` | 上游对 user-agent 里的 `deepseek-harness/<版本>` 返回 403 | ⚠️ 需 adapter 层（见下） |
| codearts 渠道 | `The API does not exist` | 已失效的 `maas_type: benefit` 头 | ⚠️ 需 adapter 层（见下） |

**「API 密钥无效」是 DSH 宿主对 `AUTH` 类错误的固定文案**（`message.failure.auth`），
不是上游原话。codearts 用的是华为云 STS 三元组，根本不用 API Key —— 顺着这句话排查会走错方向。

## 架构

```
channel-guard/
├── index.js                    入口，按 config 装配各层
├── lib/
│   ├── system-guard.js         ① 纯函数：文本指纹改写 + 分类器
│   ├── system-prompt-apply.js  ① 宿主接线：挂 system-prompt/assemble
│   └── diagnose.js             ③ 全渠道只读诊断
└── cordis.patch.yml            层开关
```

三层独立开关（`cordis.patch.yml`）：

```yaml
config:
  buddySystem: true       # ① system 指纹改写（默认开）
  codeartsAdapter: false  # ② 自建 adapter（默认关，需先验证路由归属）
  diagnose: true          # ③ 诊断服务（默认开）
```

## 第 1 层：system 指纹改写

### 为什么不按 provider 过滤

社区插件 `dsh-buddy-guard@0.1.2` 在本机是**空操作**。它靠这两个来源判断渠道：

```js
assembly?.variables?.provider        // ①
context?.agent?.options?.provider    // ②
```

但 DSH 44.7.0 的真实形状两者都没有：

- `interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }` —— 没有 `agent`
- `PromptPresentation.variables` 只承载**被贡献的变量**
  （`DSH_DEPLOYMENT_REGION` / `DSH_WEB_URL`），从不含 `provider`

于是 `provider === ''`，`providers.has('')` 为假，监听器原样返回。
插件加载正常、日志正常、配置正确，**请求一个字节都没变**。

本插件改用**内容过滤**：只问「这段 system 里有没有上游会拒绝的指纹」。
有就改写。这对任何渠道都安全，因为改写后语义等价，而指纹句式本身就是目标。

### 两处都必须改

上游有两条独立规则（2026-11-24 实测）：

1. **身份句**：system 开头命中 `^\s*You are an AI agent powered by DeepSeek Harness`
   → 改成 `You are an AI agent, powered by ...`（插一个逗号）
2. **AND 配对**：同时含
   - `Tokens prefixed with @ are paths the user explicitly referenced`
   - `Relative paths resolve from the workspace root`
   → **只改第一条**。第二条描述 `read`/`write`/`glob` 的路径语义，原样保留对模型最友好。

控制实验：只修身份句、把第一条短语还原 → 仍然 400。所以两处缺一不可。

### 实现要点

- 注册必须带 `{ global: true, prepend: true }`。
  `dsh-ops/lib/discovery/controller.js` 里有 `return prompt.assemble(context)` 这种
  不调用 `next()` 的监听器，会短路后面全部监听器。不 prepend 就会出现
  「插件已加载、日志正常、请求没变」这种最难查的失效。
- cordis 的 waterfall 里 `next` **不接受参数**，改写只能靠监听器**返回值**。
- 内层 `next()` 抛错必须原样抛出，不能吞掉换成旧 assembly ——
  那会把「provider 配置错误」伪装成「提示词不完整」。
- 改写自身出错时返回原 assembly，绝不阻断组装。

## 第 3 层：诊断

`diagnose()` 对每个 provider 发一次最小请求（`max_tokens: 8`，失败不重试），
按 `action` 分类：

| action | 含义 |
|---|---|
| `ok` | 可用 |
| `auto` | 本插件可以自动修 |
| `manual` | 需要你动手（重新登录、去控制台开通） |
| `give-up` | 上游政策变更，修不了 |

### 三个踩过的坑，已写进代码

1. **不能只看 status**。网关会把上游 4xx 包成自己的 502，
   只看状态码会把「协议停用」「额度用尽」都误读成「暂时性故障」。
   必须先读响应体里的真码（`11128` / `APIG.0101` / `TM.00000001` 等）。
2. **不能随便挑模型**。早期版本取模型清单第一个，拿到已下架的 `deepseek-v3.2`，
   把好渠道探成了坏的。现在优先已知可用型号，跳过 `preview|alpha|beta|legacy`。
3. **每渠道只发一次**。429 会被上游计入风控，重试三次等于三次推进同一个坑。

## 第 2 层：自建 adapter（默认关）

codearts 的两条问题（UA、benefit 头）改的是 `pack.js` **内部实现**，
纯 hook 覆盖不到：

- `GenerateOptions = deepFreeze({ ...prepared.config, system, messages, signal })`
  —— 运行期冻死，listener 只能读
- `llm/stream'(options: GenerateOptions, next)` —— 无返回值改写约定
- `agent/request` 契约明写 `cannot mutate messages`

唯一干净的办法是注册同名 provider 接管路由：

```js
ctx.llm.registerAdapter(['codearts'], myAdapter)
```

adapter 是结构化验证（调方法，不做 `instanceof`），`our-free-model` 自己就是这么挂上去的。

**但这条有前置验证未做**：与 `our-free-model` 争同一 provider 时，后注册者是否生效
需实测。若抢不过，退化为「在设置页禁用 our-free-model 的 codearts 后启用本层」。

因此该层**默认关闭**。在此之前，codearts 的修复仍依赖
`D:\DeepSeek Harness\projects\dsh-buddy-fix\scripts\patch-codearts-*.mjs` 打在 `pack.js` 上。

## 验证

```bash
cd channel-guard

# 离线验证核心逻辑（自带 fixture，不依赖本机文件）
node test/offline-check.mjs            # 47 项
node test/codearts-guard-check.mjs     # 19 项
```

离线检查覆盖：真实 38KB prompt 的改写、幂等性、assembly 不可变性、
以及用**真实上游错误体**验证分类器。

## 安装

见 [README](../README.md#安装) 的三步流程。要点重复一次：

1. 插件目录必须是**实体目录**放进 `<profile>/node_modules/channel-guard`
   （软链接会导致加载器不跟随，`fiberPhase` 永远为 null）
2. 必须手动把 `"channel-guard"` 加进 `<profile>/package.json` 的 `dsh.profile.bundles`
   （包管理器不写这里，漏了会静默不加载）
3. 重载后确认 `fiberPhase === 'active'`

装完**必须**把 `channel-guard` 加入 `package.json` 的 `dsh.profile.bundles` 数组。
`pnpm add` 只写 `dependencies`，不写 bundles —— 缺这一步会出现
「插件装上了但完全不生效」，且没有任何报错。

然后重启 DSH（或触发热重载）。

## 已知限制

- 第 2 层（codearts adapter）默认关闭，codearts 的修复仍依赖 `pack.js` 补丁
- 需要重新登录的渠道（codearts 403 账户级、凭据过期）只能报告，不能代劳
- `ccswitch` 有客户端白名单，UA 伪装实测无效，本插件不尝试绕过

## 许可

MIT
