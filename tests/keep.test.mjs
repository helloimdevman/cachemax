import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../plugins/cachemax/skills/cachemax/scripts/store.mjs';

const cli = 'plugins/cachemax/skills/cachemax/scripts/cli.mjs';
test('keep waits for the host to exit; a newer keep replaces it and off cancels it', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'keeper-keep-'));
  const env = { ...process.env, CACHEMAX_HOME: home, CLAUDE_CODE_SESSION_ID: 'keep-test' };
  // This test process stands in for the host: keep runs as its child, and it never exits here.
  const keep = (...args) => execFileSync(process.execPath, [cli, 'keep', '--no-open', ...args], { encoding: 'utf8', env: { ...env, CLAUDE_PID: String(process.pid) } });
  const cachemax = (...args) => execFileSync(process.execPath, [cli, ...args, '--host', 'claude', '--session', 'keep-test'], { encoding: 'utf8', env });
  const store = new Store('claude', 'keep-test', home);
  const log = () => existsSync(store.logPath) ? readFileSync(store.logPath, 'utf8') : '';
  const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await delay(100); assert.ok(predicate()); };
  try {
    assert.match(keep('--max-ticks', '3'), /at most 3 maintenance requests, every 3m, for up to 12m/);
    const first = JSON.parse(readFileSync(store.waitPath, 'utf8'));
    assert.equal(first.hostPid, process.pid); assert.equal(first.options.maxTicks, 3);
    assert.match(cachemax('status'), /"phase":"waiting_for_exit","maxTicks":3/);
    assert.match(keep(), /at most 5 maintenance requests/);
    await until(() => /takeover cancelled/.test(log()));
    await until(() => { try { process.kill(first.pid, 0); return false; } catch { return true; } });
    const second = JSON.parse(readFileSync(store.waitPath, 'utf8'));
    assert.match(cachemax('off'), /Pending takeover cancelled/);
    await until(() => { try { process.kill(second.pid, 0); return false; } catch { return true; } });
    assert.equal(log().match(/takeover cancelled/g).length, 2);
    assert.ok(!existsSync(store.lockPath) && !existsSync(store.waitPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
