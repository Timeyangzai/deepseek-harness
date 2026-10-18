// @vitest-environment jsdom
/** Third-party catalogs reuse the model editor without credential or endpoint controls. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { LlmDiscoveredModel, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en, zh } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const catalog: LlmDiscoveredModel[] = [{ id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', contextWindow: 1_000_000, maxTokens: 256_000, inputModalities: ['text', 'image'] }]

function mount(options: { user?: JsonValue; role?: string; readOnly?: boolean; copy?: typeof en | typeof zh } = {}) {
  const models = Schema.union([Schema.array(Schema.object({
    id: Schema.string().required(), name: Schema.string(),
    contextWindow: Schema.number().min(1), maxTokens: Schema.number().min(1),
    input: Schema.array(Schema.union(['text', 'image'])),
  })), Schema.const(null)]).default(null).role(options.role ?? 'model-catalog')
  const namespace: SettingsNamespaceView = {
    ns: 'third-party-provider', revision: 4, autoGenerate: true, applies: 'live', secrets: [],
    schema: JSON.parse(JSON.stringify(Schema.object({ models, imageLimit: Schema.number() }).toJSON())) as JsonValue,
    user: options.user ?? { imageLimit: 123 }, base: {}, value: { models: null, imageLimit: 123 },
  }
  const operations = {
    storeCredential: vi.fn(async () => undefined),
    removeCredential: vi.fn(async () => undefined),
    writeSettings: vi.fn(async () => ({ kind: 'written' as const, view: namespace })),
    discoverModels: vi.fn(async () => ({ kind: 'found' as const, models: catalog })),
  } satisfies ModelsOperations
  const close = vi.fn()
  const copy = options.copy ?? en
  render(<ProviderEditor provider="zen-free" displayName="OpenCode Zen Free" namespace={namespace}
    settingsPath={[]} schema={settingsSchema} operations={operations} t={key => copy[key]}
    readOnly={options.readOnly ?? false} onClose={close} />)
  return { operations, close, copy }
}

it.each([en, zh])('edits discovered capacities without exposing unrelated settings', async (copy) => {
  const { operations, close } = mount({ copy })
  await screen.findByDisplayValue(catalog[0]!.id)
  expect(screen.queryByLabelText(copy.keyInput)).toBeNull()
  expect(screen.queryByLabelText(copy.baseUrl)).toBeNull()
  fireEvent.click(screen.getByLabelText(`${copy.modelAdvanced} 1`))
  expect(screen.getByLabelText<HTMLInputElement>(`${copy.contextWindow} 1`).value).toBe('1M')
  await expect(`${document.body.textContent}\n`).toMatchFileSnapshot(`./expected/catalog-provider-${copy === en ? 'en' : 'zh'}.txt`)
  fireEvent.change(screen.getByLabelText(`${copy.contextWindow} 1`), { target: { value: '900K' } })
  fireEvent.click(screen.getByText(copy.apply))
  await waitFor(() => { expect(close).toHaveBeenCalledWith(true) })
  expect(operations.writeSettings).toHaveBeenCalledWith('third-party-provider', [{
    op: 'set', path: ['models'], value: [{
      id: catalog[0]!.id, name: catalog[0]!.name, contextWindow: 900_000, maxTokens: 256_000, input: ['text', 'image'],
    }],
  }], 4)
  expect(operations.storeCredential).not.toHaveBeenCalled()
})

it('restores the scanned catalog and unsets only the saved model override', async () => {
  const { operations, close } = mount({ user: { imageLimit: 123, models: [{ id: catalog[0]!.id, contextWindow: 500000 }] } })
  await screen.findByDisplayValue(catalog[0]!.id)
  fireEvent.click(screen.getByText(en.resetModels))
  fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} 1`))
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).value).toBe('1M') })
  fireEvent.click(screen.getByText(en.apply))
  await waitFor(() => { expect(close).toHaveBeenCalledWith(true) })
  expect(operations.writeSettings).toHaveBeenCalledWith('third-party-provider', [{ op: 'unset', path: ['models'] }], 4)
})

it('keeps an explicit empty catalog empty instead of re-inheriting scanned rows', async () => {
  const { operations } = mount({ user: { models: [] } })
  await waitFor(() => { expect(operations.discoverModels).toHaveBeenCalled() })
  expect(screen.queryByDisplayValue(catalog[0]!.id)).toBeNull()
  expect(screen.getByText(en.modelsEmpty)).toBeTruthy()
})

it('keeps unknown schemas read-only rather than assuming any models field is editable', () => {
  mount({ role: 'unrelated-list' })
  expect(screen.getByText(en.apply).closest('button')?.disabled).toBe(true)
  expect(screen.getByText(text => text.includes(en.advancedHint))).toBeTruthy()
})

it('disables catalog writes in a read-only deployment', async () => {
  mount({ readOnly: true })
  expect((await screen.findByDisplayValue(catalog[0]!.id)).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(en.apply).closest('button')?.disabled).toBe(true)
})
