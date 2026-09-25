#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { managed } from './server.mjs';
import { Store, listStores, alive } from './store.mjs';
import { pluginRoot } from './adapters.mjs';

const help = `cachemax 0.2.0 — quiet, bounded session keepalive

  cachemax run claude|codex|grok [--cwd PATH] [--session ID --handoff]
  cachemax on --host HOST --session ID [--duration 30m] [--ttl 5m|1h|DURATION]
      [--interval DURATION] [--max-ticks 10] [--max-tokens N] [--max-cost-usd N]
  cachemax off|status|logs|show-hidden --host HOST --session ID
  cachemax doctor
  cachemax unlock|forget --host HOST --session ID

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
    console.log(`cachemax · ${p[1] || v.host} · ${session.sessionId}\n${session.url}\nKeepalive is OFF. Enable it in the page. Ctrl+C stops this runner.`);
    if (!v['no-open']) {
      const browser = process.platform === 'darwin' ? ['open', [session.url]] : process.platform === 'win32' ? ['explorer.exe', [session.url]] : ['xdg-open', [session.url]];
      const opener = spawn(browser[0], browser[1], { stdio: 'ignore' }); opener.on('error', () => {}); opener.unref();
    }
    const stop = async () => { await session.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
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
      if (!endpoint || !alive(endpoint.pid)) {
        if (command === 'status') console.log(JSON.stringify({ host: v.host, sessionId: v.session, phase: 'off', running: false }));
        else throw Error('This session has no running owner. Start cachemax run first.');
      } else {
        const path = { status: '/snapshot', 'show-hidden': '/hidden' }[command] || '/' + command;
        const data = command === 'on' ? { duration: v.duration, interval: v.interval, maxTicks: v['max-ticks'] === undefined ? 10 : Number(v['max-ticks']), ttl: v.ttl ?? null,
          maxTokens: v['max-tokens'] === undefined ? null : Number(v['max-tokens']), maxCostUSD: v['max-cost-usd'] === undefined ? null : Number(v['max-cost-usd']), requireNativeLoop: !!v['require-native-loop'] } : {};
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
