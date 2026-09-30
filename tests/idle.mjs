// A bounded observational control/treatment run. Common host prefixes can share cache.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { managed } from '../plugins/cachemax/skills/cachemax/scripts/server.mjs';

if (!process.argv.includes('--confirm-usage')) throw Error('Add --confirm-usage: at most five model turns per selected host, six-minute idle window');
const selected = process.argv.filter(a => ['claude', 'codex', 'grok'].includes(a));
const results = await Promise.all((selected.length ? selected : ['claude', 'codex', 'grok']).map(async host => {
  const opened = [];
  try {
    const arms = {};
    for (const name of ['control', 'keeper']) {
      const root = mkdtempSync(join(tmpdir(), 'keeper-idle-'));
      const cwd = join(root, 'project'); mkdirSync(cwd);
      const session = await managed({ host, cwd, home: join(root, 'state') }); opened.push(session);
      const marker = randomBytes(8).toString('hex');
      const fixture = randomBytes(2048).toString('hex');
      const seed = await session.keeper.user(`Marker: ${marker}. Remember this marker and the following fixture. Reply exactly READY. No tools.\n${fixture}`);
      if (seed.text.trim() !== 'READY') throw Error('Unexpected initial answer; experiment stopped');
      arms[name] = { session, marker, readyAt: Date.now(), seedUsage: seed.usage };
      if (name === 'keeper') session.keeper.onFor('7m', { interval: '3m', maxTicks: 1 });
    }
    console.log(JSON.stringify({ host, stage: 'idle', seconds: 360 }));
    const measurements = {};
    for (const [name, arm] of Object.entries(arms)) {
      await delay(Math.max(0, arm.readyAt + 360000 - Date.now()));
      const started = performance.now();
      const next = await arm.session.keeper.user('Return the marker from my first message, exactly. No tools.');
      measurements[name] = { idleMs: Date.now() - arm.readyAt, durationMs: Math.round(performance.now() - started), continuity: next.text.trim() === arm.marker, seedUsage: arm.seedUsage, nextUserUsage: next.usage, keeperRequests: arm.session.keeper.state.admittedTicks, keeperUsage: arm.session.store.data.turns.filter(t => t.source === 'keeper').map(t => t.usage) };
    }
    return { host, ...measurements };
  } catch (e) { process.exitCode = 1; return { host, error: e.message }; }
  finally { for (const session of opened) await session.close(); }
}));
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/idle.json', JSON.stringify({ at: new Date().toISOString(), limitation: 'One observation per arm, unknown effective TTL; shared host prefixes can contaminate comparison. No causal savings claim.', results }, null, 2));
for (const result of results) console.log(JSON.stringify(result));
