# 本地兼容插件

这里保存本机桌面版使用的三个可复现插件副本：

- `dsh-purge`：基于 `1.1.71`（上游提交 `6c1d638d1bdcc45ede50fc30249c753d58122a51`），加入 Harness `0.2.1-alpha.2` 的完整提示词、实时回退、源码桌面入口定位和极简工具配置检查。已有 `working-directory:current` 上下文时不再注入废弃的 `{{cwd}}` 模板，标准和梁神模式均使用宿主的工作目录信息。
- `dsh-liangshen`：基于 `@linxin666/dsh-liangshen@0.4.6`，移除 Harness `0.2.1-alpha.2` 已废弃的子代理后台模式配置。预设由插件注册，旧的 `.agent-presets/liangshen` 应先移到备份目录。
- `dsh-opencode-zen-free-provider`：基于 `@jiesou/dsh-opencode-zen-free-provider@0.1.24`，保留本地连接修复、原生模型目录编辑器和 DeepSeek 1M / 256K 配置，合入上游的启动目录等待、重试与缓存。安装时也需使用本仓库的 Harness 模型设置界面。

插件目录不包含用户会话、密钥或桌面运行缓存。

上游 dsh-purge 的说明保留 `README.md` / `README.zh-CN.md` 文件名，不参加本仓库的双语配对。其红队模块使用的持久化字段名保持上游定义，列入术语检查的精确文件豁免；本地兼容代码和本说明仍接受检查。

## 桌面配置快照

`desktop-profile/package.json` 记录桌面插件依赖和加载顺序，`desktop-profile/cordis.patch.yml` 记录当前模型与界面设置。中转地址用 `HARNESS_MODEL_BASE_URL` 环境变量代替，密钥只保留 `DEEPSEEK_API_KEY`、`SELF_API_KEY` 引用；启动前设置地址，并在 Harness 的凭证设置中填写密钥。复制配置前先备份目标 profile，完全退出桌面版，将三个兼容插件放入 `$DSH_HOME/local-plugins`，再将模板复制到 `$DSH_HOME/profiles/desktop` 并安装依赖。不要覆盖已有会话或凭证文件。

OpenCode Zen Free 使用本地兼容副本：将 `dsh-opencode-zen-free-provider` 复制到 `$DSH_HOME/local-plugins`，profile 依赖通过 `file:../../local-plugins/dsh-opencode-zen-free-provider` 指向它。默认模型为 `opencode-zen-free-provider / deepseek-v4.1-flash-free`。旧的独立连接补丁保留供原版 npm 包使用，本地副本已含该修复，不需重复应用。

### OpenCode Zen 模型编辑

打开「设置 → 模型 → OpenCode Zen Free → 编辑」，点击模型行右侧展开按钮，即可修改上下文窗口、最大输出 token 数和文本/图片输入类型，支持 `K`、`M` 后缀。保存只写插件的 `models`，不会修改连接参数或密钥；修改会影响后续请求，不中断当前请求。恢复默认模型会移除该覆盖，重新采用插件扫描的目录。手工新增的模型 ID 必须属于当前扫描的免费型号，否则该型号不可调用。

插件每次启动从 `/inference/v1/models` 与 models.dev 读取免费聊天模型，不轮询。目录请求最多尝试三次，每次最长 20 秒，总请求预算 45 秒；成功后的公开元数据写入 `$DSH_HOME/cache/opencode-zen-free-provider-catalog.json`，网络失败时可使用上次成功的目录。首次启动无缓存且读取失败时会记录警告，目录保持为空，不能据此认为模型已可用。

自定义 `models` 数组会替换可选模型列表，不会随上游自动增加型号；「获取可用模型」仍能发现扫描到的新型号，也可「恢复默认模型」后保存以重新使用完整目录。没有聊天元数据或已废弃的条目不会进入列表；`jev-1.13-free` 属于专用 `systemone` 接口，不作为普通聊天模型接入。

DeepSeek V4.1 Flash Free 的本地默认值为 1,000,000 上下文与 256,000 输出上限：合成输入实测 999,803 tokens 正常完成并找回三个位置的标记；免费接口也接受 `max_tokens=256000` 与 `384000` 的短回复请求。后者仅验证参数被接受，未验证连续生成满该长度。OpenCode 模型页标注 384K 输出，其客户端通常以模型目录和 256K 客户端上限的较小值作为默认输出预算；免费型号目录的 32K 不作为本地副本的硬限制。输入和输出仍共用上下文容量，其他型号保持各自目录参数。

## OpenCode Zen 免费车道补丁

本地副本使用 `/inference/v1`，保留显式公开凭证、Accept 头和已有会话标识处理，不发送 `HTTP-Referer` 与 `x-session-affinity`。Muse Spark 使用 Responses，其余聊天型号使用 Chat Completions；原有工具声明会保留，仅补全缺少的 `bash`、`read` 和空参数声明。占位工具不具有执行能力。

独立补丁 `desktop-profile/patches/opencode-zen-free-provider-0.1.23-free-tier-gate.patch` 仅供旧版 npm 包使用，不能重复套在本地 0.1.24 副本上。上游免费服务的访问条件、模型名单和限流可能变化；`FreeTierError` 不是上下文不足，也不等同于用户密钥无效，需按当次返回内容检查。

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
