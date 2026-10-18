/** Released subagent configuration stays loadable after a preset upgrade. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { repairDelegation } from '../lib/redteam/index.js';
import { readCompositionRows } from '../lib/redteam/preset-composition.js';

const source = new URL('../presets/redteam/agent.cordis.yml', import.meta.url);
const text = readFileSync(source, 'utf8');

test('the bundled redteam preset uses released subagent configuration', () => {
  const visit = (rows) => rows.flatMap(row => row.group ? visit(row.config) : [row]);
  const tools = visit(readCompositionRows(text, new URL('../presets/redteam/', import.meta.url).pathname))
    .filter(row => row.name === '@deepseek-ai/dsh-tool-subagent');
  assert.ok(tools.length >= 2);
  for (const row of tools) {
    for (const key of ['toolFilter', 'persona', 'backgroundMode', 'enableRunInBackground']) {
      assert.equal(Object.hasOwn(row.config, key), false);
    }
  }
  assert.equal(tools.find(row => row.config.provider === 'spawn').config.maxDepth, 1);
});

test('existing preset repair removes retired fields and retains custom configuration', () => {
  const legacy = text.replace('        maxDepth: 1', [
    '        maxDepth: 1',
    '        backgroundMode: continuable',
    '        toolFilter:',
    '          deny:',
    '            - subagent_fork',
    '            - workflow',
    '        customSetting: retained',
  ].join('\n'));
  const result = repairDelegation(legacy);
  assert.equal(result.changed, true);
  assert.doesNotMatch(result.text, /toolFilter:|backgroundMode:|enableRunInBackground:/);
  assert.match(result.text, /maxDepth: 1/);
  assert.match(result.text, /customSetting: retained/);
  assert.equal(repairDelegation(result.text).changed, false);
});
