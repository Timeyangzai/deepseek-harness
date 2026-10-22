/** Execute the installer in private Desktop homes with deterministic package-manager fixtures. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const profile = join(root, 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  const manifest = { name: 'test-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest) + '\n');
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '# preserve settings\n');
  writeFileSync(join(root, '.credentials.yaml'), '# preserve credentials\n');
  writeFileSync(join(root, 'pnpm.mjs'), 'import fs from "node:fs"; import path from "node:path"; const args=process.argv.slice(2); fs.writeFileSync(path.join(args[1],"pnpm-arguments.json"),JSON.stringify(args));\n');
  return { root, profile };
}
const run = (root, args = []) => spawnSync(process.execPath, [installer, '--dsh-home', root, '--pnpm-entry', join(root, 'pnpm.mjs'), ...args], { encoding: 'utf8', timeout: 60000 });

test('plan leaves user files and plugin directories untouched', t => {
  const { root, profile } = fixture(t);
  const original = readFileSync(join(profile, 'package.json'));
  const result = run(root, ['--plan']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dependencies.dshmarket, '1.67.0');
  assert.deepEqual(readFileSync(join(profile, 'package.json')), original);
  assert.equal(existsSync(join(root, 'local-plugins')), false);
});

test('install passes offline mode, retains user data and existing bundles, and is repeatable', t => {
  const { root, profile } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = run(root, ['--offline']);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
  assert.equal(manifest.dependencies.dshmarket, '1.67.0');
  assert.equal(manifest.dsh.profile.bundles.filter(x => x === 'dshmarket').length, 1);
  assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'));
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'pnpm-arguments.json'))), ['--dir', profile, 'install', '--optimistic-repeat-install=false', '--offline']);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '# preserve settings\n');
  assert.equal(readFileSync(join(root, '.credentials.yaml'), 'utf8'), '# preserve credentials\n');
  assert.equal(readdirSync(join(root, 'plugin-backups')).length, 2);
});

test('failed dependency installation restores the original manifest and lockfile', t => {
  const { root, profile } = fixture(t);
  const original = readFileSync(join(profile, 'package.json'));
  const lock = join(profile, 'pnpm-lock.yaml');
  writeFileSync(lock, '# previous lock\n');
  const stub = join(root, 'failing-pnpm.mjs');
  writeFileSync(stub, 'process.exit(7);\n');
  const result = run(root, ['--pnpm-entry', stub]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manifest restored; local plugin copies may have changed/);
  assert.deepEqual(readFileSync(join(profile, 'package.json')), original);
  assert.equal(readFileSync(lock, 'utf8'), '# previous lock\n');
  assert.equal(existsSync(join(profile, 'package.json.lock')), false);
});

test('dependency updates retain an installed bundle that is not enabled', t => {
  const { root, profile } = fixture(t);
  const path = join(profile, 'package.json');
  const previous = JSON.parse(readFileSync(path));
  previous.dependencies['@goodandready/dsh-goal'] = '0.2.25';
  writeFileSync(path, JSON.stringify(previous) + '\n');
  const result = run(root);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const installed = JSON.parse(readFileSync(path));
  assert.equal(installed.dependencies['@goodandready/dsh-goal'], '0.2.33');
  assert.equal(installed.dsh.profile.bundles.includes('@goodandready/dsh-goal'), false);
});

test('a held profile lock prevents mutations', t => {
  const { root, profile } = fixture(t);
  const original = readFileSync(join(profile, 'package.json'));
  writeFileSync(join(profile, 'package.json.lock'), `${process.pid}\n`);
  const result = run(root, ['--offline']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /writer lock/);
  assert.deepEqual(readFileSync(join(profile, 'package.json')), original);
  assert.equal(existsSync(join(root, 'local-plugins')), false);
});
