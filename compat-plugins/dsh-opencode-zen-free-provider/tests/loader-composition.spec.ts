/** Loader-backed Zen settings persist model edits and reach the real adapter metadata. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { profileComposition } from '../../../packages/settings/settings/tests/profile-composition.ts'
import * as Zen from '../lib/index.js'

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const provider = 'opencode-zen-free-provider'
const id = 'deepseek-v4.1-flash-free'

type CatalogModel = {
  name: string
  limit: { context: number; output: number }
  modalities: { input: string[] }
  status?: string
  reasoning_options?: { type: string; values: string[] }[]
}
type Options = {
  extraModels?: Record<string, CatalogModel>
  unavailable?: boolean
  cached?: string
  expectedCount?: number
  failFirst?: boolean
  inference?: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>
}

async function composition(options: Options = {}) {
  root = await mkdtemp(join(tmpdir(), 'dsh-zen-settings-'))
  vi.stubEnv('DSH_HOME', root)
  const cachePath = join(root, 'cache', `${provider}-catalog.json`)
  if (options.cached !== undefined) {
    await mkdir(join(root, 'cache'))
    await writeFile(cachePath, options.cached)
  }
  const models = {
    [id]: { name: 'DeepSeek V4.1 Flash Free', limit: { context: 200000, output: 32000 }, modalities: { input: ['text', 'image'] } },
    ...options.extraModels,
  }
  let attempts = 0
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === 'https://unpkg.com/opencode-ai@latest/package.json') return Response.json({ version: '1.19.0' })
    if (url === 'https://opencode.ai/inference/v1/models') {
      attempts++
      if (options.unavailable || (options.failFirst && attempts === 1)) return Response.json({}, { status: 503 })
      return Response.json({ data: [...Object.keys(models), 'jev-1.13-free', 'paid-model'].map(id => ({ id })) })
    }
    if (url === 'https://models.dev/api.json') return Response.json({ opencode: { models } })
    if (url === 'https://opencode.ai/inference/v1/chat/completions' && options.inference !== undefined) return options.inference(input, init)
    throw new Error(`Unexpected test request: ${input}`)
  })
  vi.stubGlobal('fetch', fetch)
  const config = join(root, 'cordis.yml')
  await writeFile(config, '- id: llm\n  name: test-llm\n- id: zen-custom-entry\n  name: test-zen\n')
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['test-llm', LlmRuntime], ['test-zen', Zen]])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: async specifier => {
      if (!modules.has(specifier)) throw new Error(`Unexpected test module: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('Unexpected module registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job') },
    resolveSync(): never { throw new Error('Unexpected resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  const patchPath = await profileComposition(ctx, root, config)
  for (const entry of ctx.configEditor.entries()) await entry.fiber?.await()
  expect(await ctx.llm.listModels(provider)).toHaveLength(options.expectedCount ?? 1)
  return { ctx, patchPath, cachePath, cacheDir: join(root, 'cache'), fetch }
}

it('publishes an editable schema, saves capacities live, and restores scanned defaults', async () => {
  const { ctx, patchPath } = await composition()
  const directory = ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)
  expect(directory?.settingsNs).toBe('zen-custom-entry')
  const initial = await ctx.llm.discoverModels('zen-custom-entry', { provider })
  expect(initial).toMatchObject([{ id, contextWindow: 1_000_000, maxTokens: 256000, inputModalities: ['text', 'image'] }])
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'set', path: ['models'], value: [{ id, name: 'My Flash', contextWindow: 900000, maxTokens: 64000, input: ['text'] }] }])
  const edited = await ctx.llm.resolveModelInfo(provider, id)
  expect(edited).toMatchObject({ name: 'My Flash', context: { contextWindow: 900000 }, defaultMaxTokens: 64000, inputModalities: ['text'] })
  expect(await readFile(patchPath, 'utf8')).toContain('900000')
  expect(await ctx.llm.discoverModels('zen-custom-entry', { provider })).toEqual(initial)
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'unset', path: ['models'] }])
  expect(await ctx.llm.resolveModelInfo(provider, id)).toMatchObject({ context: { contextWindow: 1_000_000 }, inputModalities: ['text', 'image'] })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'zen-custom-entry')
  await entry?.fiber?.dispose()
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
})

it('retains an explicit empty catalog and rejects invalid capacities before committing', async () => {
  const { ctx } = await composition()
  await expect(ctx.settings.mutate('zen-custom-entry', [{ op: 'set', path: ['models'], value: [{ id, contextWindow: -1 }] }])).rejects.toThrow()
  expect(await ctx.llm.listModels(provider)).toHaveLength(1)
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'set', path: ['models'], value: [] }])
  expect(await ctx.llm.listModels(provider)).toEqual([])
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'unset', path: ['models'] }])
  expect(await ctx.llm.listModels(provider)).toHaveLength(1)
})

it('discovers new free models while preserving saved overrides and filtering unsupported catalog rows', async () => {
  const { ctx } = await composition({ expectedCount: 5, extraModels: {
    'muse-spark-1.3-contributor-free': { name: 'Muse Spark 1.3 Free', limit: { context: 1048576, output: 131072 }, modalities: { input: ['text', 'image', 'audio'] } },
    'nemotron-3.5-super-vl-free': { name: 'Nemotron 3.5 Super VL Free', limit: { context: 1048576, output: 131072 }, modalities: { input: ['text', 'image'] } },
    'nemotron-3.5-lightning-free': { name: 'Nemotron 3.5 Lightning Free', limit: { context: 262144, output: 262144 }, modalities: { input: ['text'] } },
    'glm-5.3-flash-free': { name: 'GLM Flash Free', limit: { context: 1048576, output: 32768 }, modalities: { input: ['text'] } },
    'retired-free': { name: 'Retired', status: 'deprecated', limit: { context: 1000, output: 100 }, modalities: { input: ['text'] } },
  } })
  const catalog = await ctx.llm.discoverModels('zen-custom-entry', { provider })
  expect(catalog).toMatchObject([
    { id, contextWindow: 1000000, maxTokens: 256000 },
    { id: 'muse-spark-1.3-contributor-free', contextWindow: 1048576, maxTokens: 131072, inputModalities: ['text', 'image'] },
    { id: 'nemotron-3.5-super-vl-free', contextWindow: 1048576, maxTokens: 131072, inputModalities: ['text', 'image'] },
    { id: 'nemotron-3.5-lightning-free', contextWindow: 262144, maxTokens: 262144, inputModalities: ['text'] },
    { id: 'glm-5.3-flash-free', contextWindow: 614400, maxTokens: 32768, inputModalities: ['text'] },
  ])
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'set', path: ['models'], value: [{ id, contextWindow: 950000, maxTokens: 256000 }] }])
  expect(await ctx.llm.listModels(provider)).toHaveLength(1)
  expect(await ctx.llm.resolveModelInfo(provider, id)).toMatchObject({ context: { contextWindow: 950000 }, defaultMaxTokens: 256000 })
  expect(await ctx.llm.discoverModels('zen-custom-entry', { provider })).toEqual(catalog)
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'unset', path: ['models'] }])
  expect(await ctx.llm.listModels(provider)).toHaveLength(5)
})

it('finishes persisting public catalog metadata before the Loader mount completes', async () => {
  const { cachePath, cacheDir } = await composition()
  const cached = JSON.parse(await readFile(cachePath, 'utf8'))
  expect(cached).toMatchObject({ zen: [{ id }, { id: 'jev-1.13-free' }, { id: 'paid-model' }], models: { [id]: { limit: { context: 200000, output: 32000 } } }, userAgent: 'opencode/1.19.0' })
  expect(await readdir(cacheDir)).toEqual([`${provider}-catalog.json`])
})

it('retries transient directory failures before saving a successful scan', async () => {
  const { fetch } = await composition({ failFirst: true })
  expect(fetch.mock.calls.filter(([url]) => url === 'https://opencode.ai/inference/v1/models')).toHaveLength(2)
})

it('uses last-good public metadata when the directory remains unavailable and still applies live edits', async () => {
  const cached = JSON.stringify({ zen: [{ id }], models: { [id]: { name: 'Cached Flash', limit: { context: 200000, output: 32000 }, modalities: { input: ['text', 'image'] } } }, userAgent: 'opencode/1.19.0' })
  const { ctx, fetch, cachePath } = await composition({ unavailable: true, cached })
  expect(fetch.mock.calls.filter(([url]) => url === 'https://opencode.ai/inference/v1/models')).toHaveLength(3)
  expect(await ctx.llm.resolveModelInfo(provider, id)).toMatchObject({ name: 'Cached Flash', context: { contextWindow: 1000000 } })
  await ctx.settings.mutate('zen-custom-entry', [{ op: 'set', path: ['models'], value: [{ id, maxTokens: 64000 }] }])
  expect(await ctx.llm.resolveModelInfo(provider, id)).toMatchObject({ defaultMaxTokens: 64000 })
  expect(await readFile(cachePath, 'utf8')).toBe(cached)
})

it('does not invent models from a corrupt cache when all directory attempts fail', async () => {
  const { ctx, cachePath } = await composition({ unavailable: true, cached: '{invalid', expectedCount: 0 })
  expect(await ctx.llm.discoverModels('zen-custom-entry', { provider })).toEqual([])
  expect(await readFile(cachePath, 'utf8')).toBe('{invalid')
})

it('pads absent and empty required tool schemas without changing existing declarations', () => {
  const empty = { name: 'bash', description: 'Existing tool', parameters: { type: 'object' as const, properties: {} } }
  const preserved = { name: 'read', description: 'Existing read', parameters: { type: 'object' as const, properties: { file_path: { type: 'string' as const } } } }
  const padded = Zen.requiredZenTools([empty, preserved])
  expect(padded).toMatchObject([{ name: 'bash', parameters: { properties: { command: { type: 'string' } } } }, preserved])
  expect(padded[1]).toBe(preserved)
  expect(empty.parameters.properties).toEqual({})
  expect(Zen.requiredZenTools()).toMatchObject([
    { name: 'bash', parameters: { properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'read', parameters: { properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  ])
})

it('sends padded replay reasoning and required tools even without an initial system message', async () => {
  let request: Record<string, unknown> | undefined
  let headers: Headers | undefined
  const { ctx } = await composition({ inference: async (input, init) => {
    request = JSON.parse(typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : '{}')
    headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const frames = [
      { choices: [{ delta: { role: 'assistant', content: 'hello' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const source = { kind: 'model' as const, provider, model: id }
  const messages = [
    createUserMessage({ content: [{ type: 'text', text: 'earlier question' }], source }),
    createAssistantMessage({ content: [{ type: 'text', text: 'earlier answer' }], source: { provider, model: id } }),
    createUserMessage({ content: [{ type: 'text', text: 'continue' }], source }),
  ]
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider, model: id, messages })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(request).toMatchObject({
    model: id, stream: true,
    messages: expect.arrayContaining([{ role: 'assistant', content: 'earlier answer', reasoning_content: '' }]),
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'bash', parameters: expect.objectContaining({ properties: expect.objectContaining({ command: expect.any(Object) }) }) }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'read', parameters: expect.objectContaining({ properties: expect.objectContaining({ file_path: expect.any(Object) }) }) }) }),
    ]),
  })
  expect(headers?.get('user-agent')).toBe('opencode/1.19.0')
  expect(headers?.get('authorization')).toBe('Bearer public')
  expect(headers?.get('x-opencode-session')).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  expect(headers?.has('x-session-affinity')).toBe(false)
  expect(headers?.has('http-referer')).toBe(false)
})

it('exposes Off only when the feed explicitly accepts none', async () => {
  const { ctx } = await composition({ expectedCount: 3, extraModels: {
    'no-close-free': { name: 'No close', limit: { context: 1000, output: 100 }, modalities: { input: ['text'] }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    'with-close-free': { name: 'With close', limit: { context: 1000, output: 100 }, modalities: { input: ['text'] }, reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] },
  } })
  expect((await ctx.llm.resolveModelInfo(provider, 'no-close-free')).reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
  expect((await ctx.llm.resolveModelInfo(provider, 'with-close-free')).reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high'])
})

it('preserves real reasoning and leaves unrelated or invalid bodies untouched', () => {
  const modelIds = new Set([id])
  const body = JSON.stringify({ model: id, messages: [
    { role: 'assistant', content: 'answer', reasoning_content: 'retained reasoning' },
    { role: 'assistant', content: 'empty reasoning', reasoning_content: '' },
    { role: 'user', content: 'question' },
  ] })
  expect(Zen.withReplayedReasoning(body, modelIds)).toBe(body)
  expect(Zen.withReplayedReasoning('{invalid', modelIds)).toBe('{invalid')
  const unrelated = JSON.stringify({ model: 'other-free', messages: [{ role: 'assistant', content: 'other answer' }] })
  expect(Zen.withReplayedReasoning(unrelated, modelIds)).toBe(unrelated)
  expect(Zen.withReplayedReasoning(JSON.stringify({ model: id, messages: [{ role: 'assistant', content: 'answer' }] }), new Set())).toBe(JSON.stringify({ model: id, messages: [{ role: 'assistant', content: 'answer' }] }))
})
