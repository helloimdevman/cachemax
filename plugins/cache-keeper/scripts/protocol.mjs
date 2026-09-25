import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export function launch(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stderrText = '';
  child.stderr.on('data', data => { child.stderrText = (child.stderrText + data).slice(-12000); });
  child.done = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return child;
}
export async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const kill = signal => {
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  kill('SIGTERM');
  let timer;
  await Promise.race([child.done, new Promise(resolve => { timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 5000); })]);
  clearTimeout(timer);
  await child.done;
}
export class RPC extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.child = launch(command, args, options);
    this.pending = new Map(); this.nextId = 1;
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object') throw Error('Invalid protocol message');
        if ('id' in msg && !msg.method) {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id); clearTimeout(pending.timer);
          if (msg.error) pending.reject(Error(msg.error.message || 'Host RPC failed')); else pending.resolve(msg.result);
        } else this.emit('message', msg);
      } catch (e) { this.fail(e); }
    });
    this.child.done.then(({ code, error }) => this.fail(error || Error(`Host exited (${code})`)));
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  send(message) { if (this.child.stdin.destroyed) throw Error('Host input closed'); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  request(method, params = {}, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async close() { await terminate(this.child); this.lines.close(); }
}
export const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
