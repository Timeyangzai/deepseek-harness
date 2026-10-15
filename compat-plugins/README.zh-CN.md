# 本地兼容插件

这里保存本机桌面版使用的两个可复现插件副本：

- `dsh-purge`：基于 `1.1.71`（上游提交 `6c1d638d1bdcc45ede50fc30249c753d58122a51`），加入 Harness `0.2.1-alpha.2` 的完整提示词、实时回退、源码桌面入口定位和极简工具配置检查。已有 `working-directory:current` 上下文时不再注入废弃的 `{{cwd}}` 模板，标准和梁神模式均使用宿主的工作目录信息。
- `dsh-liangshen`：基于 `@linxin666/dsh-liangshen@0.4.6`，移除 Harness `0.2.1-alpha.2` 已废弃的子代理后台模式配置。预设由插件注册，旧的 `.agent-presets/liangshen` 应先移到备份目录。

插件目录不包含用户会话、密钥或桌面运行缓存。

上游 dsh-purge 的说明保留 `README.md` / `README.zh-CN.md` 文件名，不参加本仓库的双语配对。其红队模块使用的持久化字段名保持上游定义，列入术语检查的精确文件豁免；本地兼容代码和本说明仍接受检查。

## 桌面配置快照

`desktop-profile/package.json` 记录桌面插件依赖和加载顺序，`desktop-profile/cordis.patch.yml` 记录当前模型与界面设置。中转地址用 `HARNESS_MODEL_BASE_URL` 环境变量代替，密钥只保留 `DEEPSEEK_API_KEY`、`SELF_API_KEY` 引用；启动前设置地址，并在 Harness 的凭证设置中填写密钥。复制配置前先备份目标 profile，完全退出桌面版，将两个兼容插件放入 `$DSH_HOME/local-plugins`，再将模板复制到 `$DSH_HOME/profiles/desktop` 并安装依赖。不要覆盖已有会话或凭证文件。

快照另含 npm 插件 `@jiesou/dsh-opencode-zen-free-provider@0.1.23`，已验证目录加载，实际对话被上游 `FreeTierError` 拒绝；默认模型保留当前选择，复用时需手动切换到可用的提供商。`maxTokens` 和上下文容量也是当前配置快照，不代表所有上游都支持这些数值。

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
