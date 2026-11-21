---
kind: upgrade-guide
description: "The optional Desktop compatibility profile no longer installs or selects OpenCode Zen Free."
---

# OpenCode Zen Free leaves the Desktop compatibility profile

English | [中文](guide.zh.md)

## Change

The `compat-plugins/desktop-profile` template no longer depends on `@jiesou/dsh-opencode-zen-free-provider` or selects `opencode-zen-free-provider` as its default model. The base bundle's default model remains in place. Existing Desktop profiles retain their installed package and model selection until changed.

## Migration

1. Fully exit Desktop and back up `$DSH_HOME/profiles/desktop/package.json`, `pnpm-lock.yaml`, and `cordis.patch.yml`.
2. Remove `@jiesou/dsh-opencode-zen-free-provider` from `dependencies` and `dsh.profile.bundles` in `package.json`. In `cordis.patch.yml`, remove an `agent-default-model` override that selects `opencode-zen-free-provider`, or replace it with an installed provider and model.
3. With Node.js 24.9 or newer, run `pnpm --dir <profile-directory> install --optimistic-repeat-install=false`, replacing `<profile-directory>` with the absolute path to `$DSH_HOME/profiles/desktop`. Start Desktop and confirm OpenCode Zen Free is absent from Plugins and the selected model belongs to an installed provider.
