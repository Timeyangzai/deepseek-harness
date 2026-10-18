# 桌面兼容插件

[English](README.md) | 中文

本目录保存 Harness `0.2.1-rc.2` 使用的三个兼容插件副本和固定版本的 dshmarket 配置，供 Windows 与 macOS 共用。[Desktop](../apps/desktop/README.zh.md) 继续负责平台打包、签名和运行时；这里不包含应用安装包。

## 插件

| 插件 | 版本 | 本地行为 |
| --- | --- | --- |
| dsh-purge | 1.1.71 | 兼容提示词、实时回退和源码桌面入口；排除 #85/#86，保留官方插话与排队；修复红队废弃的子代理配置并保留 maxDepth |
| dsh-liangshen | 0.4.7 | 上游 rc.2 预设支持；保留 Purge 提示词段落 |
| OpenCode Zen Free | 0.1.25 | 原生模型编辑、目录缓存、连接兼容与同模型协议恢复 |
| dshmarket | 1.66.37 | npm 固定版本；在「设置 → 插件市场」管理社区插件 |

来源和校验值见 [versions.json](versions.json)。原样保留的第三方 README 使用上游文件名，不参加主仓库的双语配对。

## Windows / macOS 安装

先按主仓库说明执行 `pnpm install` 和 `pnpm run build`；安装器依赖已构建的 atomic-write 工具。启动一次 Desktop 初始化 profile，然后通过应用菜单完整退出；安装期间保持 Desktop 关闭。

从仓库根目录执行，替换为实际桌面数据目录，不能使用应用安装目录：

```sh
node compat-plugins/install.mjs --dsh-home "/absolute/path/to/dsh-home" --plan
node compat-plugins/install.mjs --dsh-home "/absolute/path/to/dsh-home"
```

Windows 可使用 `"C:/path/to/dsh-home"`，macOS 使用该机器的实际路径。安装器不硬编码用户目录；全部依赖已缓存时可加 `--offline`，`--pnpm-entry` 可指定另一个 `pnpm.mjs`。

安装器备份 manifest、已有 lockfile 和本地插件至 `$DSH_HOME/plugin-backups/compat-*`，复制三个兼容插件，再合并四项依赖和启用列表并运行 pnpm。已有模型配置、凭证、会话及其他插件保持原样；重复运行不重复添加启用项。

pnpm 失败时恢复原 manifest 和已有 lockfile，并报告备份位置；本地插件副本及 node_modules 可能已改变。保持 Desktop 关闭，根据备份修复或解决网络问题后重试；不要认为所有文件均已回滚。

重新启动 Desktop，检查插件市场和已安装插件状态；在 dsh-purge 页面检查并按需应用补丁。梁神预设应可选择，旧的 `.agent-presets/liangshen` 若覆盖插件预设应先移到备份目录。

旧入口 `install-windows.ps1` 仍仅安装破甲和梁神，且只使用离线 pnpm；全部四项请使用统一入口。Desktop 支持 Windows x64、macOS arm64/x64；本次安装器已在 Windows 验证，macOS 实机安装、签名及打包仍需在 Mac 上验证。

## 模型配置

[desktop-profile](desktop-profile/) 提供共享依赖顺序与可选的脱敏模型模板，安装器不自动应用模型模板。地址引用 `HARNESS_MODEL_BASE_URL`，凭证引用 `DEEPSEEK_API_KEY`、`SELF_API_KEY`；不要用本机凭证文件替换模板。模板默认选中 Zen `deepseek-v4.1-flash-free`。

在「设置 → 模型 → OpenCode Zen Free → 编辑」展开模型行，可修改上下文、输出上限和文本/图片输入，容量支持 K/M 后缀。保存只写插件 `models`；恢复默认会移除覆盖并使用扫描目录。显式列表替换可选目录；「获取可用模型」仍可发现新增型号。

DeepSeek Free 默认上下文 1,000,000、输出上限 256,000，输入和输出共享容量；输出值是请求参数，不保证生成满该长度。GLM Flash Free 采用上游 614,400 token 上下文限制。其他型号保留各自目录参数。

目录在挂载时从 Zen 和 models.dev 读取；每个目录最多三次尝试，单次最多 20 秒，总预算 45 秒。成功元数据写入 `$DSH_HOME/cache/opencode-zen-free-provider-catalog.json`；网络失败可使用上次成功缓存，无缓存时记录警告并保留空目录。目录中有模型不代表推理端点当前可用。

## Zen 故障恢复

`upstreamRecovery` 默认开启。所选模型在输出内容前返回结构化服务器或协议错误时，最多再尝试一次同一模型的另一协议。已经输出内容、用户取消、凭证错误、FreeTierError 或额度拒绝均不切换；两个协议都失败时保留最后错误。恢复保持所选模型与配置的容量，不会自动改由另一模型回答，也无法修复上游停机或恢复额度。

```yaml
- id: opencode-zen-free-provider
  config:
    upstreamRecovery: false
```

不提供跨模型 `fallbackModels` 配置；需要其他模型时从选择器明确切换，使实际回答模型与界面选择保持一致。

本地副本已经包含连接和协议恢复修复。`desktop-profile/patches/` 下的补丁用于查看或复现对应版本差异，不要再次套在本地副本上；0.1.23 补丁仅适用于对应旧版 npm 包。

## 验证与本机文件

```sh
node --test compat-plugins/tests/install.test.mjs
node --test compat-plugins/dsh-purge/tests/harness-021.test.mjs compat-plugins/dsh-purge/tests/steering.test.mjs compat-plugins/dsh-purge/tests/redteam-upgrade.test.mjs
pnpm exec vitest run --config compat-plugins/vitest.config.ts
```

自动测试使用独立临时目录、模拟包管理器和网络，不需要缓存或模型密钥；Windows 实际离线安装已单独验证。Windows 通过不能替代 macOS 实机验证。

`output/`、`.playwright-cli/`、`.desktop-build/` 和 `*.dshpurge.bak` 是本机产物，不提交到 Git。代理设置、出口池、会话、凭证及截图留在本机；上传目录不包含这些数据。
