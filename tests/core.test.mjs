import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Keeper, duration } from '../plugins/cache-keeper/scripts/core.mjs';
import { Store, visibleHistory, atomicJSON } from '../plugins/cache-keeper/scripts/store.mjs';
import { usage } from '../plugins/cache-keeper/scripts/adapters.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
class Clock {
  time = 0; wallTime = 1000000; timers = new Map(); id = 0;
  now = () => this.time;
  wall = () => this.wallTime;
  set = (fn, ms) => { const id = ++this.id; this.timers.set(id, { fn, at: this.time + ms }); return id; };
  clear = id => this.timers.delete(id);
  async advance(ms) {
    this.time += ms; this.wallTime += ms;
    for (const [id, task] of [...this.timers]) if (task.at <= this.time && this.timers.delete(id)) task.fn();
    await flush();
  }
}
function setup({ delayed = false, answer = '.', guard = true, host = 'codex', measuredUsage = { cacheReadTokens: 10 } } = {}) {
  const clock = new Clock();
  const calls = [];
  const store = { data: { host, sessionId: 'test', turns: [], events: [] }, owned: true, owns() { return this.owned; }, save() {}, guard() {}, event(kind, data) { this.data.events.push({ kind, ...data }); } };
  const adapter = {
    capabilities: { verifiedToolBlocking: guard },
    run: async args => {
      calls.push(args); args.bind({ hostTurnId: String(calls.length) });
      args.event({ kind: 'delta', text: answer });
      if (delayed) return new Promise(resolve => { args.finish = () => resolve({ text: answer, usage: structuredClone(measuredUsage) }); });
      return { text: answer, usage: structuredClone(measuredUsage) };
    }, close: async () => { calls.at(-1)?.finish?.(); }
  };
  return { clock, store, calls, adapter, keeper: new Keeper(adapter, store, { clock, timeoutMs: 5000 }) };
}
test('duration input validation', () => {
  assert.equal(duration('2h'), 7200000);
  for (const value of ['0s', '-1s', '25h', 'NaNh', 'Infinityh', '1', '1ms', '1h;touch x', '0.00001s']) assert.throws(() => duration(value));
});
test('no immediate tick, no tick at or after expiry, and immutable deadline', async () => {
  const { keeper, clock, calls } = setup(); keeper.onFor('3s', { interval: '1s' });
  const expires = keeper.state.expiresAt;
  assert.equal(calls.length, 0); await clock.advance(1000); assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'Only .'); assert.equal(calls[0].turn.source, 'keeper');
  await keeper.user('actual work'); assert.equal(keeper.state.expiresAt, expires);
  await clock.advance(2000); assert.equal(calls.length, 2); assert.equal(keeper.enabled, false);
});
test('short duration skips unnecessary heartbeat', async () => {
  const { keeper, clock, calls } = setup(); keeper.onFor('1s', { interval: '2s' });
  await clock.advance(1000); assert.equal(calls.length, 0);
});
test('hidden streaming never reaches display; actual periods are preserved', async () => {
  const { keeper, clock } = setup(); const visible = [];
  for (const name of ['message', 'turnEvent', 'answer']) keeper.on(name, event => visible.push(event));
  keeper.onFor('20s', { interval: '1s' }); await clock.advance(1000);
  assert.deepEqual(visible, []); await keeper.user('.');
  assert.equal(visible[0].text, '.'); assert.equal(visible.at(-1).text, '.'); keeper.off();
});
test('user waits for keeper cancellation completion and is a separate turn', async () => {
  const { keeper, clock, calls } = setup({ delayed: true }); const shown = []; keeper.on('message', m => shown.push(m)); keeper.onFor('20s', { interval: '1s' }); await clock.advance(1000);
  const user = keeper.user('real input'); assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 1);
  assert.equal(shown[0].text, 'real input');
  await clock.advance(1000); assert.equal(calls.length, 1); calls[0].finish(); await flush();
  assert.equal(calls.length, 2); assert.equal(calls[1].turn.source, 'user'); assert.equal(calls[1].text, 'real input'); calls[1].finish(); await user; keeper.off();
});
test('ordinary user completion returns to idle when keeper is off', async () => {
  const { keeper } = setup(); await keeper.user('.'); assert.equal(keeper.state.phase, 'off'); assert.equal(keeper.active, null);
});
test('typing and queued user input suppress admission', async () => {
  const { keeper, clock, calls } = setup(); const updates = []; keeper.on('status', s => updates.push(s));
  keeper.onFor('20s', { interval: '1s' }); keeper.activity();
  await clock.advance(1000); assert.equal(calls.length, 0); assert.equal(updates.at(-1).nextDueAt, 1005000);
  await clock.advance(4000); assert.equal(calls.length, 1); keeper.off();
});
test('maxTicks counts submissions and suppresses further requests', async () => {
  const { keeper, clock, calls } = setup(); keeper.onFor('20s', { interval: '1s', maxTicks: 1 });
  await clock.advance(1000); await clock.advance(10000); assert.equal(calls.length, 1); assert.equal(keeper.enabled, false);
});
test('stale scheduled callback cannot resurrect off/on generation', async () => {
  const { keeper, clock, calls } = setup(); keeper.onFor('20s', { interval: '1s' });
  const stale = [...clock.timers.values()].map(x => x.fn); keeper.off(); keeper.onFor('20s', { interval: '10s' });
  for (const fn of stale) fn(); await flush(); assert.equal(calls.length, 0); assert.equal(keeper.enabled, true); keeper.off();
});
test('dispatch guard rejects expiration during adapter preparation', async () => {
  const { keeper, clock, adapter } = setup(); let submitted = 0;
  adapter.run = async args => { await clock.advance(3000); if (args.admit()) submitted++; return { text: '', cancelled: true }; };
  keeper.onFor('3s', { interval: '1s' }); await clock.advance(1000); assert.equal(submitted, 0);
});
test('unexpected output pauses with no correction or retry', async () => {
  const { keeper, clock, calls } = setup({ answer: 'hello' }); keeper.onFor('20s', { interval: '1s' });
  await clock.advance(1000); assert.equal(keeper.state.phase, 'paused'); await clock.advance(10000); assert.equal(calls.length, 1);
});
test('lost ownership stops dispatch', async () => {
  const { keeper, clock, store, calls } = setup(); keeper.onFor('20s', { interval: '1s' }); store.owned = false;
  await clock.advance(1000); assert.equal(calls.length, 0); assert.equal(keeper.state.phase, 'paused');
});
test('sleep gap sends at most one request, no catch-up burst', async () => {
  const { keeper, clock, store, calls } = setup(); keeper.onFor('20s', { interval: '1s' });
  await clock.advance(10000); assert.equal(calls.length, 1); assert.ok(store.data.events.some(e => e.kind === 'gap_detected')); keeper.off();
});
test('native loop and missing verified guard reject activation', () => {
  const { keeper } = setup({ guard: false }); assert.throws(() => keeper.onFor('2h'));
  assert.throws(() => setup().keeper.onFor('2h', { requireNativeLoop: true }));
  assert.throws(() => setup().keeper.onFor('2h', { maxTicks: 121 }));
});
test('live and replay hide by owned IDs, never by body; unknown IDs remain visible', () => {
  const history = [{ id: 'a', text: '.', role: 'user' }, { id: 'b', text: '.', role: 'assistant' }, { id: 'c', text: '.', turnId: 'old' }];
  const turns = [{ source: 'keeper', messageIds: ['b'], hostTurnId: 'old', generation: 1 }];
  assert.deepEqual(visibleHistory(history, turns), [history[0]]); assert.deepEqual(visibleHistory(history, turns, true), history);
  assert.equal(visibleHistory(history, []).length, 3);
});
test('exclusive locks, separate sessions, private metadata, restart stays off', () => {
  const home = mkdtempSync(join(tmpdir(), 'keeper-lock-'));
  try {
    const a = new Store('codex', 'session-a', home); a.lock(); a.save();
    const b = new Store('codex', 'session-a', home); assert.throws(() => b.lock());
    const c = new Store('grok', 'session-a', home); c.lock(); c.save();
    assert.equal(statSync(a.path).mode & 0o777, 0o600); a.release(); b.lock();
    const keeper = new Keeper({ capabilities: { verifiedToolBlocking: true } }, b); assert.equal(keeper.enabled, false);
    b.release(); c.release();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('usage preserves unavailable values instead of inventing zeros', () => {
  assert.equal(usage('codex').cacheReadTokens, null); assert.equal(usage('claude').costUSD, null);
  assert.equal(usage('codex', { cachedInputTokens: 123 }).cacheReadTokens, 123);
});
test('usage keeps provider TTL and thinking counters for cache experiments', () => {
  const u = usage('claude', { input_tokens: 2, cache_creation_input_tokens: 90,
    cache_creation: { ephemeral_1h_input_tokens: 90, ephemeral_5m_input_tokens: 0 },
    output_tokens_details: { thinking_tokens: 7 } });
  assert.equal(u.cacheWrite1hTokens, 90); assert.equal(u.cacheWrite5mTokens, 0);
  assert.equal(u.reasoningTokens, 7); assert.equal(usage('claude').cacheWrite1hTokens, null);
});
test('wall-clock expiry is detected even when the monotonic clock stopped during sleep', async () => {
  const { keeper, clock, calls } = setup(); keeper.onFor('2h');
  clock.wallTime += 7200001; await clock.advance(1000);
  assert.equal(keeper.enabled, false); assert.equal(calls.length, 0);
});
test('wake clears stale cache evidence before the next scheduled heartbeat', async () => {
  const { keeper, clock, store, calls } = setup(); keeper.onFor('2h');
  keeper.state.cache = 'cache_observed';
  clock.wallTime += 60000; await clock.advance(1000);
  assert.equal(keeper.state.cache, 'cache_unknown');
  assert.ok(store.data.events.some(e => e.kind === 'gap_detected'));
  assert.equal(calls.length, 0); keeper.off();
});
test('failed activation persistence cannot arm paid maintenance after an active user turn', async () => {
  const { keeper, clock, calls, store } = setup({ delayed: true });
  const user = keeper.user('real work');
  store.event = kind => { if (kind === 'activated') throw Error('disk full'); };
  assert.throws(() => keeper.onFor('20s', { interval: '1s' }), /disk full/);
  const enabled = keeper.enabled;
  calls[0].finish(); await user; await clock.advance(1000);
  const count = calls.length; calls[1]?.finish?.(); keeper.off();
  assert.equal(enabled, false); assert.equal(count, 1);
});
test('bundled guard denies keeper tools and malformed state, grants nothing for user tools', () => {
  const home = mkdtempSync(join(tmpdir(), 'keeper-guard-')); const state = join(home, 'guard.json');
  const run = input => spawnSync(process.execPath, ['plugins/cache-keeper/scripts/guard.mjs'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CACHE_KEEPER_GUARD: state } });
  try {
    atomicJSON(state, { source: 'keeper' });
    for (const tool_name of ['Bash', 'Read', 'mcp__example__run', 'apply_patch', 'Agent']) assert.equal(JSON.parse(run({ tool_name }).stdout).hookSpecificOutput.permissionDecision, 'deny');
    atomicJSON(state, { source: 'user' }); assert.equal(run({ tool_name: 'Read' }).stdout, ''); assert.equal(JSON.parse(run({ tool_name: 'Agent' }).stdout).decision, 'deny');
    rmSync(state); assert.equal(run({ tool_name: 'Bash' }).status, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('user TTL sets the default interval; custom intervals must precede it', async () => {
  const { keeper, clock, calls } = setup();
  keeper.onFor('30m', { ttl: '5m' });
  assert.equal(keeper.status().nextDueAt, 1180000);
  keeper.onFor('2h', { ttl: '1h' });
  assert.equal(keeper.status().intervalMs, 3000000);
  keeper.onFor('20s', { ttl: '6s' });
  assert.equal(keeper.status().ttlMs, 6000);
  await clock.advance(4999); assert.equal(calls.length, 0);
  await clock.advance(1); assert.equal(calls.length, 1);
  for (const ttl of ['0s', '25h', false, 0, -1, {}]) assert.throws(() => keeper.onFor('30m', { ttl }));
  assert.throws(() => keeper.onFor('30m', { ttl: '5m', interval: '5m' }));
  keeper.off();
});
test('token limit counts cached input once and stops the next keeper, not user turns', async () => {
  const { keeper, clock, calls } = setup({ measuredUsage: { inputTokens: 100, cacheReadTokens: 90, cacheWriteTokens: null, outputTokens: 5, reasoningTokens: 3, costUSD: null } });
  await keeper.user('user usage is outside the maintenance budget');
  keeper.onFor('20s', { interval: '1s', maxTokens: 200 });
  await clock.advance(1000);
  assert.equal(keeper.status().maintenance.totalTokens, 105);
  assert.equal(keeper.enabled, true);
  await clock.advance(1000);
  assert.equal(keeper.status().stopReason, 'token_limit');
  assert.equal(keeper.status().maintenance.totalTokens, 210);
  assert.equal(keeper.status().maintenance.successful, 2);
  assert.equal(keeper.status().nextDueAt, null);
  await clock.advance(1000); assert.equal(calls.length, 3);
  await keeper.user('continue work'); assert.equal(calls.length, 4);
});
test('Claude budget uses consecutive session cost differences and includes cache reads and writes', async () => {
  const measuredUsage = { inputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 8, outputTokens: 3, reportedSessionCostUSD: 1 };
  const { keeper, clock, store } = setup({ host: 'claude', measuredUsage });
  await keeper.user('baseline');
  keeper.onFor('20s', { interval: '1s', maxCostUSD: 0.025 });
  measuredUsage.reportedSessionCostUSD = 1.01; await clock.advance(1000);
  measuredUsage.reportedSessionCostUSD = 1.51; await keeper.user('expensive real work');
  measuredUsage.reportedSessionCostUSD = 1.53; await clock.advance(1000);
  const s = keeper.status();
  assert.equal(s.stopReason, 'cost_limit');
  assert.equal(s.maintenance.totalTokens, 206);
  assert.ok(Math.abs(s.maintenance.costUSD - 0.03) < 1e-10);
  assert.equal(s.maintenance.successful, 2);
  const reopened = new Keeper({ capabilities: { verifiedToolBlocking: true } }, store);
  assert.equal(reopened.enabled, false);
  assert.equal(reopened.status().maintenance.totalTokens, 206);
});
test('Grok cost limit sums request costs and stops at the threshold', async () => {
  const { keeper, clock, calls } = setup({ host: 'grok', measuredUsage: { inputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 8, outputTokens: 20, costUSD: 0.02 } });
  keeper.onFor('20s', { interval: '1s', maxCostUSD: 0.02 });
  await clock.advance(1000); await clock.advance(1000);
  assert.equal(calls.length, 1);
  assert.equal(keeper.status().maintenance.totalTokens, 120);
  assert.equal(keeper.status().stopReason, 'cost_limit');
});
test('unavailable budget usage pauses, and Codex rejects an unsupported dollar limit before dispatch', async () => {
  const { keeper, clock, calls } = setup();
  assert.throws(() => keeper.onFor('20s', { maxCostUSD: 0.1 }), /Codex/);
  for (const maxTokens of [0, -1, 1.2, '100', Infinity]) assert.throws(() => keeper.onFor('20s', { maxTokens }));
  keeper.onFor('20s', { interval: '1s', maxTokens: 100 });
  await clock.advance(1000); await clock.advance(1000);
  assert.equal(calls.length, 1); assert.equal(keeper.status().phase, 'paused');
  assert.equal(keeper.status().maintenance.totalTokens, null);
  assert.match(keeper.status().warning, /usage unavailable/i);
  const claude = setup({ host: 'claude', measuredUsage: { reportedSessionCostUSD: 3 } });
  for (const maxCostUSD of [0, -1, '1', NaN]) assert.throws(() => claude.keeper.onFor('20s', { maxCostUSD }));
  claude.keeper.onFor('20s', { interval: '1s', maxCostUSD: 0.1 });
  await claude.clock.advance(1000);
  assert.equal(claude.keeper.status().maintenance.costUSD, null);
  assert.equal(claude.keeper.status().phase, 'paused');
});
test('status publishes the next due time and records valid, invalid and interrupted maintenance separately', async () => {
  const { keeper, clock } = setup(); const updates = []; keeper.on('status', s => updates.push(s));
  keeper.onFor('20s', { interval: '1s' }); await clock.advance(1000);
  assert.equal(updates.at(-1).nextDueAt, 1002000);
  assert.equal(updates.at(-1).maintenance.lastSuccessAt, 1001000);
  keeper.off(); keeper.onFor('20s', { interval: '1s' });
  assert.equal(keeper.status().maintenance.successful, 0); keeper.off();
  const bad = setup({ answer: 'unexpected' }); bad.keeper.onFor('20s', { interval: '1s' }); await bad.clock.advance(1000);
  assert.equal(bad.keeper.status().maintenance.failed, 1);
  assert.equal(bad.keeper.status().maintenance.successful, 0);
  const interrupted = setup({ delayed: true }); interrupted.keeper.onFor('20s', { interval: '1s', maxTokens: 100 });
  await interrupted.clock.advance(1000);
  const user = interrupted.keeper.user('back'); interrupted.calls[0].finish(); await flush(); interrupted.calls[1].finish(); await user;
  assert.equal(interrupted.keeper.status().maintenance.interrupted, 1);
  assert.equal(interrupted.keeper.status().phase, 'paused');
});
test('Claude stops at the selected cost threshold despite decimal subtraction rounding', async () => {
  const measuredUsage = { reportedSessionCostUSD: 0.02 };
  const { keeper, clock, calls } = setup({ host: 'claude', measuredUsage });
  await keeper.user('baseline'); keeper.onFor('20s', { interval: '1s', maxCostUSD: 0.01 });
  measuredUsage.reportedSessionCostUSD = 0.03;
  await clock.advance(1000); await clock.advance(1000);
  assert.equal(calls.length, 2); assert.equal(keeper.status().stopReason, 'cost_limit');
});
