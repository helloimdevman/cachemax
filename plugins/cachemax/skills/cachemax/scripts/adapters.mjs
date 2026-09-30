import { createInterface } from 'node:readline';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RPC, launch, terminate, shellQuote } from './protocol.mjs';

export const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const guardScript = fileURLToPath(new URL('./guard.mjs', import.meta.url));
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
export function usage(host, raw = {}, cost = null) {
  if (host === 'codex') return { inputTokens: number(raw.inputTokens), cacheReadTokens: number(raw.cachedInputTokens), cacheWriteTokens: null, outputTokens: number(raw.outputTokens), reasoningTokens: number(raw.reasoningOutputTokens), costUSD: null };
  return { inputTokens: number(raw.input_tokens), cacheReadTokens: number(raw.cache_read_input_tokens ?? raw.cached_input_tokens), cacheWriteTokens: number(raw.cache_creation_input_tokens), outputTokens: number(raw.output_tokens), reasoningTokens: number(raw.reasoning_tokens ?? raw.output_tokens_details?.thinking_tokens), costUSD: host === 'claude' ? null : number(cost), ...(host === 'claude' ? { reportedSessionCostUSD: number(cost), cacheWrite1hTokens: number(raw.cache_creation?.ephemeral_1h_input_tokens), cacheWrite5mTokens: number(raw.cache_creation?.ephemeral_5m_input_tokens) } : {}) };
}
function contentText(content) {
  return typeof content === 'string' ? content : (content || []).filter(c => ['text', 'input_text', 'output_text'].includes(c.type)).map(c => c.text).join('');
}
function findFile(root, predicate, depth = 5) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && predicate(entry.name)) return path;
    if (entry.isDirectory() && depth > 0) { const found = findFile(path, predicate, depth - 1); if (found) return found; }
  }
  return null;
}
function transcriptPath(host, sessionId) {
  const root = host === 'claude' ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects') : join(process.env.GROK_HOME || join(homedir(), '.grok'), 'sessions');
  if (!existsSync(root)) return null;
  return (host === 'grok'
    ? readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(root, d.name, sessionId, 'chat_history.jsonl')).find(existsSync)
    : findFile(root, n => n === `${sessionId}.jsonl` || n === `${sessionId}.json`)) || null;
}
// Hosts append metadata after a turn (Claude on exit, Grok on MCP health checks), so file
// mtimes run late. Read the last completed turn's own timestamp instead.
function lastReplyAt(host, sessionId) {
  let path = transcriptPath(host, sessionId);
  if (host === 'grok' && path) path = join(dirname(path), 'events.jsonl');
  if (!path?.endsWith('.jsonl') || !existsSync(path)) return null;
  // The last line may be mid-write.
  const rows = readFileSync(path, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return Date.parse(host === 'grok' ? rows.findLast(r => r.type === 'turn_ended')?.ts : rows.findLast(r => r.type === 'assistant')?.timestamp) || null;
}
export function transcript(host, sessionId) {
  const path = transcriptPath(host, sessionId);
  if (!path) return [];
  const raw = readFileSync(path, 'utf8');
  let rows;
  if (path.endsWith('.jsonl')) rows = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  else { const parsed = JSON.parse(raw); rows = parsed.messages || parsed.history || []; }
  let grokTurn = null, grokPart = 0;
  return rows.flatMap((r, i) => {
    const msg = r.message || r;
    const role = msg.role || r.type;
    if (!['user', 'assistant'].includes(role)) return [];
    if (host === 'grok') {
      if (role === 'user') {
        if (!Number.isInteger(r.prompt_index)) return [];
        grokTurn = `prompt:${r.prompt_index}`; grokPart = 0;
      }
      if (!grokTurn) return [];
    }
    let text = contentText(msg.content);
    if (!text) return [];
    if (host === 'grok') {
      if (role === 'user' && text.startsWith('<user_query>\n') && text.endsWith('\n</user_query>')) text = text.slice(13, -14);
      return [{ id: `${grokTurn}:${grokPart++}`, turnId: grokTurn, role, text }];
    }
    return [{ id: r.uuid || r.id || msg.id || `${sessionId}:${i}`, role, text }];
  });
}

const sessionEnv = { claude: 'CLAUDE_CODE_SESSION_ID', codex: 'CODEX_THREAD_ID', grok: 'GROK_SESSION_ID' };
// The nearest host process above this command owns the conversation. Stop there: an ID
// from an outer host can be inherited through the environment.
export function findHost(table, env, pid) {
  for (let row; (row = table.get(pid)); pid = row.ppid) {
    const host = pid === Number(env.CLAUDE_PID) ? 'claude' : /^(claude|codex|grok)\b/.exec(basename(row.comm))?.[1];
    if (host) return env[sessionEnv[host]] ? { host, sessionId: env[sessionEnv[host]], pid } : null;
  }
  return null;
}
export function currentSession() {
  let ps;
  try { ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }); } catch { return null; }
  const table = new Map(ps.split('\n')
    .flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m ? [[Number(m[1]), { ppid: Number(m[2]), comm: m[3] }]] : []; }));
  const found = findHost(table, process.env, process.pid);
  // Resume needs the host's own directory; the shell may have changed directory since.
  if (found) try { found.cwd = /^n(.+)$/m.exec(execFileSync('lsof', ['-a', '-p', String(found.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }))[1]; } catch { found.cwd = process.cwd(); }
  return found;
}

