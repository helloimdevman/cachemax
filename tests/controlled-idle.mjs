// Real subscription experiment. Counterbalanced pairs; never asserts a positive cache effect.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { managed } from '../plugins/cachemax/scripts/server.mjs';
import { duration, PROMPT } from '../plugins/cachemax/scripts/core.mjs';
import { fingerprint, measure, armSummary, observeCadence, checkCadence, save } from './validation-support.mjs';

const { values: v } = parseArgs({ options: { 'confirm-usage': { type: 'boolean' }, host: { type: 'string' }, model: { type: 'string' }, idle: { type: 'string', default: '12m' }, interval: { type: 'string', default: '3m' }, replicates: { type: 'string', default: '6' }, label: { type: 'string' }, warmup: { type: 'boolean' } } });
if (!v['confirm-usage']) throw Error('Add --confirm-usage to consume subscription usage for this bounded experiment');
if (!['claude', 'codex', 'grok'].includes(v.host) || !v.model) throw Error('--host and an explicit --model are required');
const idleMs = duration(v.idle), intervalMs = duration(v.interval), replicates = Number(v.replicates);
const maxTicks = Math.max(0, Math.ceil(idleMs / intervalMs) - 1);
const maxSubmittedPrompts = (maxTicks + 4 + (v.warmup ? 2 : 0)) * replicates;
if (!Number.isInteger(replicates) || replicates < 1 || replicates > 6 || maxTicks < 1 || maxTicks > 120 || maxSubmittedPrompts > 120) throw Error('Choose 1–6 pairs and at most 120 total submitted prompts');
const root = mkdtempSync(join(tmpdir(), 'keeper-controlled-'));
mkdirSync('test-results', { recursive: true });
if (v.label && !/^[a-z0-9-]{1,40}$/.test(v.label)) throw Error('Label must contain only lowercase letters, numbers, and hyphens');
const path = `test-results/controlled-${v.host}${v.label ? '-' + v.label : ''}.json`;
if (existsSync(path)) throw Error('Report already exists; choose a new --label to preserve previous observations');
const environment = fingerprint(v.host);
const report = { startedAt: new Date().toISOString(), host: v.host, model: v.model, idleMs, intervalMs, replicates, maxSubmittedPrompts,
  warmupRequestsPerArm: v.warmup ? 1 : 0, baselineMeaning: v.warmup ? 'Last shared warmup completion; setup usage is recorded separately' : 'Initial seed completion',
  environment, status: 'running', results: [], setupAttempts: [], limitations: ['Shared host system/tool prefixes may share cache; conversation markers differ at the first user message.', 'Estimates are not subscription invoices or isolated quota measurements.', 'Finite paired observations establish only this tested configuration.', 'Config fingerprints do not establish identical rendered prompts; inspect host context separately.'] };
