const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const auth = { Authorization: `Bearer ${token}` };
const nodes = new Map();
let status, activityAt = 0;
const error = text => { $('error').textContent = text; $('error').hidden = !text; };
const amount = value => value === null || value === undefined ? 'Unknown' : value.toLocaleString();
const time = value => value ? new Date(value).toLocaleTimeString() : 'None';
const span = ms => ms % 3600000 === 0 ? `${ms / 3600000}h` : ms % 60000 === 0 ? `${ms / 60000}m` : `${ms / 1000}s`;
function ttlChanged() {
  const custom = $('ttl').value === 'custom';
  $('custom-ttl-label').hidden = !custom; $('custom-ttl').required = custom; $('custom-ttl').disabled = !custom;
}
async function api(path, data) {
  const response = await fetch(path, { headers: { ...auth, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Request failed');
  return result;
}
function renderStatus(s) {
  if (!status && s.durationMs) {
    $('duration').value = span(s.durationMs); $('interval').value = s.intervalOverride ?? ''; $('max-ticks').value = s.maxTicks;
    const ttl = s.ttlMs ? span(s.ttlMs) : '';
    $('ttl').value = ['', '5m', '1h'].includes(ttl) ? ttl : 'custom'; $('custom-ttl').value = ttl;
    $('max-tokens').value = s.maxTokens ?? ''; $('max-cost').value = s.maxCostUSD ?? '';
  }
  status = s;
  ttlChanged();
  $('max-cost').disabled = s.host === 'codex';
  $('cost-help').textContent = s.host === 'codex' ? 'Codex does not report cost. Use the token and request limits.' : 'CLI cost estimates may differ from billing. Claude needs consecutive cost reports; a missing baseline pauses a cost-limited run.';
  $('host').textContent = s.host;
  $('session').textContent = s.sessionId;
  $('phase').textContent = { off: 'Off', armed: 'Waiting', heartbeat: 'Maintenance', yielding: 'Returning to you', user_turn: 'Working', paused: 'Paused', stopped: 'Off' }[s.phase] || s.phase;
  // Keeper activity never changes the conversation, its scroll anchor, or the composer.
  $('working').textContent = s.busy === 'user' ? 'Working…' : '';
  if (s.warning) error(s.warning);
  const m = s.maintenance;
  $('last-success').textContent = time(m.lastSuccessAt);
  $('next-request').textContent = s.nextDueAt ? time(s.nextDueAt) : s.enabled && s.busy ? 'After the current turn' : 'Not scheduled';
  $('attempts').textContent = `${m.submitted} / ${s.maxTicks}${m.pending ? ' · in progress' : ''}`;
  $('outcomes').textContent = `${m.successful} / ${m.failed} / ${m.interrupted}`;
  $('total-tokens').textContent = amount(m.totalTokens);
  $('total-cost').textContent = m.costUSD === null ? 'Unknown' : `$${m.costUSD.toFixed(6)}`;
  $('usage-detail').textContent = `Input ${amount(m.inputTokens)} (cached reads ${amount(m.cacheReadTokens)}, cache writes ${amount(m.cacheWriteTokens)}) · output ${amount(m.outputTokens)}. Usage appears after completion.`;
  $('active-settings').textContent = s.durationMs ? `${s.enabled ? 'Enabled' : 'Last activation'} · duration ${span(s.durationMs)} · TTL ${s.ttlMs ? span(s.ttlMs) + ' (selected)' : 'unknown'} · interval ${span(s.intervalMs)} · token threshold ${s.maxTokens ?? 'none'} · cost threshold ${s.maxCostUSD === null ? 'none' : '$' + s.maxCostUSD}` : 'Off · no requests scheduled';
  $('stop-reason').textContent = s.warning || ({ token_limit: 'Stopped: token threshold reached.', cost_limit: 'Stopped: cost threshold reached.', tick_limit: 'Stopped: request limit reached.', expired: 'Stopped: duration ended.', manual: 'Turned off.', shutdown: 'Runner stopped.' }[s.stopReason] || '');
}
function message(m, append = false, scroll = true) {
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 230;
  $('empty').hidden = true;
  let pre = nodes.get(m.id);
  if (!pre) {
    const article = document.createElement('article'); article.className = `message ${m.role}`;
    const role = document.createElement('span'); role.className = 'role'; role.textContent = m.role === 'user' ? 'You' : 'Assistant';
    pre = document.createElement('pre'); article.append(role, pre); $('conversation').append(article); nodes.set(m.id, pre);
  }
  pre.textContent = append ? pre.textContent + m.text : m.text;
  if (scroll && nearBottom) window.scrollTo(0, document.documentElement.scrollHeight);
}
function event({ type, data }) {
  if (type === 'snapshot') {
    const hadMessages = nodes.size > 0, scrollY = window.scrollY;
    const nearBottom = window.innerHeight + scrollY >= document.documentElement.scrollHeight - 230;
    const anchor = [...nodes.values()].map(n => n.parentElement).find(n => n.getBoundingClientRect().bottom > 120);
    const top = anchor?.getBoundingClientRect().top;
    renderStatus(data.status);
    const ids = new Set(data.messages.map(m => m.id));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.parentElement.remove(); nodes.delete(id); }
    for (const m of data.messages) { message(m, false, false); $('conversation').append(nodes.get(m.id).parentElement); }
    $('empty').hidden = data.messages.length > 0;
    if (!hadMessages || nearBottom) window.scrollTo(0, document.documentElement.scrollHeight);
    else if (anchor?.isConnected) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
    else window.scrollTo(0, scrollY);
    return;
  }
  if (type === 'status') renderStatus(data);
  if (type === 'message' || type === 'answer') message(data);
  if (type === 'turnEvent' && data.kind === 'delta') message({ id: data.requestKey + ':assistant', role: 'assistant', text: data.text }, true);
  if (type === 'warning' || (type === 'turnEvent' && ['warning', 'error'].includes(data.kind))) error(data.message);
}
async function stream() {
  let attempts = 0, reader;
  while (true) try {
    const response = await fetch('/events', { headers: auth });
    if ([401, 403].includes(response.status)) { $('connection').textContent = 'Disconnected'; error('Session access changed. Open the private URL printed by the current runner.'); return; }
    if (!response.ok) throw Error('Session connection failed');
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    $('connection').textContent = 'Local · connected';
    attempts = 0;
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (packet.startsWith('data: ')) event(JSON.parse(packet.slice(6)));
      }
    }
    throw Error('Session connection ended');
  } catch {
    $('connection').textContent = 'Reconnecting…';
    // Reconnect only the display stream. This never enables paid maintenance or resends input.
    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** attempts++, 10000)));
  } finally { await reader?.cancel().catch(() => {}); reader = null; }
}
async function activate(value = $('duration').value) {
  if (!$('activate').reportValidity()) throw Error('Check the maintenance settings.');
  const s = await api('/on', { duration: value, ttl: $('ttl').value === 'custom' ? $('custom-ttl').value : $('ttl').value || null,
    interval: $('interval').value || undefined, maxTicks: Number($('max-ticks').value),
    maxTokens: $('max-tokens').value === '' ? null : Number($('max-tokens').value),
    maxCostUSD: $('max-cost').disabled || $('max-cost').value === '' ? null : Number($('max-cost').value) });
  renderStatus(s);
  $('notice').textContent = `Enabled until ${time(s.expiresAt)}; interval ${span(s.intervalMs)}, at most ${s.maxTicks} requests.${s.durationMs <= s.intervalMs ? ' No request fits before the end time; choose a longer duration to send maintenance.' : ''}`;
}
$('ttl').onchange = ttlChanged;
ttlChanged();
$('activate').onsubmit = async e => {
  e.preventDefault(); error('');
  try {
    await activate();
  } catch (e) { error(e.message); }
};
$('off').onclick = async () => { try { renderStatus(await api('/off', {})); $('notice').textContent = 'Keepalive is off.'; } catch (e) { error(e.message); } };
async function diagnostics(hidden) {
  try { $('dialog-title').textContent = hidden ? 'Original conversation · includes hidden turns' : 'Maintenance activity'; $('details').textContent = JSON.stringify(await api(hidden ? '/hidden' : '/logs'), null, 2); $('diagnostics').showModal(); } catch (e) { error(e.message); }
}
$('logs').onclick = () => diagnostics(false); $('hidden').onclick = () => diagnostics(true); $('dismiss').onclick = () => $('diagnostics').close();
$('composer').onsubmit = async e => {
  e.preventDefault(); const text = $('input').value; if (!text.trim()) return;
  error(''); $('send').disabled = true;
  try {
    if (text.startsWith('/cachemax')) {
      const command = text.split(/\s+/).slice(1).join(' ') || 'status';
      if (command === 'off') await api('/off', {});
      else if (command === 'status') $('notice').textContent = JSON.stringify(status);
      else if (command === 'logs' || command === 'show-hidden') await diagnostics(command === 'show-hidden');
      else await activate(command);
    } else await api('/message', { text });
    if ($('input').value === text) $('input').value = '';
  } catch (e) { error(e.message); }
  finally { $('send').disabled = false; $('input').focus(); }
};
$('input').oninput = () => { if (Date.now() - activityAt > 1000) { activityAt = Date.now(); void api('/activity', {}).catch(() => {}); } };
$('input').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('composer').requestSubmit(); };
if (!token) error('Open the private URL printed by cachemax run.'); else void stream();
