import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const PROMPT = 'Only .';
export function duration(value) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(String(value));
  const ms = m && Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
  if (!ms || !Number.isSafeInteger(ms) || ms > 86400000) throw Error('Duration must be positive, e.g. 30m or 2h, and at most 24h');
  return ms;
}
const clock = { now: () => performance.now(), wall: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };
const known = value => Number.isFinite(value) && value >= 0;
const sum = values => values.every(known) ? values.reduce((a, b) => a + b, 0) : null;

export class Keeper extends EventEmitter {
  constructor(adapter, store, options = {}) {
    super();
    this.adapter = adapter;
    this.store = store;
    this.clock = options.clock || clock;
    this.timeoutMs = options.timeoutMs || 120000;
    this.state = { maxTicks: 10, ttlMs: null, maxTokens: null, maxCostUSD: null, ...store.data.activation, phase: 'off', generation: store.data.generation || 0, admittedTicks: 0, nextDueAt: null, cache: 'cache_unknown' };
    this.lastReportedCost = null;
    this.queue = [];
    this.active = null;
    this.enabled = false;
    this.editingUntil = 0;
    this.closed = false;
  }
  maintenance() {
    // ponytail: scan the latest activation (at most 120 keeper turns); index if long user histories make this slow.
    const turns = this.store.data.turns.slice(this.state.startTurnIndex ?? this.store.data.turns.length)
      .filter(t => t.source === 'keeper' && t.generation === this.state.activationGeneration);
    const done = turns.filter(t => t.status !== 'submitted');
    const input = done.map(t => this.store.data.host === 'codex' ? t.usage?.inputTokens
      : sum([t.usage?.inputTokens, t.usage?.cacheReadTokens, t.usage?.cacheWriteTokens]));
    const inputTokens = sum(input), outputTokens = sum(done.map(t => t.usage?.outputTokens));
    return { submitted: turns.length, successful: turns.filter(t => t.keeperOK).length,
      failed: turns.filter(t => t.status === 'failed' || (t.status === 'completed' && !t.keeperOK)).length,
      interrupted: turns.filter(t => t.status === 'interrupted').length, pending: turns.length - done.length,
      lastStartedAt: turns.at(-1)?.startedAt ?? null, lastSuccessAt: turns.findLast(t => t.keeperOK)?.finishedAt ?? null,
      inputTokens, cacheReadTokens: sum(done.map(t => t.usage?.cacheReadTokens)),
      cacheWriteTokens: this.store.data.host === 'codex' ? null : sum(done.map(t => t.usage?.cacheWriteTokens)), outputTokens,
      totalTokens: done.some(t => t.status !== 'completed') ? null : sum([inputTokens, outputTokens]),
      costUSD: this.store.data.host === 'codex' || done.some(t => t.status !== 'completed') ? null : sum(done.map(t => t.estimatedCostUSD)) };
  }
  status() {
    const maintenance = this.maintenance();
    return { host: this.store.data.host, sessionId: this.store.data.sessionId, ...this.state, admittedTicks: maintenance.submitted, enabled: this.enabled, maintenance, busy: this.active?.turn.source || null };
  }
  publish() { this.emit('status', this.status()); }
  onFor(value = '30m', { interval, maxTicks = 10, ttl = null, maxTokens = null, maxCostUSD = null, requireNativeLoop = false } = {}) {
    if (requireNativeLoop) throw Error('Native loop does not provide verified quiet display and dispatch guards. Use managed-quiet.');
    if (this.closed) throw Error('Session is closed');
    if (this.active?.turn.source === 'keeper') throw Error('Wait for the previous keeper request to finish');
    if (!this.adapter.capabilities.verifiedToolBlocking) throw Error('Keeper tool guard is unavailable; run doctor and review the guard setup');
    if (typeof ttl === 'string') ttl = duration(ttl);
    if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400000)) throw Error('TTL must be unknown or a positive duration up to 24h');
    const durationMs = duration(value), intervalMs = interval === undefined
      ? ttl === null || ttl === 300000 ? 180000 : Math.max(1, Math.floor(ttl * 5 / 6)) : duration(interval);
    if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 120) throw Error('maxTicks must be an integer from 1 to 120');
    if (ttl && intervalMs >= ttl) throw Error('Interval must be shorter than your selected TTL');
    if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw Error('Token limit must be a positive integer');
    if (maxCostUSD !== null && (!known(maxCostUSD) || maxCostUSD <= 0)) throw Error('Cost limit must be a positive number');
    if (maxCostUSD !== null && this.store.data.host === 'codex') throw Error('Codex does not report cost; use a token or request limit');
    if (!this.store.owns()) throw Error('Session ownership lost');
    this.clearTimers();
    this.clock.clear(this.watchTimer);
    this.enabled = false;
    this.failures = 0;
    const now = this.clock.now();
    this.deadline = now + durationMs;
    this.due = now + intervalMs;
    this.lastClock = now;
    this.lastWall = this.clock.wall();
    const activation = { activationGeneration: this.state.generation + 1, startTurnIndex: this.store.data.turns.length, activatedAt: this.lastWall, expiresAt: this.lastWall + durationMs, durationMs, intervalMs, intervalOverride: interval ?? null, ttlMs: ttl, maxTicks, maxTokens, maxCostUSD };
    Object.assign(this.state, activation, { phase: this.active ? 'user_turn' : 'armed', generation: activation.activationGeneration, admittedTicks: 0, cache: 'cache_unknown', warning: null, stopReason: null, capMayEndEarly: Math.ceil(durationMs / intervalMs) - 1 > maxTicks });
    this.store.data.activation = activation;
    this.store.data.generation = this.state.generation;
    try { this.store.event('activated', activation); }
    catch (e) { this.state.phase = 'paused'; this.state.warning = 'Activation could not be saved; maintenance stayed off'; this.publish(); throw e; }
    this.enabled = true;
    this.watchNow = now; this.watchWall = this.lastWall;
    this.watchClock(this.state.generation); this.schedule(); this.publish();
    return this.status();
  }
  clearTimers() { this.clock.clear(this.timer); this.clock.clear(this.expiryTimer); }
  watchClock(generation) {
    if (!this.enabled || generation !== this.state.generation) return;
    const now = this.clock.now(), wall = this.clock.wall();
    const gap = now - this.watchNow > 10000 || Math.abs((wall - this.watchWall) - (now - this.watchNow)) > 10000;
    this.watchNow = now; this.watchWall = wall;
    if (gap) {
      this.state.cache = 'cache_unknown'; this.state.lastGapAt = wall;
      this.store.event('gap_detected');
      this.due = now + this.state.intervalMs;
      this.lastClock = now; this.lastWall = wall;
      if (this.active?.turn.source === 'keeper') this.active.controller.abort('resume_gap');
    }
    if (now >= this.deadline || wall >= this.state.expiresAt) { this.off('expired'); return; }
    if (gap) { this.schedule(); this.publish(); }
    this.watchTimer = this.clock.set(() => this.watchClock(generation), 1000);
  }
  schedule() {
    this.clearTimers();
    this.state.nextDueAt = null;
    if (!this.enabled) return;
    const now = this.clock.now();
    const generation = this.state.generation;
    if (now >= this.deadline || this.clock.wall() >= this.state.expiresAt) { this.off('expired'); return; }
    this.expiryTimer = this.clock.set(() => { if (generation === this.state.generation) this.off('expired'); }, this.deadline - now);
    if (this.active || this.queue.length || this.due >= this.deadline) return;
    this.state.nextDueAt = this.clock.wall() + Math.max(0, this.due - now);
    this.timer = this.clock.set(() => { if (generation === this.state.generation) void this.tick(); }, Math.max(0, this.due - now));
  }
  activity() { this.editingUntil = this.clock.now() + 5000; }
  async tick() {
    if (!this.enabled || this.closed) return;
    const now = this.clock.now(), wall = this.clock.wall();
    if (!this.store.owns()) { this.pause('Session ownership lost'); return; }
    if (now >= this.deadline || wall >= this.state.expiresAt) { this.off('expired'); return; }
    if (this.state.admittedTicks >= this.state.maxTicks) { this.off('tick_limit'); return; }
    if (this.active || this.queue.length || now < this.editingUntil) {
      this.due = Math.max(now + 1000, this.editingUntil); this.schedule(); this.publish(); return;
    }
    if (now < this.due) { this.schedule(); this.publish(); return; }
    if (now - this.due > this.state.intervalMs || Math.abs((wall - this.lastWall) - (now - this.lastClock)) > 10000) {
      this.state.cache = 'cache_unknown'; this.store.event('gap_detected');
    }
    this.lastClock = now; this.lastWall = wall;
    // No await between the final admission checks and creating the active request.
    this.state.admittedTicks++;
    await this.execute('keeper', PROMPT);
  }
  user(text) {
    if (this.closed) return Promise.reject(Error('Session is closed'));
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) return Promise.reject(Error('Message must contain 1–100000 characters'));
    this.clock.clear(this.timer);
    const requestKey = randomUUID();
    const promise = new Promise((resolve, reject) => this.queue.push({ text, requestKey, resolve, reject }));
    this.emit('message', { id: requestKey + ':user', role: 'user', text, requestKey });
    if (this.active?.turn.source === 'keeper') {
      this.state.phase = 'yielding'; this.active.controller.abort('user_returned'); this.publish();
    }
    void this.drain();
    return promise;
  }
  async drain() {
    if (this.active || this.closed) return;
    const item = this.queue.shift();
    if (!item) { this.schedule(); return; }
    try { item.resolve(await this.execute('user', item.text, item.requestKey)); } catch (e) { item.reject(e); }
    void this.drain();
  }
  async execute(source, text, requestKey = randomUUID()) {
    if (this.active) throw Error('Concurrent request refused');
    const turn = { requestKey, source, generation: this.state.generation, startedAt: this.clock.wall(), messageIds: [], status: 'submitted' };
    const controller = new AbortController();
    this.active = { turn, controller };
    this.state.phase = source === 'keeper' ? 'heartbeat' : 'user_turn';
    this.state.nextDueAt = null;
    this.state.lastRequestStartedAt = turn.startedAt;
    let textReceived = '';
    const timeout = this.clock.set(() => controller.abort('request_timeout'), this.timeoutMs);
    try {
      this.store.data.turns.push(turn);
      this.store.guard(source, turn.requestKey);
      this.store.save();
      this.publish();
      const result = await this.adapter.run({ text, turn, signal: controller.signal,
        admit: () => !controller.signal.aborted && !this.closed && this.store.owns() && (source !== 'keeper' || (this.enabled && turn.generation === this.state.generation && this.clock.now() < this.deadline && this.clock.wall() < this.state.expiresAt && !this.queue.length && this.state.admittedTicks <= this.state.maxTicks)),
        bind: metadata => { Object.assign(turn, metadata); if (metadata.model) this.store.data.observedModel = metadata.model; this.store.save(); },
        event: event => {
          if (event.kind === 'warning') { this.pause(event.message); return; }
          if (event.kind === 'unowned') {
            this.pause('Unrecognized host turn; maintenance stopped');
            this.emit('message', { id: `unowned:${event.turnId}:${randomUUID()}`, role: 'assistant', text: event.text });
            return;
          }
          if (source === 'keeper') return;
          if (event.kind === 'delta') textReceived += event.text;
          this.emit('turnEvent', { ...event, requestKey: turn.requestKey });
        }
      });
      turn.status = controller.signal.aborted || result.cancelled ? 'interrupted' : 'completed';
      turn.usage = result.usage || null;
      const reported = turn.usage?.reportedSessionCostUSD;
      turn.estimatedCostUSD = this.store.data.host === 'claude'
        ? known(reported) && known(this.lastReportedCost) && reported >= this.lastReportedCost ? reported - this.lastReportedCost : null
        : known(turn.usage?.costUSD) ? turn.usage.costUSD : null;
      this.lastReportedCost = turn.status === 'completed' && known(reported) ? reported : null;
      turn.finishedAt = this.clock.wall();
      turn.keeperOK = source === 'keeper' && turn.status === 'completed' && !result.toolAttempt && result.text?.trim() === '.';
      this.state.cache = !controller.signal.aborted && result.usage?.cacheReadTokens > 0 ? 'cache_observed' : 'cache_unknown';
      this.state.lastUsageSource = source;
      this.state.lastUsageAt = turn.finishedAt;
      this.store.save();
      if (source === 'user') {
        this.emit('answer', { id: turn.requestKey + ':assistant', role: 'assistant', requestKey: turn.requestKey, text: result.text ?? textReceived });
        this.state.lastVisibleAssistantMessageId = turn.requestKey + ':assistant';
      } else if (!controller.signal.aborted && !result.cancelled && turn.generation === this.state.generation) {
        if (result.toolAttempt || result.text.trim() !== '.') this.pause(result.toolAttempt ? 'Keeper attempted a tool; paused' : 'Unexpected keeper response; paused');
        else {
          this.failures = 0;
          this.state.cache = result.usage?.cacheReadTokens > 0 ? 'cache_observed' : 'cache_unknown';
          this.store.event('request_ok', { requestKey: turn.requestKey, cache: this.state.cache, usage: result.usage || null });
        }
      }
      return result;
    } catch (e) {
      this.lastReportedCost = null;
      turn.keeperOK = false;
      turn.status = controller.signal.aborted ? 'interrupted' : 'failed';
      turn.finishedAt = this.clock.wall();
      try { if (this.store.owns()) this.store.save(); } catch { this.closed = true; }
      if (!controller.signal.aborted || controller.signal.reason === 'request_timeout') this.pause(e.message || 'Request failed');
      if (e.uncertain) {
        this.closed = true;
        for (const item of this.queue.splice(0)) item.reject(Error('Host termination was not confirmed; queued input was not sent'));
      }
      if (source === 'user') { this.emit('turnEvent', { kind: 'error', message: e.message, requestKey: turn.requestKey }); throw e; }
    } finally {
      this.clock.clear(timeout);
      try { this.store.guard('idle', null); } catch { this.closed = true; this.enabled = false; this.clearTimers(); }
      this.active = null;
      if (this.enabled && source === 'keeper') {
        const measured = this.maintenance();
        if ((this.state.maxTokens !== null && measured.totalTokens === null) || (this.state.maxCostUSD !== null && measured.costUSD === null)) this.pause('Budget usage unavailable; maintenance paused');
        else if (this.state.maxTokens !== null && measured.totalTokens >= this.state.maxTokens) this.off('token_limit');
        else if (this.state.maxCostUSD !== null && measured.costUSD >= this.state.maxCostUSD - 1e-12) this.off('cost_limit');
      }
      if (this.enabled) {
        this.state.phase = 'armed';
        this.due = this.clock.now() + this.state.intervalMs;
        if (this.state.admittedTicks >= this.state.maxTicks) this.off('tick_limit');
      } else if (['user_turn', 'heartbeat', 'yielding'].includes(this.state.phase)) this.state.phase = this.state.warning ? 'paused' : 'off';
      this.schedule(); this.publish(); this.emit('idle'); void this.drain();
    }
  }
  off(reason = 'manual') {
    this.enabled = false; this.clearTimers();
    this.clock.clear(this.watchTimer);
    this.state.generation++; this.store.data.generation = this.state.generation;
    this.state.phase = 'stopped'; this.state.nextDueAt = null;
    this.state.stopReason = reason;
    this.state.warning = null;
    if (this.active?.turn.source === 'keeper') this.active.controller.abort(reason);
    this.store.event('stopped', { reason }); this.publish();
    return this.status();
  }
  pause(message) {
    this.enabled = false; this.clearTimers();
    this.clock.clear(this.watchTimer);
    this.state.phase = 'paused'; this.state.warning = String(message).slice(0, 400); this.state.nextDueAt = null;
    if (this.active?.turn.source === 'keeper') this.active.controller.abort('paused');
    this.store.event('paused', { reason: this.state.warning }); this.publish();
  }
  async close() {
    this.closed = true; this.off('shutdown');
    if (this.active) this.active.controller.abort('shutdown');
    for (const item of this.queue.splice(0)) item.reject(Error('Session closed before input was submitted'));
    await this.adapter.close();
    if (this.active) await new Promise(resolve => this.once('idle', resolve));
  }
}
