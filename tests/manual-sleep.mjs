// macOS hardware test. Run only when a person can wake this Mac again.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createInterface as prompt } from 'node:readline/promises';
import { managed } from '../plugins/cache-keeper/scripts/server.mjs';
import { launch } from '../plugins/cache-keeper/scripts/protocol.mjs';
import { measure, armSummary, save } from './validation-support.mjs';

const { values: v } = parseArgs({ options: { 'confirm-usage': { type: 'boolean' }, 'sleep-now': { type: 'boolean' }, host: { type: 'string' }, model: { type: 'string' } } });
if (!v['confirm-usage'] || !v.model || !['claude', 'codex', 'grok'].includes(v.host)) throw Error('Pass --confirm-usage --host HOST --model MODEL; at most 5 prompts');
if (process.platform !== 'darwin' || !process.stdin.isTTY) throw Error('Run this macOS hardware test from an interactive Terminal');
const root = mkdtempSync(join(tmpdir(), 'keeper-hardware-sleep-')), cwd = join(root, 'project'); mkdirSync(cwd);
const report = { host: v.host, model: v.model, startedAt: new Date().toISOString(), status: 'running', physicalSleep: 'pending' };
let session, input;
try {
  session = await managed({ host: v.host, model: v.model, cwd, home: join(root, 'state') });
  const marker = randomBytes(12).toString('hex');
  const seed = await measure(session, `Remember the marker ${marker}. Reply exactly READY. No tools.`); assert.equal(seed.text.trim(), 'READY');
  session.keeper.onFor('2m', { interval: '45s', maxTicks: 3 });
  const activatedAt = session.keeper.state.activatedAt, expiresAt = session.keeper.state.expiresAt;
  console.log('준비 완료. 지금 이 Mac을 절전한 뒤 3분 후 직접 깨워주세요. 자동 깨우기는 예약하지 않습니다.');
  if (v['sleep-now']) {
    const sleep = launch('pmset', ['sleepnow']); sleep.stdin.end(); const ended = await sleep.done;
    if (ended.error || ended.code !== 0) throw Error('macOS sleep request failed; use the Apple menu to sleep manually');
  }
  input = prompt({ input: process.stdin, output: process.stdout });
  await input.question('절전에서 복귀한 뒤 Enter를 누르세요: ', { signal: AbortSignal.timeout(1200000) });
  input.close();
  const resumedAt = Date.now(); assert.ok(resumedAt - activatedAt < 1200000, 'Test exceeded its 20-minute observation window');
  const power = launch('pmset', ['-g', 'log']); power.stdin.end();
  const events = [];
  for await (const line of createInterface({ input: power.stdout })) {
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(Sleep|Wake)\s/.exec(line);
    if (!match) continue;
    const at = Date.parse(match[1]);
    if (at >= activatedAt - 1000 && at <= resumedAt + 1000) events.push({ at, type: match[2] });
  }
  const ended = await power.done; assert.equal(ended.code, 0, 'Could not read macOS power events');
  const slept = events.find(e => e.type === 'Sleep' && e.at < expiresAt);
  const woke = events.find(e => e.type === 'Wake' && e.at >= expiresAt && e.at > slept?.at);
  assert.ok(slept && woke, 'No actual macOS Sleep → Wake spanning expiry was recorded; this is not a hardware pass');
  assert.equal(session.keeper.enabled, false);
  assert.ok(session.store.data.turns.filter(t => t.source === 'keeper').every(t => t.startedAt < expiresAt));
  const next = await measure(session, 'Return my original marker exactly. No tools.'); assert.equal(next.text.trim(), marker);
  report.status = 'passed'; report.physicalSleep = 'verified_by_macos_power_log';
  report.powerEvents = events; report.result = { ...armSummary(session, seed, next), activatedAt, expiresAt, resumedAt, noLateDispatch: true, continuity: true };
} catch (e) { report.status = 'failed'; report.error = e.message; process.exitCode = 1; }
finally {
  input?.close(); await session?.close(); mkdirSync('test-results', { recursive: true });
  report.finishedAt = new Date().toISOString(); save(`test-results/hardware-sleep-${v.host}.json`, report);
  console.log(JSON.stringify({ host: v.host, status: report.status, physicalSleep: report.physicalSleep, error: report.error }));
}
