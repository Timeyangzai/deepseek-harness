/** Loader-backed Zen settings persist model edits and reach the real adapter metadata. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
})

const provider = 'opencode-zen-free-provider'
const id = 'deepseek-v4.1-flash-free'

async function composition() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === 'https://unpkg.com/opencode-ai@latest/package.json') return Response.json({ version: '1.19.0' })
    if (input === 'https://opencode.ai/zen/v1/models') return Response.json({ data: [{ id }] })
    if (input === 'https://models.dev/api.json') return Response.json({ opencode: { models: {
      [id]: { name: 'DeepSeek V4.1 Flash Free', limit: { context: 200000, output: 32000 }, modalities: { input: ['text', 'image'] } },
    } } })
    throw new Error(`Unexpected test request: ${input}`)
  }))
  root = await mkdtemp(join(tmpdir(), 'dsh-zen-settings-'))
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
  await vi.waitFor(async () => { expect(await ctx.llm.listModels(provider)).toHaveLength(1) })
  return { ctx, patchPath }
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