export class HeadlessAdapter {
  constructor(host, { cwd, sessionId, model, resumed = false, guardPath }) {
    this.host = host; this.cwd = cwd; this.sessionId = sessionId; this.model = model; this.resumed = resumed;
    this.guardPath = guardPath;
    this.capabilities = { nativeLoop: false, existingSessionResume: true, trustedTurnCorrelation: true, preDispatchGuard: true, interrupt: true, liveDisplayControl: true, replayDisplayControl: true, cacheUsage: true, verifiedToolBlocking: true };
  }
  async init() { return { sessionId: this.sessionId, model: this.model || null }; }
  async history() { return transcript(this.host, this.sessionId); }
  lastActivityAt() { return lastReplyAt(this.host, this.sessionId); }
  async run({ text, turn, signal, bind, event, admit = () => !signal.aborted }) {
    if (!admit()) return { text: '', usage: null, cancelled: true };
    const claude = this.host === 'claude';
    const args = claude
      ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--plugin-dir', pluginRoot, '--permission-mode', 'dontAsk']
      : ['--no-subagents', '--output-format', 'streaming-messages-json', '--include-partial-messages', '--permission-mode', 'dontAsk', '--max-turns', '32', '-p', text];
    if (!claude && turn.source === 'keeper') args.push('--deny', '*');
    if (claude && turn.source === 'keeper') args.push('--max-turns', '1');
    args.push(this.resumed ? '--resume' : '--session-id', this.sessionId);
    if (this.model) args.push('--model', this.model);
    const before = new Set((await this.history()).map(m => m.id));
    if (!admit()) return { text: '', usage: null, cancelled: true };
    const child = this.child = launch(this.host, args, { cwd: this.cwd, env: { ...process.env, CACHEMAX_GUARD: this.guardPath, CACHEMAX_PLUGIN_ROOT: pluginRoot } });
    bind({ childPid: child.pid });
    let result, output = '', toolAttempt = false, protocolError, seenSession = false, measuredUsage = null;
    const ids = new Set([turn.requestKey]);
    const stop = () => { void terminate(child); };
    signal.addEventListener('abort', stop, { once: true });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const bindIds = () => bind({ messageIds: [...ids] });
    lines.on('line', line => {
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object') throw Error('Invalid host event');
        if (msg.session_id) {
          if (msg.session_id !== this.sessionId) throw Error('Host changed session ID');
          seenSession = true; this.resumed = true;
        }
        if (msg.uuid && ['user', 'assistant'].includes(msg.type)) { ids.add(msg.uuid); bindIds(); }
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (this.observedModel && this.observedModel !== msg.model) throw Error('Host model changed; keeper paused');
          this.observedModel = msg.model;
          bind({ model: msg.model });
          if (claude && (msg.plugin_errors?.length || !(msg.plugins || []).some(p => p.name.includes('cachemax')))) throw Error('cachemax guard plugin did not load');
        }
        if (msg.type === 'system' && ['api_retry', 'compact_boundary'].includes(msg.subtype) && turn.source === 'keeper') throw Error(`Host ${msg.subtype}; keeper paused`);
        const e = msg.type === 'stream_event' ? msg.event : msg;
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { output += e.delta.text; event({ kind: 'delta', text: e.delta.text }); }
        if (e.type === 'content_block_start' && ['tool_use', 'server_tool_use'].includes(e.content_block?.type)) toolAttempt = true;
        if (msg.type === 'assistant' && msg.message) {
          if (claude && msg.message.id) { ids.add(msg.message.id); bindIds(); }
          if (!output) output = contentText(msg.message.content);
          if (msg.message.content?.some(c => ['tool_use', 'server_tool_use'].includes(c.type))) toolAttempt = true;
          if (msg.message.usage) measuredUsage = usage(this.host, msg.message.usage);
        }
        if (msg.type === 'result') { result = msg; if (typeof msg.result === 'string') output = msg.result; if (msg.usage) measuredUsage = usage(this.host, msg.usage, msg.total_cost_usd); }
        if (toolAttempt && turn.source === 'keeper') { event({ kind: 'warning', message: 'Keeper attempted a tool; blocked and paused' }); stop(); }
      } catch (e) { protocolError = e; stop(); }
    });
    if (claude) child.stdin.end(JSON.stringify({ type: 'user', uuid: turn.requestKey, session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content: text } }) + '\n');
    else child.stdin.end();
    const ended = await child.done;
    signal.removeEventListener('abort', stop); lines.close(); this.child = null;
    const after = await this.history();
    // This subprocess is the sole writer. Persist exact host IDs, including cancelled turns.
    for (const m of after) if (!before.has(m.id)) ids.add(m.id);
    if (!claude) {
      const newTurns = new Set(after.filter(m => !before.has(m.id)).map(m => m.turnId));
      if (newTurns.size === 1) bind({ hostTurnId: [...newTurns][0] });
      else if (!signal.aborted) throw Error('Grok request could not be mapped to exactly one transcript turn');
    }
    bindIds();
    if (protocolError) throw protocolError;
    if (signal.aborted) return { text: output, usage: measuredUsage, toolAttempt };
    if (ended.error) throw ended.error;
    if (ended.code !== 0) throw Error(`${this.host} exited (${ended.code}). Run ${this.host === 'claude' ? 'claude auth status' : 'grok login'} and check your usage limit.`);
    if (result?.is_error) throw Error(`${this.host}: ${result.subtype || 'request failed'}`);
    if (claude && (!seenSession || !result)) throw Error('Missing Claude session or completion boundary');
    this.resumed = true;
    return { text: output, usage: measuredUsage, toolAttempt };
  }
  async close() { await terminate(this.child); }
}

