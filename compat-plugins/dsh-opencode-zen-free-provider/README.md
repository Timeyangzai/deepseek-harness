# dsh-opencode-zen-free-provider

OpenCode Zen Free provider for dsh.

[English](README.en.md)

<img height="650" alt="image" src="https://github.com/user-attachments/assets/8cc57d90-76b8-4a7d-a9fe-1ebb39c4f51c" />

本插件可以将 OpenCode Zen 的免费模型接入 dsh 使用。插件启动时从 OpenCode Zen 和 models.dev 同步模型目录，筛选 id 以 `-free` 结尾的模型。挂载会等待有时间上限的首次扫描；扫描失败时使用最近一次成功保存的公开元数据缓存，没有可用缓存时则记录错误并以空目录挂载。

本地兼容副本为 DeepSeek V4.1 Flash 声明 1,000,000 tokens 上下文和 256,000 tokens 输出上限，为 MiMo V2.6 Flash 声明 1,048,576 tokens 上下文，为 GLM 5.3 Flash 声明 614,400 tokens 上下文；其他容量来自 models.dev。这些声明不保证上游当前可用性或实际容量。可以在 DSH 设置中编辑该提供方的模型名称、容量和输入模态；`models: null` 恢复扫描目录，显式数组则替换目录。

## 安装

从 npm 安装（预构建产物，推荐）：

```sh
dsh plugin --profile web add @jiesou/dsh-opencode-zen-free-provider
```

或从 GitHub 安装：

```sh
dsh plugin --profile web add github:jiesou/dsh-opencode-zen-free-provider
```

## 安装之后

模型列表**无需任何配置**，插件启动时会自动从远程同步并过滤所有免费模型。在 Web Models 页面选择 OpenCode Zen Free 和模型后即可开始使用。

免费接口使用匿名凭证 `Bearer public`。本地兼容副本发送 OpenCode CLI User-Agent、在同一对话内复用的时间戳 session id，以及必需的 `bash` 和 `read` 工具声明；省略 `HTTP-Referer` 和 `x-session-affinity`。

## 推理深度（Reasoning effort）

模型只暴露上游声明的档位。**Default** 省略 `reasoning_effort`。只有 chat-completions 目录明确声明 `none` 时才显示 **Off**；其他情况省略不支持的参数。effort 配置为空或只有 toggle 的模型不显示档位选择器。历史 assistant 消息保留已有推理；上游要求推理字段而该轮没有推理时，发送空的 `reasoning_content`。

## 错误提示

OpenCode Zen 把非凭证类拒绝（免费额度到期、区域限制等）以 HTTP 401/403 返回，dssharness 会把这些状态码归类为"API Key 无效"。本插件在终端错误事件里保留真实原因，让真因显示出来；真正的鉴权失败仍按 AUTH 走。无法解析的内容原样透传。

`upstreamRecovery: true`（默认）允许在尚未输出内容时，针对结构化的服务器或协议拒绝，以同一模型的另一种协议再尝试一次；所选模型和配置容量保持不变。鉴权、免费层准入、额度拒绝、取消和已经输出部分内容的失败均不会触发该恢复。最终拒绝仍会显示；上游无法提供所选模型时，请手动选择其他模型。

提示：OpenCode 的 Free 模型会被基于 IP 限流。

对于 Ox Alpha 等经常遇到"network errors"等问题的模型，建议手动设置：

```yaml
- id: opencode-zen-free-provider
  name: '@jiesou/dsh-opencode-zen-free-provider'
  config:
    retryPolicy:
      mode: always
    maxRequestImageBytes: 2097152
    requestImageMaxBytes: 1048576
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `retryPolicy` | `object` | 省略即用普通默认 | 模型请求重试策略 |
| `maxRequestImageBytes` | `number` | `2097152`（2 MiB） | 单次请求允许内联的 base64 图片字节上限 |
| `requestImageMaxBytes` | `number` | `1048576`（1 MiB） | 单张图片重编码后的字节上限 |

## 图片预算

Zen 这条 wire 是无状态的：每轮请求都要把历史重新发一遍，留在上下文里的图片因此每轮都会再传一次。

- 每张图片先归一化（2048×2048 像素总预算），再重编码到 `requestImageMaxBytes`（默认 1 MiB）以内。
- 一轮请求内联的 base64 图片总量超过 `maxRequestImageBytes`（默认 2 MiB）时，不发请求，而是抛出 `IMAGE_OFFLOAD_REQUIRED` 并报出需要 offload 的张数。DSH 据此把**最旧**的图片记入 `image/offload` 事件并重试；之后每轮用占位文本代替这些图片的字节，模型仍能从占位文本里读到图片身份和可读路径。
- 已经 offload 的图片不再读取字节、不再编码、不再上传。

两个值都是 base64 口径（约等于原图字节 ×4/3）。默认组合约等于"一张整尺寸图 + 一张半尺寸图"。想让模型一次看更多图就调大，想省流量就调小；但 `maxRequestImageBytes` 必须大于单张的 base64 长度（1 MiB 图约 1.4 MB），否则一张图也放不下。

## License

[MIT](LICENSE)
