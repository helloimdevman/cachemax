// Run from the checkout: node tests/browser-reconnect.mjs (requires Ego Lite).
// Only a local fake host is used. No model requests or account credentials.
const fs = await import('node:fs/promises');
const { join } = await import('node:path');
if (process.argv.includes('--server')) {
  const { managed } = await import('../plugins/cachemax/scripts/server.mjs');
  const { tmpdir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Conversation ${i}\n` + 'A preserved line of conversation.\n'.repeat(5) }));
  const adapter = { capabilities: { verifiedToolBlocking: true }, init: async () => ({ sessionId: randomUUID() }), history: async () => rows,
    run: async ({ text, turn, event, bind }) => {
      const ids = [turn.requestKey + ':user', turn.requestKey + ':assistant']; bind({ messageIds: ids });
      const answer = turn.source === 'keeper' ? '.' : 'Received: ' + text;
      rows.push({ id: ids[0], role: 'user', text }, { id: ids[1], role: 'assistant', text: answer });
      event({ kind: 'delta', text: answer }); return { text: answer, usage: { inputTokens: 100, cacheReadTokens: 90, cacheWriteTokens: null, outputTokens: 5, reasoningTokens: 0, costUSD: null } };
    }, close: async () => {} };
  const session = await managed({ host: 'codex', adapter, home: await fs.mkdtemp(join(tmpdir(), 'keeper-browser-')) });
  session.keeper.onFor('2m', { interval: '5s', maxTicks: 20 });
  console.log(JSON.stringify({ url: session.url }));
  // Test-only Node handle inspection drops sockets without stopping the keeper.
  process.on('SIGUSR1', () => { for (const h of process._getActiveHandles()) if (h.constructor.name === 'Server') h.closeAllConnections(); });
  process.on('SIGTERM', async () => { await session.close(); process.exit(0); });
} else if (typeof taskSpace !== 'function') {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const source = await fs.readFile(new URL(import.meta.url), 'utf8');
  const browser = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ended = once(browser, 'exit');
  // Ego's Node helper has a different cwd and executable. Pass paths as JS data, never shell code.
  browser.stdin.end(`const testRoot = ${JSON.stringify(process.cwd())}; const testNode = ${JSON.stringify(process.execPath)};\n${source}`);
  const [code] = await ended; process.exitCode = code ?? 1;
} else {
  const assert = (await import('node:assert/strict')).default;
  await fs.mkdir(join(testRoot, 'test-results/plugin-settings'), { recursive: true });
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { once } = await import('node:events');
  const child = spawn(testNode, [join(testRoot, 'tests/browser-reconnect.mjs'), '--server'], { cwd: testRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  const ended = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(10000) });
    const { url } = JSON.parse(line);
    const task = await taskSpace('cachemax reconnect regression');
    console.log({ taskSpaceId: task.spaceId });
    const page = task.page('p1');
    await page.goto(url); console.log(await page.snapshot());
    await page.fill('loc=css:#input', 'preserved draft');
    const before = await page.evaluate(() => {
      const input = document.getElementById('input'); input.setSelectionRange(2, 6); window.scrollTo(0, 1200);
      const anchor = [...document.querySelectorAll('.message')].find(n => n.getBoundingClientRect().bottom > 120);
      window.__snapshots = 0; new MutationObserver(() => window.__snapshots++).observe(document.getElementById('conversation'), { childList: true });
      return { draft: input.value, start: input.selectionStart, end: input.selectionEnd, anchor: anchor.querySelector('pre').textContent, top: anchor.getBoundingClientRect().top, count: document.querySelectorAll('.message').length };
    });
    child.kill('SIGUSR1');
    await page.waitForFunction(() => window.__snapshots > 0 && document.getElementById('connection').textContent === 'Local · connected', undefined, { timeout: 10000 });
    const after = await page.evaluate(() => {
      const input = document.getElementById('input'), anchor = [...document.querySelectorAll('.message')].find(n => n.getBoundingClientRect().bottom > 120);
      return { draft: input.value, start: input.selectionStart, end: input.selectionEnd, anchor: anchor.querySelector('pre').textContent, top: anchor.getBoundingClientRect().top, count: document.querySelectorAll('.message').length };
    });
    assert.deepEqual(after, before);
    await page.click('loc=css:#send');
    await page.waitForFunction(() => [...document.querySelectorAll('.message pre')].some(n => n.textContent === 'Received: preserved draft'), undefined, { timeout: 5000 });
    await page.click('loc=css:#off');
    const count = await page.evaluate(async () => {
      window.__snapshots = 0; window.__offAt = Date.now();
      const r = await fetch('/logs', { headers: { Authorization: 'Bearer ' + location.hash.slice(1) } });
      return (await r.json()).turns.filter(t => t.source === 'keeper').length;
    });
    child.kill('SIGUSR1');
    await page.waitForFunction(() => window.__snapshots > 0 && Date.now() - window.__offAt > 6000 && document.getElementById('connection').textContent === 'Local · connected', undefined, { timeout: 15000 });
    const final = await page.evaluate(async () => {
      const r = await fetch('/logs', { headers: { Authorization: 'Bearer ' + location.hash.slice(1) } }), d = await r.json();
      return { phase: document.getElementById('phase').textContent, users: d.turns.filter(t => t.source === 'user').length, keepers: d.turns.filter(t => t.source === 'keeper').length };
    });
    assert.deepEqual(final, { phase: 'Off', users: 1, keepers: count });
    console.log('PASS: reconnect preserves draft, selection and reading position; no activation or resubmission');
    console.log(await page.snapshot({ scope: 'full_page' }));
    await page.fill('loc=css:#duration', '2h');
    await page.selectOption('loc=css:#ttl', '1h');
    await page.fill('loc=css:#interval', '');
    await page.click('loc=css:#activate button');
    await page.waitForFunction(() => document.getElementById('active-settings').textContent.includes('interval 50m'));
    await page.click('loc=css:#off');
    await page.selectOption('loc=css:#ttl', 'custom');
    console.log(await page.snapshot({ scope: 'full_page' }));
    await page.fill('loc=css:#custom-ttl', '2s');
    await page.fill('loc=css:#duration', '30s');
    await page.fill('loc=css:#max-ticks', '10');
    await page.fill('loc=css:#max-tokens', '150');
    await page.click('loc=css:#activate button');
    await page.waitForFunction(() => document.getElementById('stop-reason').textContent === 'Stopped: token threshold reached.', undefined, { timeout: 15000 });
    const settings = await page.evaluate(() => ({ total: document.getElementById('total-tokens').textContent,
      outcomes: document.getElementById('outcomes').textContent, attempts: document.getElementById('attempts').textContent,
      lastSuccess: document.getElementById('last-success').textContent, next: document.getElementById('next-request').textContent,
      costDisabled: document.getElementById('max-cost').disabled, customTTL: document.getElementById('custom-ttl').value,
      hiddenPrompts: [...document.querySelectorAll('.message pre')].some(n => n.textContent === 'Only .') }));
    assert.equal(settings.total, '210'); assert.equal(settings.outcomes, '2 / 0 / 0');
    assert.equal(settings.attempts, '2 / 10'); assert.notEqual(settings.lastSuccess, 'None');
    assert.equal(settings.next, 'Not scheduled'); assert.equal(settings.costDisabled, true);
    assert.equal(settings.customTTL, '2s'); assert.equal(settings.hiddenPrompts, false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(testRoot, 'test-results/plugin-settings/desktop.png') });
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: join(testRoot, 'test-results/plugin-settings/mobile.png') });
    console.log('PASS: TTL presets and custom TTL, UI token stop, maintenance counters, hidden turns, and mobile layout');
    await task.finish({ keep: [] });
  } finally { child.kill('SIGTERM'); await ended; lines.close(); }
}
