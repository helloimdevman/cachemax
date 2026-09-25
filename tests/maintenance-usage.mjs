// Seven real prompts: seed, common warmup, old/new/new/old maintenance, recall.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { managed } from '../plugins/cache-keeper/scripts/server.mjs';
import { PROMPT, duration } from '../plugins/cache-keeper/scripts/core.mjs';
import { visibleHistory } from '../plugins/cache-keeper/scripts/store.mjs';
import { measure, fingerprint, observeCadence, save } from './validation-support.mjs';

const { values: v } = parseArgs({ options: { 'confirm-usage': { type: 'boolean' }, host: { type: 'string' }, model: { type: 'string' }, interval: { type: 'string', default: '3m' }, label: { type: 'string' }, 'resume-state': { type: 'string' } } });
if (!v['confirm-usage']) throw Error('Add --confirm-usage for at most seven model prompts');
assert.ok(['claude','codex','grok'].includes(v.host) && v.model, 'Pass a host and explicit model');
assert.match(v.label || '', /^[a-z0-9-]{1,40}$/, 'Use a unique label');
const intervalMs = duration(v.interval); assert.ok(intervalMs <= 3600000);
const path = `test-results/maintenance-${v.host}-${v.label}.json`;
assert.ok(!existsSync(path), 'Report exists; choose a new label');
mkdirSync('test-results', { recursive: true });
const resume = v['resume-state'] ? JSON.parse(readFileSync(v['resume-state'], 'utf8'))[v.host] : null;
if (v['resume-state']) assert.ok(resume?.home && resume?.cwd && resume?.sessionId, 'Missing synthetic session state');
const root = resume ? null : mkdtempSync(join(tmpdir(), 'keeper-maintenance-'));
const cwd = resume?.cwd || join(root, 'project'); if (!resume) mkdirSync(cwd);
const environment = fingerprint(v.host), previous = 'Only ".". No tools.';
const variants = resume ? [PROMPT, previous, PROMPT] : [previous, PROMPT, PROMPT, previous];
const report = { host: v.host, model: v.model, startedAt: new Date().toISOString(), environment, intervalMs,
  maxPrompts: resume ? 4 : 7, continuedSyntheticSession: !!resume, status: 'preparing',
  promptSequence: resume ? ['short','previous','short'] : ['previous','short','short','previous'], turns: [] };
