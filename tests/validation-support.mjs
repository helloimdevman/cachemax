import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { atomicJSON } from '../plugins/cache-keeper/scripts/store.mjs';
import assert from 'node:assert/strict';

export function fingerprint(host) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else hash.update(p).update(readFileSync(p));
    }
  };
  walk('plugins/cache-keeper');
  const settings = ['.claude/settings.json', '.claude/plugins/installed_plugins.json', '.codex/config.toml', '.grok/config.toml'].map(name => {
    const p = join(homedir(), name), s = existsSync(p) && statSync(p);
    return { name, size: s ? s.size : null, sha256: s ? createHash('sha256').update(readFileSync(p)).digest('hex') : null };
  });
  return { runtimeSHA256: hash.digest('hex'), version: execFileSync(host, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), node: process.version, settings };
}
export async function measure(session, text) {
  const started = performance.now(), startedAt = Date.now(); let firstTokenMs = null;
  const listen = e => { if (e.kind === 'delta' && e.text && firstTokenMs === null) firstTokenMs = performance.now() - started; };
  session.keeper.on('turnEvent', listen);
  try {
    const result = await session.keeper.user(text);
    const completedMonotonicAt = performance.now();
    return { text: result.text, startedAt, completedAt: Date.now(), startedMonotonicAt: started, completedMonotonicAt,
      durationMs: completedMonotonicAt - started, firstTokenMs, usage: result.usage };
  } finally { session.keeper.removeListener('turnEvent', listen); }
}
export function armSummary(session, seed, next) {
  const turns = session.store.data.turns.filter(t => t.source === 'keeper');
  const keeperUsage = turns.map(t => t.usage);
  const host = session.store.data.host;
  const cost = host === 'claude'
    ? Number.isFinite(next.usage?.reportedSessionCostUSD) && Number.isFinite(seed.usage?.reportedSessionCostUSD)
      ? next.usage.reportedSessionCostUSD - seed.usage.reportedSessionCostUSD : null
    : [next.usage, ...keeperUsage].every(u => Number.isFinite(u?.costUSD))
      ? [next.usage, ...keeperUsage].reduce((n, u) => n + u.costUSD, 0) : null;
  return { model: session.store.data.observedModel || session.store.data.model, seedUsage: seed.usage,
    idleMs: next.startedAt - seed.completedAt,
    monotonicIdleMs: Number.isFinite(next.startedMonotonicAt) && Number.isFinite(seed.completedMonotonicAt) ? next.startedMonotonicAt - seed.completedMonotonicAt : null,
    nextUserUsage: next.usage, durationMs: next.durationMs,
    firstTokenMs: next.firstTokenMs, keeperRequests: turns.length, keeperUsage,
    keeperStatuses: turns.map(t => t.status), totalPostSeedReportedCostUSD: cost,
    costMeaning: host === 'claude' ? 'CLI list-price estimate; includes all post-seed session requests' : host === 'grok' ? 'CLI reported estimate; includes keeper requests' : 'Dollar cost unavailable',
    warnings: session.store.data.events.filter(e => ['paused', 'gap_detected'].includes(e.kind)).map(({ kind, reason }) => ({ kind, reason })) };
}
export { atomicJSON as save };
export function observeCadence(keeper, now = () => performance.now()) {
  const turns = []; let key, span;
  const start = () => {
    const turn = keeper.active?.turn;
    if (turn?.source !== 'keeper' || turn.requestKey === key) return;
    key = turn.requestKey; span = { startedAt: now() }; turns.push(span);
  };
  const finish = () => { if (span) { span.finishedAt = now(); span = null; } };
  keeper.on('status', start); keeper.on('idle', finish);
  return { turns, close() { keeper.removeListener('status', start); keeper.removeListener('idle', finish); } };
}
export function checkCadence(turns, activatedAt, expiresAt, intervalMs) {
  let due = activatedAt + intervalMs;
  for (const turn of turns) {
    assert.ok(turn.startedAt >= due - 100 && turn.startedAt <= due + 5000, 'Maintenance cadence was interrupted');
    due = turn.finishedAt + intervalMs;
  }
  assert.ok(due >= expiresAt - 5000, 'A scheduled maintenance request was missing');
}
