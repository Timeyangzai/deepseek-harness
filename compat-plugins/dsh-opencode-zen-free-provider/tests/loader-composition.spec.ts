/** Loader-backed Zen settings persist model edits and reach the real adapter metadata. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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
}
type Options = {
  extraModels?: Record<string, CatalogModel>
  unavailable?: boolean
  cached?: string
  expectedCount?: number
  failFirst?: boolean
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
  const fetch = vi.fn(async (input: string) => {
    if (input === 'https://unpkg.com/opencode-ai@latest/package.json') return Response.json({ version: '1.19.0' })
    if (input === 'https://opencode.ai/inference/v1/models') {
      attempts++
      if (options.unavailable || (options.failFirst && attempts === 1)) return Response.json({}, { status: 503 })
      return Response.json({ data: [...Object.keys(models), 'jev-1.13-free', 'paid-model'].map(id => ({ id })) })
    }
    if (input === 'https://models.dev/api.json') return Response.json({ opencode: { models } })
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