const persist = () => save(path, report); persist();
let session, cadence, cancelled = false, priorTurns = 0, priorEvents = 0;
const cancel = () => { cancelled = true; void session?.close(); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  session = await managed({ host: v.host, model: v.model, cwd, home: resume?.home || join(root, 'state'), ...(resume ? { sessionId: resume.sessionId } : {}) });
  priorTurns = session.store.data.turns.length; priorEvents = session.store.data.events.length;
  const marker = resume ? (await session.adapter.history()).find(m => m.role === 'user' && /^Marker: [a-f0-9]{24}\. Remember this marker and fixture\./.test(m.text))?.text.match(/^Marker: ([a-f0-9]{24})/)[1] : randomBytes(12).toString('hex');
  assert.ok(marker, 'Resume only a synthetic fixture session');
  if (resume) report.turns.push({ stage: 'prior_baseline', usage: session.store.data.turns.findLast(t => t.status === 'completed')?.usage });
  const fixture = Array.from({ length: 1500 }, (_, i) => `record ${String(i).padStart(5, '0')}: alder cedar birch maple`).join('\n');
  for (const [stage, prompt, expected] of resume ? [] : [
    ['seed', `Marker: ${marker}. Remember this marker and fixture. Reply exactly READY. No tools.\n${fixture}`, 'READY'],
    ['warmup', previous, '.']]) {
    const r = await measure(session, prompt); assert.equal(r.text.trim(), expected);
    report.turns.push({ stage, usage: r.usage, durationMs: r.durationMs }); persist();
  }
  let index = 0, visible = 0;
  const shown = () => visible++;
  for (const e of ['message','answer','turnEvent']) session.keeper.on(e, shown);
  const run = session.adapter.run.bind(session.adapter);
  session.adapter.run = async options => {
    if (options.turn.source !== 'keeper') return run(options);
    assert.ok(!cancelled); assert.ok(index < variants.length, 'Maintenance request cap exceeded');
    assert.deepEqual(fingerprint(v.host), environment, 'CLI/config/runtime changed');
    const current = index++, prompt = variants[current], started = performance.now();
    const r = await run({ ...options, text: prompt });
    assert.equal(r.text.trim(), '.'); assert.ok(!r.toolAttempt && !r.cancelled);
    report.turns.push({ stage: 'keeper', variant: report.promptSequence[current], usage: r.usage, durationMs: performance.now() - started });
    console.log(JSON.stringify({ host: v.host, ...report.turns.at(-1) })); persist(); return r;
  };
  cadence = observeCadence(session.keeper);
  session.keeper.onFor(`${(intervalMs * 5 + 480000) / 1000}s`, { interval: v.interval, maxTicks: variants.length });
  const activatedAt = session.keeper.deadline - (intervalMs * 5 + 480000);
  report.status = 'observing'; persist();
  console.log(JSON.stringify({ host: v.host, stage: 'observing', maxPrompts: report.maxPrompts, intervalMs }));
  while (session.keeper.enabled || session.keeper.active) await once(session.keeper, 'idle', { signal: AbortSignal.timeout(intervalMs + 150000) });
  assert.ok(!cancelled); assert.equal(index, variants.length, session.keeper.state.warning || 'Missing maintenance request'); assert.equal(visible, 0);
  assert.equal(session.store.data.events.slice(priorEvents).filter(e => e.kind === 'request_ok').length, variants.length);
  const ticks = session.store.data.turns.slice(priorTurns).filter(t => t.source === 'keeper');
  assert.equal(ticks.length, variants.length); assert.ok(ticks.every(t => t.status === 'completed'));
  report.cadence = { activatedAt, turns: cadence.turns };
  assert.equal(cadence.turns.length, variants.length);
  let due = activatedAt + intervalMs;
  for (const t of cadence.turns) { assert.ok(t.startedAt >= due - 100 && t.startedAt <= due + 5000); due = t.finishedAt + intervalMs; }
  cadence.close();
  for (const e of ['message','answer','turnEvent']) session.keeper.removeListener(e, shown);
  const recall = await measure(session, 'Return the marker from my first message exactly. No tools.');
  assert.equal(recall.text.trim(), marker);
  report.turns.push({ stage: 'recall', usage: recall.usage, durationMs: recall.durationMs });
  const history = await session.adapter.history(), filtered = visibleHistory(history, session.store.data.turns);
  assert.equal(history.length - filtered.length, session.store.data.turns.filter(t => t.source === 'keeper' && t.status === 'completed').length * 2, 'Each completed maintenance pair must be hidden');
  assert.deepEqual(fingerprint(v.host), environment);
  report.status = 'passed'; report.continuity = true; report.hiddenLive = true; report.hiddenReplay = true;
} catch (e) { report.status = 'failed'; report.error = e.message; process.exitCode = 1; }
finally {
  cadence?.close();
  report.requests = (session?.store.data.turns.length ?? 0) - priorTurns;
  report.requestStatuses = session?.store.data.turns.slice(priorTurns).map(({ source, status }) => ({ source, status })) ?? [];
  report.warnings = session?.store.data.events.slice(priorEvents).filter(e => ['paused','gap_detected'].includes(e.kind)).map(({ kind, reason }) => ({ kind, reason })) ?? [];
  await session?.close();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  report.finishedAt = new Date().toISOString(); persist();
  console.log(JSON.stringify({ host: v.host, status: report.status, requests: report.requests, error: report.error }));
}