export class CodexAdapter {
  constructor({ cwd, sessionId, model, guardPath }) {
    this.cwd = cwd; this.sessionId = sessionId; this.model = model; this.guardPath = guardPath;
    this.ownedTurns = new Map();
    this.capabilities = { nativeLoop: false, existingSessionResume: true, trustedTurnCorrelation: true, preDispatchGuard: true, interrupt: true, liveDisplayControl: true, replayDisplayControl: true, cacheUsage: true, verifiedToolBlocking: false };
  }
  async init() {
    this.failed = false;
    const command = `${shellQuote(process.execPath)} ${shellQuote(guardScript)}`;
    // JSON strings are valid TOML strings; the array/inline-table syntax is explicit.
    const hooks = `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 5 }] }]`;
    const args = ['app-server', '--listen', 'stdio://', '-c', `hooks.PreToolUse=${hooks}`, '-c', 'features.hooks=true', '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"'];
    const start = async extra => {
      this.rpc = new RPC('codex', [...args, ...extra], { cwd: this.cwd, env: { ...process.env, CACHEMAX_GUARD: this.guardPath || '' } });
      await this.rpc.request('initialize', { clientInfo: { name: 'cachemax', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      this.rpc.send({ method: 'initialized', params: {} });
      return this.rpc.request('hooks/list', { cwds: [this.cwd] });
    };
    let listed = await start([]);
    let guard = listed.data?.flatMap(d => d.hooks).find(h => h.command === command && h.eventName === 'preToolUse');
    if (guard && guard.trustStatus !== 'trusted' && guard.trustStatus !== 'managed') {
      // Trust only this bundled deny-only handler, for this child process; never edit user trust.
      await this.rpc.close();
      listed = await start(['-c', `hooks.state={ ${JSON.stringify(guard.key)} = { trusted_hash = ${JSON.stringify(guard.currentHash)} } }`]);
      guard = listed.data?.flatMap(d => d.hooks).find(h => h.command === command && h.eventName === 'preToolUse');
    }
    this.capabilities.verifiedToolBlocking = !!(guard?.enabled && ['trusted', 'managed'].includes(guard.trustStatus));
    if (!this.capabilities.verifiedToolBlocking) throw Error('Codex did not activate the keeper tool guard');
    const params = { cwd: this.cwd, ...(this.model ? { model: this.model } : {}), ...(this.sessionId ? { threadId: this.sessionId } : {}) };
    this.awaitingFirstTurn = !this.sessionId;
    const started = await this.rpc.request(this.sessionId ? 'thread/resume' : 'thread/start', params);
    this.sessionId = started.thread.id; this.model = started.model;
    if (started.thread.status?.type === 'active') throw Error('Codex thread is already active');
    this.lastCompletedAt = Math.max(0, ...(started.thread.turns || []).map(t => t.completedAt || 0)) * 1000 || null;
    this.auth = await this.rpc.request('account/read', {});
    return { sessionId: this.sessionId, model: this.model, auth: this.auth.account?.type, plan: this.auth.account?.planType };
  }
  async history() {
    if (this.awaitingFirstTurn) return [];
    const response = await this.rpc.request('thread/read', { threadId: this.sessionId, includeTurns: true });
    return response.thread.turns.flatMap(turn => (turn.items || []).flatMap(item => {
      if (item.type === 'userMessage') return [{ id: item.id, turnId: turn.id, role: 'user', text: contentText(item.content) }];
      if (item.type === 'agentMessage') return [{ id: item.id, turnId: turn.id, role: 'assistant', text: item.text }];
      return [];
    }));
  }
  async run({ text, turn, signal, bind, event, admit = () => !signal.aborted }) {
    if (this.failed) throw Error('Codex connection closed; restart the runner before sending another request');
    if (!admit()) return { text: '', usage: null, cancelled: true };
    let hostTurnId, buffered = [], output = '', measuredUsage = null, toolAttempt = false, finished = false, interrupted = false, abortTimer;
    let resolveTurn, rejectTurn;
    const done = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    void done.catch(() => {});
    // A completion can precede the turn/start response; install listeners before dispatch.
    const handle = msg => {
      if (finished) return;
      const p = msg.params || {};
      if (p.threadId && p.threadId !== this.sessionId) return;
      if (msg.id != null && msg.method) {
        if (msg.method.endsWith('requestApproval')) this.rpc.send({ id: msg.id, result: { decision: 'decline' } });
        else if (msg.method === 'item/tool/requestUserInput') this.rpc.send({ id: msg.id, result: { answers: {} } });
        else this.rpc.send({ id: msg.id, error: { code: -32601, message: 'Client interaction unavailable' } });
        if (turn.source === 'keeper') { toolAttempt = true; event({ kind: 'warning', message: 'Keeper requested a tool; denied' }); void cancel(); }
        else event({ kind: 'warning', message: 'Host requested approval. This unattended path denied it; use the native CLI to approve.' });
        return;
      }
      const id = p.turnId || p.turn?.id;
      if (id && id !== hostTurnId) {
        if (msg.method === 'item/agentMessage/delta' && this.ownedTurns.get(id) !== 'keeper') event({ kind: 'unowned', turnId: id, text: p.delta });
        return;
      }
      if (msg.method === 'hook/started' && p.run?.eventName === 'preToolUse' && turn.source === 'keeper') { toolAttempt = true; event({ kind: 'warning', message: 'Keeper attempted a tool; paused' }); void cancel(); }
      if (msg.method === 'item/agentMessage/delta') { output += p.delta; event({ kind: 'delta', text: p.delta }); }
      if (msg.method === 'thread/tokenUsage/updated') measuredUsage = usage('codex', p.tokenUsage?.last);
      if (msg.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(p.item?.type)) {
        toolAttempt = true;
        if (turn.source === 'keeper') { event({ kind: 'warning', message: 'Keeper attempted a tool; paused' }); void cancel(); }
        else event({ kind: 'tool', name: p.item?.type || 'tool' });
      }
      if (msg.method === 'turn/completed') {
        finished = true;
        if (p.turn.status === 'failed') rejectTurn(Error(p.turn.error?.message || 'Codex turn failed'));
        else resolveTurn({ text: output, usage: measuredUsage, toolAttempt });
      }
      if (msg.method === 'thread/compacted' && turn.source === 'keeper') event({ kind: 'warning', message: 'Context compacted; cache status must be re-evaluated' });
    };
    const listen = msg => { if (!hostTurnId) buffered.push(msg); else handle(msg); };
    const failure = e => rejectTurn(e);
    const cancel = async () => {
      if (!hostTurnId || finished || interrupted) return;
      interrupted = true;
      abortTimer = setTimeout(async () => { await this.rpc.close(); rejectTurn(Error('Codex cancellation timed out; server closed')); }, 10000);
      try { await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: hostTurnId }); } catch (e) { await this.rpc.close(); rejectTurn(e); }
    };
    this.rpc.on('message', listen); this.rpc.on('failure', failure);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!admit()) return { text: '', usage: null, cancelled: true };
      const started = await this.rpc.request('turn/start', { threadId: this.sessionId, input: [{ type: 'text', text }], clientUserMessageId: turn.requestKey });
      hostTurnId = started.turn.id;
      this.awaitingFirstTurn = false;
      this.ownedTurns.set(hostTurnId, turn.source);
      if (!hostTurnId) throw Error('Codex returned no turn ID');
      bind({ hostTurnId, childPid: this.rpc.child.pid, model: this.model });
      for (const msg of buffered) handle(msg);
      buffered = [];
      if (signal.aborted) await cancel();
      return await done;
    } catch (e) { this.failed = true; await this.rpc.close(); throw e; }
    finally { clearTimeout(abortTimer); signal.removeEventListener('abort', cancel); this.rpc.off('message', listen); this.rpc.off('failure', failure); }
  }
  lastActivityAt() { return this.lastCompletedAt; }
  async close() { await this.rpc?.close(); }
}
