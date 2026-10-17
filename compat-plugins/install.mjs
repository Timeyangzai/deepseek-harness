/** Install the shared Desktop plugin set without replacing user settings or application binaries. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock, writeFileAtomic } from '../packages/util/atomic-write/lib/types/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--offline' || arg === '--plan') options[arg.slice(2)] = true;
  else if (arg === '--dsh-home' || arg === '--pnpm-entry') {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2)] = value;
  } else throw new Error(`Unknown argument: ${arg}`);
}
if (!options['dsh-home']) throw new Error('Usage: node compat-plugins/install.mjs --dsh-home <initialized Desktop home> [--plan] [--offline] [--pnpm-entry <pnpm.mjs>]');

const home = resolve(options['dsh-home']);
const profile = join(home, 'profiles', 'desktop');
const manifestPath = join(profile, 'package.json');
const template = JSON.parse(readFileSync(join(root, 'desktop-profile', 'package.json'), 'utf8'));
const pnpm = resolve(options['pnpm-entry'] ?? join(root, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'));
const local = Object.entries(template.dependencies).filter(([, spec]) => spec.startsWith('file:'));
const copies = local.map(([name, spec]) => {
  const folder = spec.split('/').at(-1);
  const source = join(root, folder);
  if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name !== name) throw new Error(`Plugin package mismatch: ${folder}`);
  return { source, target: join(home, 'local-plugins', folder) };
});
const current = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(current.dsh?.profile?.bundles)) throw new Error('Desktop profile must contain dsh.profile.bundles; open Desktop once before installation.');
if (!existsSync(pnpm)) throw new Error(`pnpm entry not found: ${pnpm}; run pnpm install in this checkout first.`);

if (options.plan) {
  console.log(JSON.stringify({ home, profile, dependencies: template.dependencies, copies, offline: !!options.offline }, null, 2));
} else {
  await withFileLock(manifestPath, async () => {
    // Re-read after acquiring the writer lock so another completed operation is retained.
    const original = readFileSync(manifestPath);
    const manifest = JSON.parse(original);
    if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error('Desktop profile must contain dsh.profile.bundles.');
    const backupParent = join(home, 'plugin-backups');
    mkdirSync(backupParent, { recursive: true });
    const backup = mkdtempSync(join(backupParent, 'compat-'));
    const lockPath = join(profile, 'pnpm-lock.yaml');
    const lock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
    writeFileSync(join(backup, 'package.json'), original, { mode: 0o600 });
    if (lock) writeFileSync(join(backup, 'pnpm-lock.yaml'), lock, { mode: 0o600 });
    for (const { source, target } of copies) {
      if (existsSync(target)) cpSync(target, join(backup, 'local-plugins', target.split(/[\\/]/).at(-1)), { recursive: true });
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
    manifest.dependencies = { ...manifest.dependencies, ...template.dependencies };
    for (const name of Object.keys(template.dependencies)) {
      if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
    }
    await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    console.log(`Plugin backup: ${backup}`);
    const result = spawnSync(process.execPath, [pnpm, '--dir', profile, 'install', '--optimistic-repeat-install=false', ...options.offline ? ['--offline'] : []], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      await writeFileAtomic(manifestPath, original, { mode: 0o600 });
      if (lock) await writeFileAtomic(lockPath, lock, { mode: 0o600 });
      throw new Error(`Package installation failed (${result.error?.message ?? result.signal ?? result.status}). Manifest restored; local plugin copies may have changed. Keep Desktop closed and repair using ${backup}.`);
    }
    console.log('Desktop plugins installed. Start Desktop and check Settings → Plugin Market.');
  }, { waitMs: 0 });
}
