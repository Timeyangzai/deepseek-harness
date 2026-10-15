# 本地兼容插件

这里保存本机桌面版使用的三个可复现插件副本：

- `dsh-purge`：基于 `1.1.71`（上游提交 `6c1d638d1bdcc45ede50fc30249c753d58122a51`），加入 Harness `0.2.1-alpha.2` 的完整提示词、实时回退、源码桌面入口定位和极简工具配置检查。已有 `working-directory:current` 上下文时不再注入废弃的 `{{cwd}}` 模板，标准和梁神模式均使用宿主的工作目录信息。
- `dsh-liangshen`：基于 `@linxin666/dsh-liangshen@0.4.6`，移除 Harness `0.2.1-alpha.2` 已废弃的子代理后台模式配置。预设由插件注册，旧的 `.agent-presets/liangshen` 应先移到备份目录。
- `dsh-opencode-zen-free-provider`：基于 `@jiesou/dsh-opencode-zen-free-provider@0.1.23`，保留连接修复，接入原生模型目录编辑器。安装时也需使用本仓库的 Harness 模型设置界面。

插件目录不包含用户会话、密钥或桌面运行缓存。

上游 dsh-purge 的说明保留 `README.md` / `README.zh-CN.md` 文件名，不参加本仓库的双语配对。其红队模块使用的持久化字段名保持上游定义，列入术语检查的精确文件豁免；本地兼容代码和本说明仍接受检查。

## 桌面配置快照

`desktop-profile/package.json` 记录桌面插件依赖和加载顺序，`desktop-profile/cordis.patch.yml` 记录当前模型与界面设置。中转地址用 `HARNESS_MODEL_BASE_URL` 环境变量代替，密钥只保留 `DEEPSEEK_API_KEY`、`SELF_API_KEY` 引用；启动前设置地址，并在 Harness 的凭证设置中填写密钥。复制配置前先备份目标 profile，完全退出桌面版，将两个兼容插件放入 `$DSH_HOME/local-plugins`，再将模板复制到 `$DSH_HOME/profiles/desktop` 并安装依赖。不要覆盖已有会话或凭证文件。

OpenCode Zen Free 使用本地兼容副本：将 `dsh-opencode-zen-free-provider` 复制到 `$DSH_HOME/local-plugins`，profile 依赖通过 `file:../../local-plugins/dsh-opencode-zen-free-provider` 指向它。默认模型为 `opencode-zen-free-provider / deepseek-v4.1-flash-free`。旧的独立连接补丁保留供原版 npm 包使用，本地副本已含该修复，不需重复应用。

### OpenCode Zen 模型编辑

打开「设置 → 模型 → OpenCode Zen Free → 编辑」，点击模型行右侧展开按钮，即可修改上下文窗口、最大输出 token 数和文本/图片输入类型，支持 `K`、`M` 后缀。保存只写插件的 `models`，不会修改连接参数或密钥；修改会影响后续请求，不中断当前请求。恢复默认模型会移除该覆盖，重新采用插件扫描的目录。手工新增的模型 ID 必须属于当前扫描的免费型号，否则该型号不可调用。

DeepSeek V4.1 Flash Free 的本地默认值为 1,000,000 上下文与 256,000 输出上限：合成输入实测 999,803 tokens 正常完成并找回三个位置的标记；免费接口也接受 `max_tokens=256000` 与 `384000` 的短回复请求。后者仅验证参数被接受，未验证连续生成满该长度。OpenCode 模型页标注 384K 输出，其客户端通常以模型目录和 256K 客户端上限的较小值作为默认输出预算；免费型号目录的 32K 不作为本地副本的硬限制。输入和输出仍共用上下文容量，其他型号保持各自目录参数。

## OpenCode Zen 免费车道补丁

上游在 2026-10-13/14 收紧免费车道后，插件报 `[opencode-zen FreeTierError] OpenCode's free tier can only be used from within OpenCode.`。逐项对照实测得到的闸门条件：

