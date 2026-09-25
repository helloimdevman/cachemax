import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Keeper } from '../plugins/cache-keeper/scripts/core.mjs';
import { measure, armSummary, checkCadence, observeCadence } from './validation-support.mjs';
import { summarize, tokenTotals, inputSensitivity, summarizeEndurance } from '../scripts/summarize-validation.mjs';
import { skillBlocks } from '../scripts/audit-codex-prefix.mjs';
import { contextRecords } from '../scripts/audit-host-context.mjs';

test('measurement preserves activation and records an actual text delta', async () => {
  const store = { data: { host: 'claude', sessionId: 'test', turns: [] }, owns: () => true, save() {}, guard() {}, event() {} };
  const adapter = { capabilities: { verifiedToolBlocking: true }, run: async ({ event }) => { event({ kind: 'delta', text: '.' }); return { text: '.' }; }, close: async () => {} };
  const keeper = new Keeper(adapter, store); keeper.onFor('2h');
  try { const r = await measure({ keeper }, '.'); assert.equal(keeper.enabled, true); assert.ok(r.firstTokenMs >= 0); assert.equal(r.text, '.');
    assert.equal(r.completedMonotonicAt - r.startedMonotonicAt, r.durationMs); }
  finally { await keeper.close(); }
});
test('experiment cost includes keeper calls, differences cumulative Claude cost, and preserves unknowns', () => {
  const session = { store: { data: { host: 'claude', turns: [{ source: 'keeper', usage: { reportedSessionCostUSD: 1.7 }, status: 'completed' }], events: [] } } };
  const seed = { completedAt: 0, usage: { reportedSessionCostUSD: 1 } }, next = { startedAt: 1, usage: { reportedSessionCostUSD: 2 } };
  assert.equal(armSummary(session, seed, next).totalPostSeedReportedCostUSD, 1);
  session.store.data.host = 'grok'; session.store.data.turns[0].usage = { costUSD: 0.1 }; next.usage = { costUSD: 0.2 };
  assert.ok(Math.abs(armSummary(session, seed, next).totalPostSeedReportedCostUSD - 0.3) < 1e-10);
  next.usage = {}; assert.equal(armSummary(session, seed, next).totalPostSeedReportedCostUSD, null);
  seed.completedMonotonicAt = 100; next.startedMonotonicAt = 120;
  assert.equal(armSummary(session, seed, next).monotonicIdleMs, 20);
});
test('endurance uses monotonic events despite wall-clock correction and rejects missing or late requests', () => {
  const turns = [{ startedAt: 10000, finishedAt: 10200 }, { startedAt: 20200, finishedAt: 20400 }];
  const keeper = new EventEmitter(); let now = 0;
  const observation = observeCadence(keeper, () => now);
  for (const [i, turn] of turns.entries()) {
    now = turn.startedAt;
    keeper.active = { turn: { source: 'keeper', requestKey: String(i), startedAt: now - (i ? 258 : 0) } };
    keeper.emit('status'); keeper.emit('status');
    now = turn.finishedAt; keeper.active = null; keeper.emit('idle');
  }
  observation.close();
  assert.deepEqual(observation.turns, turns);
  checkCadence(observation.turns, 0, 30000, 10000);
  assert.throws(() => checkCadence([turns[0], { startedAt: 19942, finishedAt: 20142 }], 0, 30000, 10000));
  assert.throws(() => checkCadence(turns.slice(0, 1), 0, 30000, 10000));
  assert.throws(() => checkCadence([{ startedAt: 18000, finishedAt: 18100 }], 0, 20000, 10000));
});
test('cache analysis counts maintenance, uses paired deltas, and preserves unknown usage', () => {
  const u = (inputTokens, cacheReadTokens) => ({ inputTokens, cacheReadTokens, cacheWriteTokens: null, outputTokens: 5, reasoningTokens: 2 });
  const arm = (firstTokenMs, keeperUsage = []) => ({ seedUsage: u(100, 0), nextUserUsage: u(110, 100), keeperUsage,
    keeperRequests: keeperUsage.length, firstTokenMs, durationMs: firstTokenMs, totalPostSeedReportedCostUSD: null });
  const report = { host: 'codex', results: [
    { valid: true, trial: 0, control: arm(10), keeper: arm(20, [u(110, 0)]) },
    { valid: true, trial: 1, control: arm(100), keeper: arm(101, [u(110, 100)]) },
    { valid: true, trial: 2, control: arm(101), keeper: arm(100, [u(110, 100)]) },
    { valid: false, trial: 3, error: 'excluded' } ] };
  const result = summarize(report, 'example');
  assert.equal(result.completedValidPairs, 3); assert.equal(result.invalidPairs.length, 1);
  assert.equal(result.summary.comparableCostPairs, 0);
  assert.equal(result.summary.pairedFirstTextDeltaMs.median, 1);
  assert.equal(result.summary.keeperMedianFirstTextMs - result.summary.controlMedianFirstTextMs, 0);
  assert.equal(result.pairs[0].keeperAnalysis.postSeed.inputTokens, 220);
  assert.equal(result.pairs[0].keeperAnalysis.postSeed.nonCachedInputTokens, 120);
  assert.equal(result.pairs[0].keeperAnalysis.postSeed.cacheWriteTokens, null);
  assert.equal(result.pairs[0].keeperAnalysis.postSeed.outputTokens, 10); // reasoning is not added twice
  report.results[0].keeper.setupUsage = [u(100, 0), u(110, 100)];
  const warmed = summarize(report, 'warmed').pairs[0].keeperAnalysis;
  assert.equal(warmed.postSeed.inputTokens, 220); assert.equal(warmed.wholeExperiment.inputTokens, 430);
  assert.equal(result.pairs[0].keeperAnalysis.maintenance.zeroCacheRequests, 1);
  assert.equal(tokenTotals('codex', [u(100, 0), null]).inputTokens, null);
  assert.equal(tokenTotals('codex', [null]).zeroCacheRequests, 0);
  assert.equal(tokenTotals('claude', [{ inputTokens: 2, cacheReadTokens: 10, cacheWriteTokens: 20 }]).inputTokens, 32);
  assert.equal(inputSensitivity({ nonCachedInputTokens: 100, cacheReadTokens: 0 }, { nonCachedInputTokens: 20, cacheReadTokens: 400 }).breakEvenCacheWeight, 0.2);
  assert.equal(inputSensitivity({ nonCachedInputTokens: null, cacheReadTokens: 0 }, { nonCachedInputTokens: 20, cacheReadTokens: 400 }).scenarios[0].inputWeightedDelta, null);
  const claude = { seedUsage: { reportedSessionCostUSD: 1 }, keeperUsage: [{ reportedSessionCostUSD: 1.7 }], nextUserUsage: { reportedSessionCostUSD: 2 } };
  const c = summarize({ host: 'claude', results: [{ valid: true, control: claude, keeper: claude }] }, 'cost').pairs[0].keeperAnalysis;
  assert.ok(Math.abs(c.maintenanceReportedCostUSD - 0.7) < 1e-12);
  assert.ok(Math.abs(c.nextUserReportedCostUSD - 0.3) < 1e-12);
  const e = summarizeEndurance({ host: 'codex', runMs: 120000, intervalMs: 60000, turns: [
    { source: 'user', usage: u(100, 0) }, { source: 'keeper', status: 'completed', usage: u(110, 0) }, { source: 'keeper', status: 'completed', usage: u(120, 110) }] });
  assert.equal(e.completedRequests, 2); assert.equal(e.maintenance.inputTokens, 230); assert.equal(e.inputGrowth, 10);
});
test('prefix audit detects late developer skill injection without exporting text', () => {
  const text = '<skills_instructions>\n- `r0` = private-path\n- test: private-description (file: r0/test/SKILL.md)';
  const started = { type: 'event_msg', payload: { type: 'task_started' } };
  const message = role => ({ type: 'response_item', payload: { role, content: [{ text }] } });
  const blocks = skillBlocks([started, message('developer'), message('user'), started, message('developer')]);
  assert.deepEqual(blocks.map(b => b.turn), [0, 1]); assert.equal(blocks[0].skillCount, 1); assert.equal(blocks[0].rootCount, 1);
  assert.equal(blocks[0].sha256, blocks[1].sha256); assert.equal(blocks[0].characters, text.length);
  assert.equal(JSON.stringify(blocks).includes('private-'), false);
  const claude = contextRecords('claude', [{ type: 'attachment', timestamp: '2026-01-01T00:00:00Z', attachment: { type: 'skills' }, rendered: [{ content: 'private-text' }] }], [{ startedAt: Date.parse('2026-01-01T00:00:00Z'), finishedAt: Date.parse('2026-01-01T00:00:01Z') }]);
  assert.equal(claude[0].turn, 0); assert.equal(claude[0].kind, 'skills');
  const grok = contextRecords('grok', [{ type: 'system', content: 'private-system' }, { type: 'user', content: 'private-user', prompt_index: 0 }]);
  assert.equal(grok.length, 1); assert.equal(JSON.stringify([claude, grok]).includes('private-'), false);
});
