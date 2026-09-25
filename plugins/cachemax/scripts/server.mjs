import { createServer } from 'node:http';
import { readFileSync, mkdirSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Keeper } from './core.mjs';
import { Store, dataHome, atomicJSON, visibleHistory } from './store.mjs';
import { CodexAdapter, HeadlessAdapter } from './adapters.mjs';

const assets = new Map(['index.html', 'ui.mjs', 'style.css'].map(name => [name, readFileSync(new URL(`../ui/${name}`, import.meta.url))]));
export async function managed({ host, cwd = process.cwd(), sessionId, model, handoff = false, home = dataHome(), adapter: providedAdapter, port = 0 }) {
  if (!['claude', 'codex', 'grok'].includes(host)) throw Error('Host must be claude, codex, or grok');
  cwd = realpathSync(cwd);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const guardPath = join(home, `${randomUUID()}.guard.json`);
  atomicJSON(guardPath, { source: 'idle', pid: process.pid, sessionId: sessionId || null });
  let store, adapter, keeper, server;
  try {
    if (sessionId) {
      store = new Store(host, sessionId, home);
      if (!existsSync(store.path) && !handoff) throw Error('Close the native session first, then use --handoff with --session to transfer ownership');
      if (store.data.cwd && store.data.cwd !== cwd) throw Error('Session working directory differs; use its original --cwd');
      if (model && store.data.model && model !== store.data.model) throw Error('Session model differs; resume with the recorded model');
      model ||= store.data.model;
      store.lock();
    }
    adapter = providedAdapter || (host === 'codex' ? new CodexAdapter({ cwd, sessionId, model, guardPath }) : new HeadlessAdapter(host, { cwd, sessionId: sessionId || randomUUID(), model, guardPath, resumed: !!sessionId }));
    const init = await adapter.init();
    sessionId = init.sessionId;
    if (!store) { store = new Store(host, sessionId, home); store.lock(); }
    store.guardPath = guardPath;
    adapter.observedModel = store.data.observedModel || null;
    if (adapter.ownedTurns) for (const turn of store.data.turns) if (turn.hostTurnId) adapter.ownedTurns.set(turn.hostTurnId, turn.source);
    Object.assign(store.data, { cwd, model: init.model || model || null }); store.save();
    keeper = new Keeper(adapter, store);
    let messages = visibleHistory(await adapter.history(), store.data.turns);
    const clients = new Set();
    const token = randomUUID() + randomUUID();
    const broadcast = (type, data) => {
      const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client); }
        else client.write(payload);
      }
    };
    keeper.on('status', data => broadcast('status', data));
    keeper.on('message', data => { messages.push(data); broadcast('message', data); });
    keeper.on('answer', data => {
      const existing = messages.findIndex(m => m.id === data.id);
      if (existing < 0) messages.push(data); else messages[existing] = data;
      broadcast('answer', data);
    });
    keeper.on('turnEvent', data => {
      if (data.kind === 'delta') {
        const id = data.requestKey + ':assistant';
        let message = messages.find(m => m.id === id);
        if (!message) { message = { id, requestKey: data.requestKey, role: 'assistant', text: '' }; messages.push(message); }
        message.text += data.text;
      }
      broadcast('turnEvent', data);
    });
    const authorize = req => {
      const header = req.headers.authorization || '';
      const expected = `Bearer ${token}`;
      return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    };
    const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const body = async req => {
      if (req.headers['content-type'] !== 'application/json') throw Error('Expected application/json');
      let chunks = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 512000) throw Error('Request too large'); chunks += chunk; }
      return JSON.parse(chunks || '{}');
    };
    server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) { json(res, 403, { error: 'Invalid origin' }); return; }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && ['/', '/ui.mjs', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.setHeader('Content-Type', { 'index.html': 'text/html; charset=utf-8', 'ui.mjs': 'text/javascript', 'style.css': 'text/css' }[name]); res.end(assets.get(name)); return;
      }
      if (!authorize(req)) { json(res, 401, { error: 'Open the private URL printed by cachemax run' }); return; }
      try {
        if (req.method === 'GET' && url.pathname === '/snapshot') { json(res, 200, { status: keeper.status(), messages, capabilities: adapter.capabilities, cwd }); return; }
        if (req.method === 'GET' && url.pathname === '/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          clients.add(res);
          res.write(`data: ${JSON.stringify({ type: 'snapshot', data: { status: keeper.status(), messages } })}\n\n`);
          req.on('close', () => clients.delete(res)); return;
        }
        if (req.method === 'GET' && url.pathname === '/logs') { json(res, 200, { events: store.data.events, turns: store.data.turns }); return; }
        if (req.method === 'GET' && url.pathname === '/hidden') {
          if (keeper.active) { json(res, 409, { error: 'Wait for the active request to finish before reading original history' }); return; }
          json(res, 200, await adapter.history()); return;
        }
        if (req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return; }
        const data = await body(req);
        if (url.pathname === '/on') json(res, 200, keeper.onFor(data.duration, data));
        else if (url.pathname === '/off') json(res, 200, keeper.off());
        else if (url.pathname === '/activity') { keeper.activity(); json(res, 200, {}); }
        else if (url.pathname === '/message') {
          if (keeper.closed || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000 || keeper.queue.length >= 8) throw Error('Invalid message or input queue full');
          void keeper.user(data.text).catch(e => broadcast('warning', { message: e.message }));
          json(res, 202, { accepted: true });
        } else json(res, 404, { error: 'Not found' });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    store.data.endpoint = { url, token, pid: process.pid }; store.save();
    let closing;
    const close = () => closing ||= (async () => {
      await keeper.close();
      delete store.data.endpoint; store.save();
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      store.release();
    })();
    return { url: `${url}/#${token}`, sessionId, keeper, store, adapter, close };
  } catch (e) {
    await adapter?.close(); store?.release();
    if (existsSync(guardPath)) unlinkSync(guardPath);
    throw e;
  }
}
