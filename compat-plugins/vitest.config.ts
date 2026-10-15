/** External JavaScript plugins resolve workspace peers through the source test plane. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

const peerImporter = fileURLToPath(new URL('../packages/llm/llm-pi-ai/src/index.ts', import.meta.url))
export default defineConfig({
  plugins: [
    tsconfigPaths({ loose: true, projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] }),
    standardDecoratorPlugin(),
    {
      name: 'compat-provider-peer',
      resolveId(id) {
        if (id === '@earendil-works/pi-ai' || id.startsWith('@earendil-works/pi-ai/')) return this.resolve(id, peerImporter, { skipSelf: true })
      },
    },
  ],
  test: { include: ['compat-plugins/*/tests/*.spec.ts'], environment: 'node', testTimeout: 15000, hookTimeout: 15000 },
})
