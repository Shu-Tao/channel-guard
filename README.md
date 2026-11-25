# channel-guard

一键修复 DSH 渠道「模型无法使用」的插件。

## 现在能做什么

| 渠道 | 问题 | 状态 |
|---|---|---|
| buddy | system 文本指纹被上游拒绝（400 / code 11128） | ✅ **插件已独立接管**（pack.js 补丁已撤，实测 200） |
| codearts | user-agent 被拦截（403）、benefit 头失效（404） | ⚠️ 仍依赖 pack.js 补丁，第 2 层开关未启用 |
| 全渠道 | — | ✅ 诊断服务，按「可自动修 / 需你动手 / 修不了」分类 |

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
   "dsh": { "profile": { "bundles": [ ... , "channel-guard" ] } }
   ```
2. **不要用软链接**。`link:` 装出来是 symlink，DSH 加载器不跟随，
   表现为 `plugin_manager` 里 `enabled: true` 但 `fiberPhase: null`（永不激活）。
   改成实体目录：
   ```bash
   cd "C:/Users/25759/.dsh/profiles/desktop"
   rm node_modules/channel-guard
   cp -r "D:/DeepSeek Harness/projects/channel-guard" node_modules/channel-guard
   ```

然后切一次开关强制重载：

```
plugin_manager set_plugin include:channel-guard enabled:false
plugin_manager set_plugin include:channel-guard enabled:true
```

确认 `fiberPhase` 变成 `active` 才算装好。

## 验证

```bash
cd "D:/DeepSeek Harness/projects/channel-guard"
"$NODE" test/offline-check.mjs                       # 内置 fixture，47 项断言
"$NODE" test/offline-check.mjs --fixture <你的txt>    # 用真实 system 文本再验一次
```

测试自带一份合成 fixture（含上游两条指纹），克隆下来就能跑，不依赖任何本地文件。

端到端验证（撤掉 pack.js 的 buddy 补丁后仍应 200）：

```bash
# 撤补丁
sed -i 's/buddyGuardText(contentToText2(message2.content))/contentToText2(message2.content)/' \
  "C:/Users/25759/.dsh/profiles/desktop/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js"
# 热重载后测 buddy，期望 200
```

## 详细设计

见 [docs/DETAIL.md](docs/DETAIL.md)，包含：
- 为什么按**内容**而非 provider 过滤（社区插件因此失效的根因）
- 上游两条指纹规则与必须在两处都改的实测依据
- `{ global: true, prepend: true }` 的必要性（否则被 dsh-ops 短路）
- 诊断器的三个防坑设计

## 已知限制

- 第 2 层（codearts adapter）未启用：与 `our-free-model` 争同一 provider 路由，
  后注册者是否生效需实测。在此之前 codearts 靠 pack.js 补丁。
- 需要重新登录的渠道（凭据过期、账户级 403）只能报告，不能代劳。
- `ccswitch` 有客户端白名单，UA 伪装实测无效，不尝试绕过。

## 许可

MIT
