#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { managed } from './server.mjs';
import { Store, listStores, alive, atomicJSON } from './store.mjs';
import { pluginRoot, currentSession } from './adapters.mjs';
import { settings } from './core.mjs';

const help = `cachemax 0.2.0 — quiet, bounded session keepalive

  cachemax keep [--max-ticks 5] [--ttl 5m|1h|DURATION] [--duration DURATION]
      [--interval DURATION] [--max-tokens N] [--max-cost-usd N]
  cachemax run claude|codex|grok [--cwd PATH] [--session ID --handoff]
  cachemax on --host HOST --session ID [--duration 30m] [--ttl 5m|1h|DURATION]
      [--interval DURATION] [--max-ticks 5] [--max-tokens N] [--max-cost-usd N]
  cachemax off|status|logs|show-hidden --host HOST --session ID
  cachemax doctor
  cachemax unlock|forget --host HOST --session ID

Keep runs inside a Claude Code, Codex, or Grok Build session. After you exit that
session, cachemax takes it over, opens its page, and keeps it ready. Without
--duration, the window fits the request count. Inside a session, off, status and
logs find it without --host and --session.
Run opens a managed local conversation; keeper starts OFF.
Existing native sessions must be closed before --handoff.
Uses your CLI login. Maintenance can increase total usage. TTL unknown; no savings guarantee.
Options: --model MODEL, --no-open, --require-native-loop (fails unless verified).
TTL is your scheduling assumption, not a provider setting. Omit for unknown.
Auto interval: unknown/5m TTL = 3m; 1h TTL = 50m; other TTL = 5/6 of TTL.
Budgets count maintenance only and stop the next request after usage is reported.
One request can exceed the limit. Missing budget usage pauses; Codex has no dollar limit.
Native screens do not hide maintenance turns. See README for plugin installation.
`;
try {
  const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: {
    host: { type: 'string' }, session: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, duration: { type: 'string' }, interval: { type: 'string' }, 'max-ticks': { type: 'string' }, 'max-tokens': { type: 'string' }, 'max-cost-usd': { type: 'string' }, ttl: { type: 'string' }, handoff: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'require-native-loop': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }
  } });
  const command = p[0];
  const options = () => ({ interval: v.interval, maxTicks: v['max-ticks'] === undefined ? 5 : Number(v['max-ticks']), ttl: v.ttl ?? null,
    maxTokens: v['max-tokens'] === undefined ? null : Number(v['max-tokens']), maxCostUSD: v['max-cost-usd'] === undefined ? null : Number(v['max-cost-usd']) });
  const serve = (session, text) => {
    console.log(text);
    if (!v['no-open']) {
      const browser = process.platform === 'darwin' ? ['open', [session.url]] : process.platform === 'win32' ? ['explorer.exe', [session.url]] : ['xdg-open', [session.url]];
      const opener = spawn(browser[0], browser[1], { stdio: 'ignore' }); opener.on('error', () => {}); opener.unref();
    }
    const stop = async () => { await session.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return stop;
  };
  if (!v.session && ['on', 'off', 'status', 'logs', 'show-hidden'].includes(command)) {
    const here = currentSession();
    if (here) Object.assign(v, { host: here.host, session: here.sessionId });
  }
  if (v.version) console.log('0.2.0');
  else if (v.help || !command) console.log(help);
  else if (command === 'doctor') {
    for (const host of ['claude', 'codex', 'grok']) {
      try { console.log(`${host}: ${execFileSync(host, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()}`); } catch { console.log(`${host}: not available`); }
    }
    console.log(`node: ${process.version}\nmode: managed-quiet; native loop: not verified\nTTL: unknown; cache effect: unverified\nplugin: ${pluginRoot}`);
    try {
      const auth = JSON.parse(execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 10000 }));
      console.log(`claude authentication: ${auth.loggedIn ? auth.authMethod : 'not logged in'}; plan: ${auth.subscriptionType || 'unknown'}`);
    } catch { /* Other hosts may still work. */ }
    console.log('Codex and Grok authentication is checked through their normal session interfaces on run.');
  } else if (command === 'run') {
    if (v['require-native-loop']) throw Error('No native loop path has verified hidden input, output, and strict dispatch guards. Use managed-quiet.');
    const session = await managed({ host: p[1] || v.host, sessionId: v.session, cwd: v.cwd, model: v.model, handoff: v.handoff });
    serve(session, `cachemax · ${p[1] || v.host} · ${session.sessionId}\n${session.url}\nKeepalive is OFF. Enable it in the page. Ctrl+C stops this runner.`);
  } else if (command === 'keep') {
    const here = currentSession();
    if (!here) throw Error('No Claude Code, Codex, or Grok Build session found above this command. Run keep inside one, outside its command sandbox.');
    const plan = { hostPid: here.pid, cwd: here.cwd, duration: v.duration ?? null, options: options(), nonce: randomUUID() };
    const s = settings(plan.duration, plan.options, here.host);
    const store = new Store(here.host, here.sessionId);
    // This session is live in the host now, so an earlier cachemax runner must stop writing to it.
    const owner = store.data.endpoint?.pid;
    if (alive(owner) && /\b(cli\.mjs|cachemax)\b/.test(execFileSync('ps', ['-o', 'command=', '-p', String(owner)], { encoding: 'utf8' }))) {
      process.kill(owner, 'SIGTERM');
      for (let i = 0; i < 150 && alive(owner); i++) await delay(100);
    }
    if (existsSync(store.lockPath)) throw Error(`Another cachemax process still owns this session. Stop it, or after it exits run: cachemax unlock --host ${here.host} --session ${here.sessionId}`);
    atomicJSON(store.waitPath, plan);
    const log = openSync(store.logPath, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'takeover', '--host', here.host, '--session', here.sessionId, ...(v['no-open'] ? ['--no-open'] : [])],
      { detached: true, stdio: ['ignore', log, log], env: { ...process.env, CACHEMAX_WAIT: plan.nonce } });
    child.unref();
    atomicJSON(store.waitPath, { ...plan, pid: child.pid });
    const span = ms => ms % 3600000 === 0 ? `${ms / 3600000}h` : ms % 60000 === 0 ? `${ms / 60000}m` : `${ms / 1000}s`;
    console.log(`Ready: ${here.host} session ${here.sessionId}
Exit this ${here.host} session within 10 minutes. cachemax then takes it over and opens its page in your browser.
It sends at most ${s.maxTicks} maintenance requests, every ${span(s.intervalMs)}, for up to ${span(s.durationMs)}. Continue in that page; your message goes first.
Maintenance can increase total usage. To cancel before exiting: cachemax off
Log: ${store.logPath}`);
  } else if (command === 'takeover') {
    const store = new Store(v.host, v.session);
    const read = () => { try { return JSON.parse(readFileSync(store.waitPath, 'utf8')); } catch { return null; } };
    const mine = () => read()?.nonce === process.env.CACHEMAX_WAIT;
    const plan = read();
    // ponytail: a fixed 10-minute wait; an exit after that no longer means "stepping away now".
    const until = Date.now() + 600000;
    while (mine() && alive(plan.hostPid) && Date.now() < until) await delay(1000);
    if (!mine() || alive(plan.hostPid)) {
      if (mine()) unlinkSync(store.waitPath);
      console.log(`${new Date().toISOString()} takeover cancelled`);
    } else {
      unlinkSync(store.waitPath);
      const session = await managed({ host: v.host, sessionId: v.session, cwd: plan.cwd, handoff: true });
      try { session.keeper.onFor(plan.duration, plan.options); } catch (e) { await session.close(); throw e; }
      const stop = serve(session, `${new Date().toISOString()} took over ${v.host} · ${v.session}\n${session.url}\nKeepalive is ON.`);
      // Nobody can reach this runner without its page, so it ends once maintenance and the page are both done.
      let quiet = Date.now();
      setInterval(() => {
        if (session.keeper.enabled || session.keeper.active || session.viewers()) quiet = Date.now();
        else if (Date.now() - quiet > 60000) void stop();
      }, 5000);
    }
  } else if (command === 'status' && !v.session) {
    console.log(JSON.stringify(listStores().map(({ host, sessionId, endpoint, cwd }) => ({ host, sessionId, cwd, running: alive(endpoint?.pid) })), null, 2));
  } else if (['on', 'off', 'status', 'logs', 'show-hidden', 'unlock', 'forget'].includes(command)) {
    if (!v.host || !v.session) throw Error('--host and --session are required');
    const store = new Store(v.host, v.session);
    if (command === 'unlock' || command === 'forget') {
      if (existsSync(store.lockPath)) {
        const lock = JSON.parse(readFileSync(store.lockPath, 'utf8'));
        if (alive(lock.pid)) throw Error('Session owner is still running');
        if (store.data.turns.some(t => t.status === 'submitted' && alive(t.childPid))) throw Error('A host child is still running; wait for it to exit before unlocking');
        unlinkSync(store.lockPath);
      }
      if (command === 'forget' && existsSync(store.path)) unlinkSync(store.path);
      console.log(command === 'forget' ? 'Keeper metadata removed. Host transcript preserved.' : 'Stale keeper lock removed.');
    } else {
      const endpoint = store.data.endpoint;
      const waiting = existsSync(store.waitPath) ? JSON.parse(readFileSync(store.waitPath, 'utf8')) : null;
      if (command === 'off' && waiting) { unlinkSync(store.waitPath); console.log('Pending takeover cancelled.'); }
      if (!endpoint || !alive(endpoint.pid)) {
        if (command === 'status') console.log(JSON.stringify(alive(waiting?.pid) ? { host: v.host, sessionId: v.session, phase: 'waiting_for_exit', maxTicks: waiting.options.maxTicks, running: false } : { host: v.host, sessionId: v.session, phase: 'off', running: false }));
        else if (!(command === 'off' && waiting)) throw Error('This session has no running owner. Start cachemax run first.');
      } else {
        const path = { status: '/snapshot', 'show-hidden': '/hidden' }[command] || '/' + command;
        const data = command === 'on' ? { duration: v.duration, ...options(), requireNativeLoop: !!v['require-native-loop'] } : {};
        if (command === 'on' && ['maxTokens', 'maxCostUSD'].some(key => data[key] !== null && !Number.isFinite(data[key]))) throw Error('Budget limits must be finite positive numbers');
        if (command === 'on') console.log('Maintenance can increase total usage. Cache effects vary; savings are not guaranteed.');
        const post = ['on', 'off'].includes(command);
        const result = await fetch(endpoint.url + path, { headers: { Authorization: `Bearer ${endpoint.token}`, ...(post ? { 'Content-Type': 'application/json' } : {}) }, ...(post ? { method: 'POST', body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000) });
        const value = await result.json(); if (!result.ok) throw Error(value.error);
        console.log(JSON.stringify(command === 'status' ? value.status : value, null, 2));
      }
    }
  } else throw Error(`Unknown command: ${command}\n${help}`);
} catch (e) { console.error(`cachemax: ${e.message}`); process.exitCode = 1; }
