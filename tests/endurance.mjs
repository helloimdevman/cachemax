// Wall-clock endurance with real providers. No accelerated clock and no OS sleep claim.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { managed } from '../plugins/cache-keeper/scripts/server.mjs';
import { duration, PROMPT } from '../plugins/cache-keeper/scripts/core.mjs';
import { visibleHistory } from '../plugins/cache-keeper/scripts/store.mjs';
import { fingerprint, measure, armSummary, checkCadence, observeCadence, save } from './validation-support.mjs';

const { values: v } = parseArgs({ options: { 'confirm-usage': { type: 'boolean' }, host: { type: 'string' }, model: { type: 'string' }, duration: { type: 'string', default: '2h' }, interval: { type: 'string', default: '3m' } } });
if (!v['confirm-usage']) throw Error('Add --confirm-usage to consume existing subscription usage');
if (!['claude', 'codex', 'grok'].includes(v.host) || !v.model) throw Error('--host and explicit --model are required');
const runMs = duration(v.duration), intervalMs = duration(v.interval);
const maxTicks = Math.ceil(runMs / intervalMs) - 1;
if (maxTicks < 1 || maxTicks > 116) throw Error('Choose a bounded duration/interval (at most 120 total prompts)');
const root = mkdtempSync(join(tmpdir(), 'keeper-endurance-')), cwd = join(root, 'project'), home = join(root, 'state'); mkdirSync(cwd);
mkdirSync('test-results', { recursive: true });
const path = `test-results/endurance-${v.host}.json`, environment = fingerprint(v.host);
const report = { host: v.host, model: v.model, startedAt: new Date().toISOString(), runMs, intervalMs, environment, status: 'running', physicalSleep: 'not_performed' };
let session, cadence;
try {
  session = await managed({ host: v.host, model: v.model, cwd, home });
  const marker = randomBytes(12).toString('hex');
  const seed = await measure(session, `Remember the marker ${marker}. Reply exactly READY. No tools.`); assert.equal(seed.text.trim(), 'READY');
  let visible = 0;
  const changed = () => visible++;
  for (const event of ['message', 'turnEvent', 'answer']) session.keeper.on(event, changed);
  cadence = observeCadence(session.keeper);
  session.keeper.onFor(v.duration, { interval: v.interval, maxTicks: 120 });
  const activatedMonotonicAt = session.keeper.deadline - runMs;
  const activatedAt = session.keeper.state.activatedAt, expiresAt = session.keeper.state.expiresAt;
  report.activatedAt = activatedAt; report.expiresAt = expiresAt; save(path, report);
  console.log(JSON.stringify({ host: v.host, stage: 'endurance_started', activatedAt, expiresAt, maxExpectedTicks: maxTicks }));
  while (Date.now() < expiresAt + 1500) {
    await delay(Math.min(30000, Math.max(1, expiresAt + 1500 - Date.now())));
    assert.deepEqual(fingerprint(v.host), environment);
    assert.notEqual(session.keeper.state.phase, 'paused', session.keeper.state.warning || 'Maintenance paused');
    report.elapsedMs = Date.now() - activatedAt;
    report.turns = session.store.data.turns.map(({ source, startedAt, finishedAt, status, usage }) => ({ source, startedAt, finishedAt, status, usage }));
    report.lastStatus = { phase: session.keeper.state.phase, admittedTicks: session.keeper.state.admittedTicks };
    report.monotonicTiming = { activatedAt: activatedMonotonicAt, turns: cadence.turns };
    save(path, report);
  }
  assert.equal(visible, 0, 'Maintenance leaked into the visible conversation');
  assert.equal(session.keeper.enabled, false, 'Did not expire');
  assert.equal(session.keeper.state.expiresAt, expiresAt);
  const ticks = session.store.data.turns.filter(t => t.source === 'keeper');
  assert.ok(ticks.length > 0 && ticks.length <= maxTicks);
  assert.ok(ticks.every(t => t.startedAt < expiresAt && t.status === 'completed'));
  assert.equal(cadence.turns.length, ticks.length);
  checkCadence(cadence.turns, activatedMonotonicAt, activatedMonotonicAt + runMs, intervalMs);
  cadence.close();
  const next = await measure(session, 'Return my original marker exactly. No tools.'); assert.equal(next.text.trim(), marker);
  const history = await session.adapter.history(), filtered = visibleHistory(history, session.store.data.turns);
  assert.ok(history.some(m => m.text.trim() === PROMPT));
  assert.ok(!filtered.some(m => m.text.trim() === PROMPT));
  const summary = armSummary(session, seed, next), sessionId = session.sessionId;
  await session.close(); session = await managed({ host: v.host, model: v.model, cwd, home, sessionId });
  assert.equal(session.keeper.enabled, false);
  assert.deepEqual(visibleHistory(await session.adapter.history(), session.store.data.turns), filtered);
  const resumed = await measure(session, 'Return my original marker exactly. No tools.'); assert.equal(resumed.text.trim(), marker);
  report.status = 'passed'; report.result = { ...summary, hiddenLive: true, hiddenReplay: true, noOverlap: true, noLateDispatch: true, expired: true, continuity: true, restartOff: true, resumedContinuity: true, actualElapsedMs: Date.now() - activatedAt };
} catch (e) { report.status = 'failed'; report.error = e.message; process.exitCode = 1; }
finally { cadence?.close(); await session?.close(); report.finishedAt = new Date().toISOString(); save(path, report); console.log(JSON.stringify({ host: v.host, stage: 'endurance_finished', status: report.status, error: report.error, result: report.result })); }
