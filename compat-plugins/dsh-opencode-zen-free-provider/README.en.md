# dsh-opencode-zen-free-provider

OpenCode Zen Free provider for dsh.

[简体中文](README.md)

<img height="650" alt="image" src="https://github.com/user-attachments/assets/8cc57d90-76b8-4a7d-a9fe-1ebb39c4f51c" />

This plugin adds OpenCode Zen's free models to dsh. At startup it syncs the OpenCode Zen and models.dev catalogs and exposes the models whose ids end in `-free`. Mounting awaits the bounded initial scan. A failed scan uses the last successful public-metadata cache; without a usable cache, the plugin logs the failure and mounts with an empty catalog.

The local compatible copy declares a 1,000,000-token context and 256,000-token output limit for DeepSeek V4.1 Flash, a 1,048,576-token context for MiMo V2.6 Flash, and a 614,400-token context for GLM 5.3 Flash. Other limits come from models.dev. These declarations do not guarantee upstream availability or capacity. Edit the provider's models in DSH settings to override its name, capacities or input modalities; `models: null` restores the scanned catalog, while an explicit array replaces it.

## Install

From npm (prebuilt, recommended):

```sh
dsh plugin --profile web add @jiesou/dsh-opencode-zen-free-provider
```

Or from GitHub:

```sh
dsh plugin --profile web add github:jiesou/dsh-opencode-zen-free-provider
```

## After install

The free endpoint uses the anonymous `Bearer public` credential. The local compatible copy sends the OpenCode CLI User-Agent, timestamp-based session ids reused within one conversation, and the required `bash` and `read` tool schemas. It omits `HTTP-Referer` and `x-session-affinity`.

No model configuration is needed. Pick the OpenCode Zen Free provider and a model on the Web Models page to start using it.

## Reasoning effort

A model exposes exactly the levels the upstream feed declares. **Default** omits `reasoning_effort`. **Off** appears only when the chat-completions feed declares `none`; otherwise the plugin omits the unsupported parameter. Models with an empty effort entry or only a `toggle` expose no level selector. Replayed assistant messages preserve existing reasoning and include an empty `reasoning_content` when the upstream requires it and no reasoning was produced.

## Error reporting

OpenCode Zen returns non-credential refusals (ended free promotions, region blocks, …) as HTTP 401/403, which dsh otherwise classifies as "invalid API key". The plugin preserves the real reason in the terminal error event; genuine auth failures still surface as AUTH. Anything unparseable passes through verbatim — the original error is never swallowed.

With `upstreamRecovery: true` (the default), a structured server or protocol refusal may trigger one attempt on the same model's alternate protocol, before any content is emitted. The selected model and configured capacities remain unchanged. Authentication, free-tier admission, quota refusals, cancellation and failures after partial content do not trigger that recovery. A final refusal remains visible; select another model manually when the upstream cannot serve the selected model.

## Image budget

The Zen wire is stateless: every request re-sends the history, so every image left in context is uploaded again on every turn.

- Each image is normalized first (2048×2048 pixel budget), then re-encoded to fit `requestImageMaxBytes` (1 MiB by default).
- When the inline base64 images of one request exceed `maxRequestImageBytes` (2 MiB by default), no request is sent; the adapter throws `IMAGE_OFFLOAD_REQUIRED` naming how many occurrences must be offloaded. DSH records the **oldest** ones in an `image/offload` event and retries; from then on their bytes are replaced by placeholder text that still names the image identity and a readable path.
- Already-offloaded images are never read, re-encoded, or uploaded again.

```yaml
- id: opencode-zen-free-provider
  name: '@jiesou/dsh-opencode-zen-free-provider'
  config:
    retryPolicy:
      mode: always
    maxRequestImageBytes: 2097152
    requestImageMaxBytes: 1048576
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `retryPolicy` | `object` | normal defaults when omitted | Per-request retry policy |
| `maxRequestImageBytes` | `number` | `2097152` (2 MiB) | Inline base64 image budget for one request |
| `requestImageMaxBytes` | `number` | `1048576` (1 MiB) | Per-image budget after re-encoding |

Both values count base64 characters (about 4/3 of the raw bytes). The default pair holds one full-size image plus one half-size image; raise them to show the model more images at once, lower them to save bandwidth — but keep `maxRequestImageBytes` above one image's base64 length (a 1 MiB image is ~1.4 MB), or not even one image fits.

## License

[MIT](LICENSE)
