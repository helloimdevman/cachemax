import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const dataHome = () => process.env.CACHEMAX_HOME || join(homedir(), '.cachemax');
export function atomicJSON(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export class Store {
  constructor(host, sessionId, home = dataHome()) {
    if (!['claude', 'codex', 'grok'].includes(host) || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) throw Error('Invalid host or session ID');
    this.home = home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(`${host}:${sessionId}`).digest('hex');
    this.path = join(home, `${key}.json`);
    this.lockPath = join(home, `${key}.lock`);
    this.guardPath = join(home, `${key}.guard.json`);
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { host, sessionId, generation: 0, turns: [], events: [] };
    if (this.data.host !== host || this.data.sessionId !== sessionId || !Array.isArray(this.data.turns)) throw Error('Invalid session metadata');
  }
  lock() {
    this.nonce = randomUUID();
    // A stale lock is never deleted automatically: two reclaimers could both become writers.
    try { const fd = openSync(this.lockPath, 'wx', 0o600); closeSync(fd); }
    catch (e) { if (e.code === 'EEXIST') throw Error('Session already owned, or stale lock. Run cachemax unlock after its owner exits.'); throw e; }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, nonce: this.nonce }), { mode: 0o600 });
  }
  owns() {
    try { return JSON.parse(readFileSync(this.lockPath, 'utf8')).nonce === this.nonce; } catch { return false; }
  }
  save() { if (!this.owns()) throw Error('Session ownership lost'); atomicJSON(this.path, this.data); }
  guard(source, requestKey) { atomicJSON(this.guardPath, { source, requestKey, pid: process.pid, sessionId: this.data.sessionId }); }
  event(kind, details = {}) { this.data.events.push({ kind, at: Date.now(), ...details }); if (this.owns()) this.save(); }
  release() {
    if (!this.owns()) return;
    unlinkSync(this.lockPath);
    if (existsSync(this.guardPath)) unlinkSync(this.guardPath);
  }
}
export function listStores(home = dataHome()) {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(home, n), 'utf8')));
}
export function visibleHistory(messages, turns, showHidden = false) {
  const hidden = new Set(turns.filter(t => t.source === 'keeper').flatMap(t => t.messageIds || []));
  const hiddenTurns = new Set(turns.filter(t => t.source === 'keeper' && t.hostTurnId).map(t => t.hostTurnId));
  return messages.filter(m => showHidden || (!hidden.has(m.id) && !hiddenTurns.has(m.turnId)));
}