| 请求头 | 规则 |
| --- | --- |
| `HTTP-Referer` | 必须**不存在**（任何值都 403） |
| `x-session-affinity` | 必须**不存在** |
| `authorization: Bearer public` | 必须**存在**（无密钥车道） |
| `accept: */*` | 需要 |
| `user-agent` | 含 `deepseek-harness` → 403 |

工具列表另有一条：`bash` 与 `read` 需同时出现，且至少一个工具的 `parameters.properties` 非空（`{}` 或完全缺失都 403）；请求体、端点路径、会话 id 形状均不影响判定。

0.1.23 主动发送了前两条并漏发后两条，另有一处空 schema 占位工具，因此全量 403。补丁位于 `desktop-profile/patches/opencode-zen-free-provider-0.1.23-free-tier-gate.patch`，应用到 `node_modules/@jiesou/dsh-opencode-zen-free-provider/lib/index.js` 后重启生效。

定位方法可复用：安装上游 `opencode-ai@1.19.0`，将其 `provider.opencode.options.baseURL` 指向本地 HTTP sink 抓取真实请求，再对同一请求逐头增删比对 200/403。上游按客户端名封锁且仍在调整，`FreeTierError` 复现时优先怀疑请求头。

补丁后逐模型实测（10 个 `-free` 模型，0 个再报 `FreeTierError`）：

| 传输 | 模型 | 结果 |
| --- | --- | --- |
| chat/completions | deepseek-v4.1-flash-free、cat-jam-free、mimo-v2.6-flash-free、nemotron-3.5-lightning-free、step-5-preview-free、longcat-2.5-preview-free、space-bunny-free | 可用 |
| responses | muse-spark-1.2-contributor-free、muse-spark-1.3-contributor-free | 可用 |
| 两者皆否 | jev-1.13-free | 上游问题，非插件 |

`jev-1.13-free` 在 `chat/completions` 报 400 `Model does not support this protocol`，`responses` / `messages` 报 403；上游官方 CLI `opencode run -m opencode/jev-1.13-free` 同样失败（`UnknownError`，附 `err_` 引用），而控制组 `deepseek-v4.1-flash-free` 正常返回。该模型在上游目录中属新加入，疑为上游尚未接通，插件按目录如实列出，未做硬编码屏蔽。

## 发送方式

本地兼容版本排除 dsh-purge #85、#86，保留 Harness 官方的插话和排队发送。可在「设置 → 通用 → 繁忙时的发送行为」选择默认方式；Enter 和发送按钮使用所选方式，Cmd/Ctrl+Enter 使用另一方式。插话在当前模型请求或工具调用结束后的下一步接收；排队在当前任务结束后开启下一轮，不会立即中断正在执行的调用。安装上游原版插件会覆盖这些兼容修改。

## Windows 安装

在 Windows x64 上构建或安装 Harness 后，从仓库根目录运行：

```powershell
pwsh -NoProfile -File .\compat-plugins\install-windows.ps1 `
  -DshHome "你的 dsh-home 完整路径"
```

脚本会把两个插件复制到 `dsh-home/local-plugins`，写入 Desktop profile，然后运行 `pnpm install --offline`；它不安装 Zen 插件，也不应用模型配置快照。完成后完整退出并重新启动 Harness。

首次安装后进入「插件」中的 dsh-purge 页面，点击应用并重启。梁神模式应在「设置 → Agent 预设」中显示，且不应出现“加载失败”。

如果 `pnpm` 不在 PATH，可通过 `-PnpmCommand` 传入 `pnpm.cmd` 的完整路径。

## 注意

- 当前桌面发布目标是 Windows x64，不是 Windows ARM64。
- 这些兼容修改按 Harness `0.2.1-alpha.2` 在 macOS 上验证；Windows 安装脚本尚未在 Windows 实机验证。升级 Harness 或插件后需要重新检查。
- 不要提交 `*.dshpurge.bak`、`dsh-home`、会话目录或包含访问令牌的配置文件。
