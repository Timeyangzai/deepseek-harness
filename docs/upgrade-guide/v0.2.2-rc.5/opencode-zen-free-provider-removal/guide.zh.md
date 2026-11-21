---
kind: upgrade-guide
description: "可选 Desktop 兼容 profile 不再安装或选用 OpenCode Zen Free。"
---

# OpenCode Zen Free 从 Desktop 兼容 profile 中移除

[English](guide.md) | 中文

## 变更

`compat-plugins/desktop-profile` 模板不再依赖 `@jiesou/dsh-opencode-zen-free-provider`，也不再选用 `opencode-zen-free-provider` 作为默认模型。基础 bundle 的默认模型保持有效。已有 Desktop profile 会保留已安装的插件和模型选择，直到用户主动修改。

## 迁移

1. 完整退出 Desktop，并备份 `$DSH_HOME/profiles/desktop/package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml`。
2. 在 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 中删除 `@jiesou/dsh-opencode-zen-free-provider`。在 `cordis.patch.yml` 中删除选用 `opencode-zen-free-provider` 的 `agent-default-model` 覆盖项，或改成已安装的服务商和模型。
3. 使用 Node.js 24.9 或更新版本运行 `pnpm --dir <profile-directory> install --optimistic-repeat-install=false`，将 `<profile-directory>` 换成 `$DSH_HOME/profiles/desktop` 的绝对路径。启动 Desktop，确认“插件”中没有 OpenCode Zen Free，且所选模型属于已安装的服务商。
