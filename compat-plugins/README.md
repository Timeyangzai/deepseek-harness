# Desktop compatibility plugins

English | [中文](README.zh.md)

This directory contains three compatible plugin copies for Harness `0.2.1-rc.2` and pinned dshmarket configuration shared by Windows and macOS. [Desktop](../apps/desktop/README.md) owns platform packaging, signing and runtimes; application installers are not included here.

## Plugins

| Plugin | Version | Local behavior |
| --- | --- | --- |
| dsh-purge | 1.1.71 | Adapts prompts, live rollback and source Desktop launch; excludes #85/#86 to retain official steering and queuing; repairs retired redteam subagent fields while retaining maxDepth |
| dsh-liangshen | 0.4.7 | Upstream rc.2 preset support; retains Purge prompt sections |
| OpenCode Zen Free | 0.1.25 | Native model editing, catalog caching, connection compatibility and same-model protocol recovery |
| dshmarket | 1.66.37 | Pinned npm version; manage community plugins in Settings → Plugin Market |

See [versions.json](versions.json) for origins and checksums. Unmodified third-party READMEs retain upstream filenames and are outside the main repository's bilingual pairing.

## Windows / macOS installation

Follow the main repository instructions to run `pnpm install` and `pnpm run build`; the installer requires the built atomic-write utility. Start Desktop once to initialize its profile, then fully quit through the application menu; keep Desktop closed during installation.

Run from the repository root, replacing the example with the actual Desktop data directory rather than the application installation directory:

```sh
node compat-plugins/install.mjs --dsh-home "/absolute/path/to/dsh-home" --plan
node compat-plugins/install.mjs --dsh-home "/absolute/path/to/dsh-home"
```

Windows accepts `"C:/path/to/dsh-home"`; use the actual path on macOS. No user directory is hardcoded. Add `--offline` when every dependency is cached; `--pnpm-entry` selects another `pnpm.mjs`.

The installer backs up the manifest, existing lockfile and local plugins to `$DSH_HOME/plugin-backups/compat-*`, copies three compatible plugins, then merges four dependencies and bundle selections and runs pnpm. Existing model settings, credentials, sessions and other plugins remain unchanged; repeated runs do not duplicate selections.

If pnpm fails, the original manifest and previous lockfile are restored and the backup location is reported; local plugin copies and node_modules may have changed. Keep Desktop closed and repair from the backup or resolve the network issue before retrying; do not assume every file was rolled back.

Restart Desktop and check Plugin Market and installed plugin status; check and apply dsh-purge patches as needed. LiangShen presets should be selectable; move an old `.agent-presets/liangshen` directory to a backup if it overrides plugin presets.

The legacy `install-windows.ps1` still installs only Purge and LiangShen with offline pnpm; use the shared entry for all four. Desktop supports Windows x64 and macOS arm64/x64. This installer was exercised on Windows; macOS installation, signing and packaging still require verification on a Mac.

## Model configuration

[desktop-profile](desktop-profile/) contains shared dependency ordering and an optional sanitized model template; the installer does not apply that template. Addresses reference `HARNESS_MODEL_BASE_URL`; credentials reference `DEEPSEEK_API_KEY` and `SELF_API_KEY`. Never replace the template with a local credential file. It selects Zen `deepseek-v4.1-flash-free` by default.

Expand a row in Settings → Models → OpenCode Zen Free → Edit to change context, output capacity and text/image inputs; capacities accept K/M suffixes. Saving changes only the plugin's `models`; restoring defaults removes the override and uses the scanned catalog. An explicit list replaces the selectable catalog; Get available models still discovers additions.

DeepSeek Free defaults to 1,000,000 context and 256,000 output tokens, sharing capacity between input and output. The output value is a request parameter, not a guarantee that generation can fill it. GLM Flash Free uses the upstream 614,400-token context limit. Other models use their own catalog settings.

Mounting reads Zen and models.dev catalogs with at most three attempts per feed, 20 seconds per attempt and a 45-second total budget. Successful metadata is saved in `$DSH_HOME/cache/opencode-zen-free-provider-catalog.json`; network failures can use the last successful cache. Without a cache, failure is warned and the catalog stays empty. Catalog presence does not establish current inference availability.

## Zen recovery

`upstreamRecovery` defaults to enabled. A structured server or protocol refusal before content starts permits at most one attempt on the selected model's alternate protocol. Content already emitted, cancellation, credential failures, FreeTierError and quota refusals do not switch protocols; exhaustion preserves the last error. Recovery retains the selected model and configured capacities, never silently uses another model, and cannot repair upstream outages or replenish usage.

```yaml
- id: opencode-zen-free-provider
  config:
    upstreamRecovery: false
```

Cross-model `fallbackModels` configuration is not provided. Select another model explicitly to keep actual model use consistent with UI selection.

The local copy includes connection and protocol recovery fixes. Patches under `desktop-profile/patches/` document or reproduce the corresponding version's differences; do not apply them again to the local copy. The 0.1.23 patch applies only to that older npm package.

## Verification and local files

```sh
node --test compat-plugins/tests/install.test.mjs
node --test compat-plugins/dsh-purge/tests/harness-021.test.mjs compat-plugins/dsh-purge/tests/steering.test.mjs compat-plugins/dsh-purge/tests/redteam-upgrade.test.mjs
pnpm exec vitest run --config compat-plugins/vitest.config.ts
```

Automated tests use private temporary directories, deterministic package-manager fixtures and mocked network calls; they require neither cached packages nor a model key. A real Windows offline installation was verified separately. Windows results do not replace macOS hardware verification.

`output/`, `.playwright-cli/`, `.desktop-build/` and `*.dshpurge.bak` are local artifacts excluded from Git. Proxy settings, egress pools, sessions, credentials and screenshots stay local; the published directory contains none of those data.
