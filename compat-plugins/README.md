# Desktop compatibility plugins

English | [中文](README.zh.md)

This directory contains one compatible plugin copy, a pinned dsh-purge Community archive and six pinned npm plugins for Harness `0.2.2-rc.5`, shared by Windows and macOS. [Desktop](../apps/desktop/README.md) owns platform packaging, signing and runtimes; application installers are not included here.

## Plugins

| Plugin | Version | Local behavior |
| --- | --- | --- |
| dsh-purge Community | 1.7.20 | Installs the pinned [community release](https://github.com/kingcharleslzy-ai/dsh-purge/releases/tag/v1.7.20) in place of the legacy dsh-purge bundle |
| dsh-liangshen | 0.4.20 | Retains Purge prompt sections in the LiangShen preset |
| dshmarket | 1.74.0 | Manage community plugins in Settings → Plugin Market |
| billion-context | 0.1.216 | Preserve existing context settings |
| dsh-free-search | 0.9.78 | Preserve existing search settings |
| dsh-rewind-plugin | 0.23.0 | Preserve existing rewind settings |
| dsh-goal | 0.2.46 | Installed dependency; not enabled by the shared profile |
| dsh-input-traffic | 0.7.17 | Interrupt, steer or queue a message while a turn is running |

See [versions.json](versions.json) for origins and checksums. Unmodified third-party READMEs retain upstream filenames and are outside the main repository's bilingual pairing.

## Windows / macOS installation

Use Node.js 24.9 or newer and follow the main repository instructions to run `pnpm install` and `pnpm run build`; the installer requires the built atomic-write utility. Start Desktop `0.2.2-rc.5` once to initialize its profile, then fully quit through the application menu; keep Desktop closed during installation.

Run from the repository root, replacing the example with the actual Desktop data directory rather than the application installation directory:

```sh
node compat-plugins/install.mjs --dsh-home "/absolute/path/to/dsh-home" --plan
node compat-plugins/install.mjs --dsh-home "/absolute/path/to/dsh-home"
```

Windows accepts `"C:/path/to/dsh-home"`; use the actual path on macOS. No user directory is hardcoded. Add `--offline` when every dependency is cached; `--pnpm-entry` selects another `pnpm.mjs`.

The installer backs up the manifest, existing lockfile and local plugins to `$DSH_HOME/plugin-backups/compat-*`, copies one compatible plugin and the SHA-256-checked community archive, then merges eight dependencies and the template’s selected bundles and runs pnpm. It removes the legacy `dsh-purge` and retired `@deepseek-ai/dsh-experimental-agent-team-profile` dependencies and bundle selections. Existing model settings, credentials, sessions and other plugins remain unchanged; repeated runs do not duplicate selections.

If pnpm fails, the original manifest and previous lockfile are restored and the backup location is reported; local plugin copies and node_modules may have changed. Keep Desktop closed and repair from the backup or resolve the network issue before retrying; do not assume every file was rolled back.

Restart Desktop and check Plugin Market and installed plugin status; check and apply dsh-purge patches as needed. The package installation does not establish host patch compatibility with this checkout's `0.2.2-rc.5`. LiangShen presets should be selectable; move an old `.agent-presets/liangshen` directory to a backup if it overrides plugin presets.

The legacy `install-windows.ps1` still installs the archived Purge 1.1.71 and LiangShen with offline pnpm; use the shared entry for the current set. Desktop supports Windows x64 and macOS arm64/x64. macOS installation, signing and packaging require verification on a Mac.

## Busy-time input

[dsh-input-traffic](https://github.com/drscrewdriver/dsh-input-traffic) sets plain Enter to queue messages while a turn is running. Send the message, then choose its queue-row action:

- Red, **Interrupt and send**: stop the current turn and send this message as a new turn.
- Yellow, **Send after action**: process the message after the current step finishes.
- Green, **Queue for next turn**: wait until the current turn finishes; this is the default for plain Enter.

Interrupting preserves completed actions and any output already shown.

After updating billion-context, fully quit and restart Desktop to reload model-capacity metadata. Actual output capacity depends on the selected provider and model.

## Purge backup and recovery

The installer uses the [dsh-purge Community 1.7.20 archive](archives/dsh-purge-community-1.7.20.tgz), whose SHA-256 is recorded in [versions.json](versions.json). The [Purge 1.1.71 archive](archives/dsh-purge-1.1.71-compatible-20261023.tgz) contains 104 runtime files from the [legacy compatible source copy](dsh-purge/), including original attribution and license notices. Its [backup manifest](archives/manifest.json) records archive and file checksums. The original upstream repository is unavailable; the legacy archive remains for recovery.

For Desktop, use the installation steps above. To install the legacy archive into a separate custom profile, run this command from the repository root; replace `recovery-check` with the intended profile name:

```sh
pnpm dsh plugin --profile recovery-check add ./compat-plugins/archives/dsh-purge-1.1.71-compatible-20261023.tgz --offline --ignore-scripts
```

This command installs and selects the bundle without starting its Host plugin. A fresh isolated profile installation was verified offline; pnpm reported a peer-dependency warning. The backup contains plugin code, not personal settings, credentials, sessions or dependency trees.

## Model configuration

[desktop-profile](desktop-profile/) contains shared dependency ordering and an optional sanitized model template; the installer does not apply that template. Addresses reference `HARNESS_MODEL_BASE_URL`; credentials reference `DEEPSEEK_API_KEY` and `SELF_API_KEY`. Never replace the template with a local credential file. The template leaves the base bundle's default model unchanged.

Existing Desktop profiles keep an earlier OpenCode Zen Free installation until it is removed from their package manifest and default-model override; follow the [migration steps](../docs/upgrade-guide/v0.2.2-rc.5/opencode-zen-free-provider-removal/guide.md).

## Verification and local files

```sh
node --test compat-plugins/tests/install.test.mjs
node --test compat-plugins/dsh-purge/tests/harness-021.test.mjs compat-plugins/dsh-purge/tests/steering.test.mjs compat-plugins/dsh-purge/tests/redteam-upgrade.test.mjs
```

Automated tests use private temporary directories, deterministic package-manager fixtures and mocked network calls; they require neither cached packages nor a model key.

`output/`, `.playwright-cli/`, `.desktop-build/` and `*.dshpurge.bak` are local artifacts excluded from Git. Proxy settings, egress pools, sessions, credentials and screenshots stay local; the published directory contains none of those data.