const persist = () => save(path, report); persist();
console.log(JSON.stringify({ host: v.host, stage: 'started', idleMs, replicates, maxSubmittedPrompts: report.maxSubmittedPrompts }));
const pending = [], opened = new Set(), allArms = [], stop = new AbortController();
const checkpoint = () => {
  report.progress = allArms.map(({ trial, name, session }) => ({ trial, arm: name,
    phase: session.keeper.state.phase, warning: session.keeper.state.warning || null,
    turns: session.store.data.turns.map(({ source, status, startedAt, finishedAt, usage }) => ({ source, status, startedAt, finishedAt, usage: usage ?? null })) }));
  report.submittedPrompts = report.progress.reduce((n, a) => n + a.turns.length, 0); persist();
};
const progressTimer = setInterval(checkpoint, 30000);
const cancel = () => { stop.abort(Error('Experiment cancelled')); for (const session of opened) void session.close().catch(() => {}); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const fixture = Array.from({ length: 1500 }, (_, i) => `record ${String(i).padStart(5, '0')}: alder cedar birch maple`).join('\n');
const collect = async (trial, arms) => {
  const row = { trial, order: Object.keys(arms) };
  try {
    const settled = await Promise.allSettled(Object.entries(arms).map(async ([name, arm]) => {
      await delay(Math.max(0, arm.baseline.completedMonotonicAt + idleMs - performance.now()), undefined, { signal: stop.signal });
      assert.deepEqual(fingerprint(v.host), environment, 'CLI/config/runtime changed during experiment');
      const next = await measure(arm.session, 'Return the marker from my first message exactly. No tools.');
      row[name] = { ...armSummary(arm.session, arm.baseline, next), setupUsage: arm.setupUsage,
        continuity: next.text.trim() === arm.marker,
        monotonicCadence: arm.cadence ? { activatedAt: arm.activatedAt, turns: arm.cadence.turns } : null };
      assert.ok(row[name].continuity, 'Conversation continuity failed');
      assert.ok(row[name].keeperStatuses.every(s => s === 'completed'), 'Maintenance did not complete');
      assert.equal(row[name].warnings.length, 0, 'Maintenance paused or a time gap was detected');
      // Each wait starts after the previous reply, so the last planned request can land past the deadline; checkCadence catches real gaps
      if (name === 'keeper') assert.ok(row[name].keeperRequests >= 1 && row[name].keeperRequests <= maxTicks, 'Unexpected maintenance count');
      else assert.equal(row[name].keeperRequests, 0);
      assert.ok(Math.abs(row[name].monotonicIdleMs - idleMs) < 5000, 'Idle deadline was missed');
      if (arm.cadence) checkCadence(arm.cadence.turns, arm.activatedAt, arm.activatedAt + idleMs, intervalMs);
    }));
    const failed = settled.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    row.valid = true;
  } catch (e) { row.valid = false; row.error = e.message; process.exitCode = 1; }
  finally {
    for (const arm of Object.values(arms)) { arm.cadence?.close(); await arm.session.close(); opened.delete(arm.session); }
    report.results.push(row); report.results.sort((a, b) => a.trial - b.trial); persist();
    console.log(JSON.stringify({ host: v.host, stage: 'pair_completed', ...row }));
  }
};
try {
  for (let trial = 0; trial < replicates; trial++) {
    const cwd = join(root, `pair-${trial}`); mkdirSync(cwd);
    const arms = {};
    for (const name of trial % 2 ? ['keeper', 'control'] : ['control', 'keeper']) {
      stop.signal.throwIfAborted();
      assert.deepEqual(fingerprint(v.host), environment);
      const session = await managed({ host: v.host, model: v.model, cwd, home: join(root, `state-${trial}-${name}`) }); opened.add(session);
      const arm = { trial, name, session, setupUsage: [] }; allArms.push(arm);
      const marker = randomBytes(12).toString('hex');
      for (const [stage, prompt, expected] of [
        ['seed', `Marker: ${marker}. Remember this marker and fixture. Reply exactly READY. No tools.\n${fixture}`, 'READY'],
        ...(v.warmup ? [['warmup', PROMPT, '.']] : [])]) {
        const attempt = { trial, arm: name, stage, status: 'submitted' }; report.setupAttempts.push(attempt); persist();
        try {
          const measured = await measure(session, prompt); arm.baseline = measured; arm.setupUsage.push(measured.usage);
          Object.assign(attempt, { status: 'completed', usage: measured.usage, durationMs: measured.durationMs, firstTokenMs: measured.firstTokenMs });
          assert.equal(measured.text.trim(), expected);
        } catch (e) { attempt.status = 'failed'; attempt.error = e.message; throw e; }
        finally { checkpoint(); }
      }
      arm.marker = marker; arms[name] = arm;
      if (name === 'keeper') {
        arm.cadence = observeCadence(session.keeper);
        session.keeper.onFor(v.idle, { interval: v.interval, maxTicks });
        arm.activatedAt = session.keeper.deadline - idleMs;
      }
    }
    pending.push(collect(trial, arms));
    console.log(JSON.stringify({ host: v.host, stage: 'pair_seeded', trial, probesAfter: new Date(Math.max(...Object.values(arms).map(a => a.baseline.completedAt)) + idleMs).toISOString() }));
  }
  await Promise.all(pending);
  assert.deepEqual(fingerprint(v.host), environment);
  report.status = report.results.every(r => r.valid) ? 'completed' : 'failed';
} catch (e) { report.status = 'failed'; report.error = e.message; process.exitCode = 1; stop.abort(); await Promise.all(pending); }
finally {
  clearInterval(progressTimer);
  for (const arm of allArms) arm.cadence?.close();
  for (const session of opened) await session.close();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  report.finishedAt = new Date().toISOString(); checkpoint();
}
