// Explicit opt-in: uses the normal signed-in CLI account. No credential files are read.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { managed } from '../plugins/cache-keeper/scripts/server.mjs';
import { visibleHistory } from '../plugins/cache-keeper/scripts/store.mjs';
import { PROMPT } from '../plugins/cache-keeper/scripts/core.mjs';

if (!process.argv.includes('--confirm-usage')) throw Error('Add --confirm-usage to authorize up to 3 model turns per selected host');
const selected = process.argv.filter(x => ['claude', 'codex', 'grok'].includes(x));
const hosts = selected.length ? selected : ['claude', 'codex', 'grok'];
const results = [];
const cancellation = process.argv.includes('--cancel');
for (const host of hosts) {
  const dir = mkdtempSync(join(tmpdir(), 'cache-keeper-live-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  let session;
  try {
    session = await managed({ host, cwd, home: join(dir, 'state') });
    const visible = [];
    for (const name of ['message', 'answer', 'turnEvent']) session.keeper.on(name, event => visible.push(event));
    const first = await session.keeper.user('Remember the marker cedar-seven. Reply exactly READY. No tools.');
    assert.equal(first.text.trim(), 'READY');
    const count = visible.length;
    session.keeper.onFor('90s', { interval: '2s', maxTicks: 1 });
    let second;
    if (cancellation) {
      const deadline = Date.now() + 90000;
      while (!session.keeper.active?.turn.childPid && Date.now() < deadline) await delay(10);
      assert.ok(session.keeper.active?.turn.childPid, 'keeper child must be running');
      await delay(200);
      second = await session.keeper.user('What marker did I ask you to remember? Reply with that marker only. No tools.');
    } else {
      const idle = once(session.keeper, 'idle', { signal: AbortSignal.timeout(120000) });
      await idle;
    }
    const tick = session.store.data.turns.find(t => t.source === 'keeper');
    if (cancellation) assert.equal(tick?.status, 'interrupted');
    else {
      assert.equal(tick?.status, 'completed'); assert.equal(visible.length, count);
      assert.ok(session.store.data.events.some(e => e.kind === 'request_ok'));
      second = await session.keeper.user('What marker did I ask you to remember? Reply with that marker only. No tools.');
    }
    assert.equal(second.text.trim(), 'cedar-seven');
    const history = await session.adapter.history();
    const filtered = visibleHistory(history, session.store.data.turns);
    if (!cancellation) assert.ok(history.some(m => m.text.trim() === PROMPT));
    assert.ok(!filtered.some(m => m.text.trim() === PROMPT));
    assert.ok(filtered.some(m => m.text.trim() === 'cedar-seven'));
    const sessionId = session.sessionId;
    await session.close(); session = null;
    // Reopen the same thread and reconstruct the display from the original host history.
    session = await managed({ host, cwd, sessionId, home: join(dir, 'state') });
    assert.equal(session.keeper.enabled, false);
    const replay = visibleHistory(await session.adapter.history(), session.store.data.turns);
    assert.deepEqual(replay, filtered);
    results.push({ host, version: execFileSync(host, ['--version'], { encoding: 'utf8' }).trim(), passed: true, cancellation, sameSession: true, hiddenLive: true, hiddenReplay: true, continuity: true, requests: 3, firstUsage: first.usage, keeperUsage: tick.usage, nextUserUsage: second.usage });
  } catch (e) { results.push({ host, passed: false, error: e.message }); process.exitCode = 1; }
  finally { await session?.close(); }
  console.log(JSON.stringify(results.at(-1)));
}
mkdirSync('test-results', { recursive: true });
writeFileSync(cancellation ? 'test-results/live-cancel.json' : 'test-results/live.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
