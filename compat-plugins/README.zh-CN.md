# 本地兼容插件

这里保存本机桌面版使用的两个可复现插件副本：

- `dsh-purge`：加入了 DeepSeek Harness `0.1.6-alpha.2` 的补丁匹配规则。
- `dsh-liangshen`：基于 `@linxin666/dsh-liangshen@0.3.24`，把已移除的
  `@deepseek-ai/dsh-workflow-worker-thread` 替换为 0.1.6 自带的
  `@deepseek-ai/dsh-workflow-ptc`。

插件目录不包含用户会话、模型设置、密钥或桌面运行缓存。

## Windows 安装

在 Windows x64 上构建或安装 Harness 后，从仓库根目录运行：

```powershell
pwsh -NoProfile -File .\compat-plugins\install-windows.ps1 `
  -DshHome "你的 dsh-home 完整路径"
```

脚本会把两个插件复制到 `dsh-home/local-plugins`，写入 Desktop profile，
然后运行 `pnpm install --offline`。完成后完整退出并重新启动 Harness。

首次安装后进入「插件」中的 dsh-purge 页面，点击应用并重启。梁神模式应在
「设置 → Agent 预设」中显示，且不应出现“加载失败”。

如果 `pnpm` 不在 PATH，可通过 `-PnpmCommand` 传入 `pnpm.cmd` 的完整路径。

## 注意

- 当前桌面发布目标是 Windows x64，不是 Windows ARM64。
- 这些兼容修改按 Harness `0.1.6-alpha.2` 验证；升级 Harness 或插件后需要重新检查。
- 不要提交 `*.dshpurge.bak`、`dsh-home`、会话目录或包含访问令牌的配置文件。
