import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { managed } from '../plugins/cache-keeper/scripts/server.mjs';

test('local API requires token and same origin, serves user periods, and hides keeper history', async () => {
  const home = mkdtempSync(join(tmpdir(), 'keeper-http-'));
  const history = []; let id = 0;
  const adapter = { capabilities: { verifiedToolBlocking: true }, init: async () => ({ sessionId: randomUUID() }), close: async () => {}, history: async () => history,
    run: async ({ text, turn, bind, event }) => {
      const turnId = String(++id); bind({ hostTurnId: turnId });
      history.push({ id: turnId + 'u', turnId, role: 'user', text });
      event({ kind: 'delta', text: '.' }); history.push({ id: turnId + 'a', turnId, role: 'assistant', text: '.' });
      return { text: '.', usage: null };
    }
  };
  const session = await managed({ host: 'codex', cwd: home, home, adapter });
  const parsed = new URL(session.url), origin = parsed.origin;
  const auth = { Authorization: `Bearer ${parsed.hash.slice(1)}` };
  const post = (path, data, headers = {}) => fetch(origin + path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(origin + '/snapshot')).status, 401);
    assert.equal((await post('/on', { duration: '2h' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/message', { text: [] })).status, 400);
    assert.equal((await post('/on', { duration: 'Infinityh' })).status, 400);
    assert.equal((await post('/on', { duration: '30m', ttl: '5m', interval: '5m' })).status, 400);
    assert.equal((await post('/on', { duration: '30m', maxTokens: -1 })).status, 400);
    await session.keeper.user('.');
    const snapshot = await (await fetch(origin + '/snapshot', { headers: auth })).json();
    assert.deepEqual(snapshot.messages.map(m => m.text), ['.', '.']);
    const idle = once(session.keeper, 'idle');
    assert.equal((await post('/on', { duration: '1s', interval: '0.01s', maxTicks: 1 })).status, 200);
    await idle;
    const after = await (await fetch(origin + '/snapshot', { headers: auth })).json();
    assert.deepEqual(after.messages, snapshot.messages);
    const raw = await (await fetch(origin + '/hidden', { headers: auth })).json();
    assert.equal(raw.length, 4);
    const logs = await (await fetch(origin + '/logs', { headers: auth })).json();
    assert.ok(logs.events.some(e => e.kind === 'request_ok'));
    assert.ok(!JSON.stringify(logs).includes('Only'));
    assert.equal((await post('/off', {})).status, 200);
    const cli = await promisify(execFile)(process.execPath, ['plugins/cache-keeper/scripts/cli.mjs', 'on', '--host', 'codex', '--session', session.sessionId,
      '--ttl', '12m', '--max-tokens', '50000', '--max-ticks', '3'], { env: { ...process.env, CACHE_KEEPER_HOME: home } });
    assert.match(cli.stdout, /"ttlMs": 720000/);
    const configured = await (await fetch(origin + '/snapshot', { headers: auth })).json();
    assert.equal(configured.status.intervalMs, 600000);
    assert.equal(configured.status.durationMs, 1800000);
    assert.equal(configured.status.maxTokens, 50000);
    assert.equal(configured.status.maxTicks, 3);
    assert.equal(configured.status.maintenance.submitted, 0);
    assert.equal((await post('/on', { maxCostUSD: 1 })).status, 400);
  } finally { await session.close(); rmSync(home, { recursive: true, force: true }); }
});
