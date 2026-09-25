import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAdapter, transcript } from '../plugins/cachemax/scripts/adapters.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const turn = { requestKey: 'request-one', source: 'keeper' };
test('Grok new account history is empty before its first session exists', () => {
  const original = process.env.GROK_HOME, root = mkdtempSync(join(tmpdir(), 'keeper-new-grok-'));
  try { process.env.GROK_HOME = root; assert.deepEqual(transcript('grok', 'fresh-session'), []); }
  finally { if (original === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = original; rmSync(root, { recursive: true, force: true }); }
});
function fake() {
  const rpc = new EventEmitter();
  rpc.child = { pid: 123 }; rpc.close = async () => {}; rpc.send = () => {};
  const adapter = new CodexAdapter({ cwd: '/tmp', sessionId: 'thread-one', guardPath: '/tmp/unused' }); adapter.rpc = rpc;
  const notification = (method, params) => rpc.emit('message', { method, params: { threadId: 'thread-one', ...params } });
  return { adapter, rpc, notification };
}
test('Codex correlates streaming and completion arriving before turn/start response', async () => {
  const { adapter, rpc, notification } = fake(); const events = [], bound = [];
  rpc.request = async method => {
    assert.equal(method, 'turn/start');
    notification('item/agentMessage/delta', { turnId: 'turn-one', delta: '.' });
    notification('thread/tokenUsage/updated', { turnId: 'turn-one', tokenUsage: { last: { cachedInputTokens: 200 } } });
    notification('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
    return { turn: { id: 'turn-one' } };
  };
  const result = await adapter.run({ text: '.', turn, signal: new AbortController().signal, bind: x => bound.push(x), event: x => events.push(x) });
  assert.equal(bound[0].hostTurnId, 'turn-one'); assert.equal(result.text, '.'); assert.equal(result.usage.cacheReadTokens, 200); assert.equal(events.length, 1);
});
test('Codex interrupt acknowledgement alone cannot release the next turn', async () => {
  const { adapter, rpc, notification } = fake(); const controller = new AbortController(); let resolved = false, interrupted = false;
  rpc.request = async method => {
    if (method === 'turn/interrupt') { interrupted = true; return {}; }
    return { turn: { id: 'turn-one' } };
  };
  const result = adapter.run({ text: '.', turn, signal: controller.signal, bind() {}, event() {} }).then(x => { resolved = true; return x; });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(interrupted, true); assert.equal(resolved, false);
  notification('turn/completed', { turn: { id: 'turn-one', status: 'interrupted' } }); await result; assert.equal(resolved, true);
});
test('unknown same-thread output is preserved; known old keeper output remains hidden', async () => {
  const { adapter, rpc, notification } = fake(); const events = [];
  adapter.ownedTurns.set('old-keeper', 'keeper');
  rpc.request = async () => {
    notification('item/agentMessage/delta', { turnId: 'old-keeper', delta: '.' });
    notification('item/agentMessage/delta', { turnId: 'unknown-user', delta: 'real answer' });
    notification('turn/completed', { turn: { id: 'turn-one', status: 'completed' } });
    return { turn: { id: 'turn-one' } };
  };
  await adapter.run({ text: '.', turn, signal: new AbortController().signal, bind() {}, event: x => events.push(x) });
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'unowned'); assert.equal(events[0].text, 'real answer');
});
