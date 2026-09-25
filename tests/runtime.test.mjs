import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';

test('real SIGSTOP/SIGCONT: in-flight cancellation, no burst, and expiry while stopped', { timeout: 45000, skip: process.platform === 'win32' }, async () => {
  const results = [];
  for (const mode of ['gap', 'expired']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Keeper } from './plugins/cachemax/scripts/core.mjs';
      const turns = [], events = [];
      const store = { data: { host: 'codex', sessionId: 'test', turns }, owns: () => true, save() {}, guard() {}, event(kind, data) { events.push({ kind, ...data }); } };
      const adapter = { capabilities: { verifiedToolBlocking: true }, async run({ signal }) {
        process.send({ kind: 'started', at: Date.now() });
        await new Promise(resolve => { const timer = setTimeout(resolve, 2000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        return { text: '.', usage: { cacheReadTokens: 10 } };
      }, async close() {} };
      const keeper = new Keeper(adapter, store);
      keeper.on('status', s => process.send({ kind: 'status', phase: s.phase, cache: s.cache, enabled: keeper.enabled }));
      process.on('message', async m => { if (m === 'close') { await keeper.close(); process.send({ kind: 'closed', turns, events }); process.exit(0); } });
      keeper.onFor(process.argv[1] === 'gap' ? '40s' : '5s', { interval: '3s' });
    `, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages = [];
    child.on('message', m => messages.push(m));
    const ended = once(child, 'exit');
    const wait = async predicate => {
      while (!messages.some(predicate)) await once(child, 'message', { signal: AbortSignal.timeout(12000) });
      return messages.find(predicate);
    };
    try {
      await wait(m => m.kind === (mode === 'gap' ? 'started' : 'status'));
      const stoppedAt = Date.now(); process.kill(child.pid, 'SIGSTOP');
      await delay(mode === 'gap' ? 11500 : 6000);
      const resumedAt = Date.now(); process.kill(child.pid, 'SIGCONT');
      if (mode === 'gap') {
        await wait(m => m.kind === 'status' && m.cache === 'cache_unknown' && m.phase === 'armed' && messages.filter(x => x.kind === 'started').length > 0);
        await wait(m => m.kind === 'started' && m.at > resumedAt);
        const starts = messages.filter(m => m.kind === 'started');
        assert.equal(starts.length, 2);
        assert.ok(starts[1].at - resumedAt >= 2800, 'Resume sent an immediate catch-up request');
      } else await wait(m => m.kind === 'status' && m.phase === 'stopped');
      child.send('close'); const final = await wait(m => m.kind === 'closed'); await ended;
      if (mode === 'expired') assert.equal(final.turns.length, 0, 'Request sent after expiry');
      else { assert.equal(final.turns[0].status, 'interrupted'); assert.ok(final.events.some(e => e.kind === 'gap_detected')); }
      results.push({ mode, stoppedAt, resumedAt, suspendedMs: resumedAt - stoppedAt, passed: true, submittedRequests: final.turns.length });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { process.kill(child.pid, 'SIGCONT'); child.kill(); await ended; }
    }
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/process-suspend.json', JSON.stringify({ at: new Date().toISOString(), physicalSleep: false, mechanism: 'SIGSTOP/SIGCONT of a real runner process; no accelerated clock', results }, null, 2));
});
