import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = 'plugins/cache-keeper';
for (const dir of ['scripts', 'tests', join(root, 'scripts'), join(root, 'ui')]) for (const name of readdirSync(dir)) if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join(dir, name)]);
const pkg = JSON.parse(readFileSync('package.json'));
for (const dir of ['.codex-plugin', '.claude-plugin']) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'plugin.json')));
  assert.equal(manifest.name, 'cache-keeper'); assert.equal(manifest.version, pkg.version);
  assert.ok(!JSON.stringify(manifest).includes('TODO'));
}
for (const file of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
  const manifest = JSON.parse(readFileSync(file)); assert.equal(manifest.plugins[0].name, 'cache-keeper');
}
const listing = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }))[0];
for (const file of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'plugins/cache-keeper/.claude-plugin/plugin.json', 'plugins/cache-keeper/.codex-plugin/plugin.json', 'plugins/cache-keeper/scripts/cli.mjs', 'plugins/cache-keeper/ui/index.html', 'scripts/check.mjs', 'tests/live.mjs', 'tests/endurance.mjs']) assert.ok(listing.files.some(f => f.path === file), `Missing packaged file: ${file}`);
assert.ok(!listing.files.some(f => /test-results|auth\.json|node_modules|\.guard\./.test(f.path)));
console.log(`Syntax, manifests, and package contents verified (${listing.entryCount} files).`);
