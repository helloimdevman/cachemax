// Read only explicitly selected synthetic sessions; export counters/hashes, never prompt text or IDs.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const hash = text => createHash('sha256').update(text).digest('hex');
export function skillBlocks(rows) {
  let turn = -1;
  const blocks = [];
  for (const row of rows) {
    if (row.type === 'event_msg' && row.payload?.type === 'task_started') turn++;
    if (row.type !== 'response_item' || row.payload?.role !== 'developer') continue;
    for (const content of row.payload.content || []) {
      const text = content.text;
      if (!text?.startsWith('<skills_instructions>')) continue;
      blocks.push({ turn, characters: text.length, sha256: hash(text),
        skillCount: text.split('\n').filter(l => l.includes('(file:')).length,
        rootCount: text.split('\n').filter(l => l.startsWith('- `r')).length });
    }
  }
  return blocks;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'session-dir': { type: 'string' } } });
  assert.ok(values['session-dir'] && positionals.length, 'Usage: --session-dir PATH study=CONTROLLED_STATE_ROOT ...');
  const files = readdirSync(values['session-dir']), sessions = [];
  for (const arg of positionals) {
    const split = arg.indexOf('='); assert.ok(split > 0, 'Expected study=CONTROLLED_STATE_ROOT');
    const study = arg.slice(0, split), root = arg.slice(split + 1);
    for (const name of readdirSync(root).sort()) {
      const match = /^state-(\d+)-(control|keeper)$/.exec(name); if (!match) continue;
      const dir = join(root, name), states = readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      assert.equal(states.length, 1, 'Expected one session per arm');
      const state = JSON.parse(readFileSync(join(dir, states[0]), 'utf8'));
      assert.equal(state.host, 'codex');
      const matches = files.filter(n => n.endsWith(`-${state.sessionId}.jsonl`));
      assert.equal(matches.length, 1, 'Expected one matching original transcript');
      const raw = readFileSync(join(values['session-dir'], matches[0]), 'utf8');
      const blocks = skillBlocks(raw.split('\n').filter(Boolean).map(line => JSON.parse(line)));
      sessions.push({ study, trial: Number(match[1]), arm: match[2], transcriptSHA256: hash(raw), skillBlocks: blocks,
        turnUsage: state.turns.map(t => ({ source: t.source, usage: t.usage })), injectedAfterSeed: blocks.some(b => b.turn > 0) });
    }
  }
  const catalogs = [...new Map(sessions.flatMap(s => s.skillBlocks).map(({ turn, ...b }) => [b.sha256, b])).values()];
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(),
    scope: 'Original local transcripts of explicitly selected synthetic Codex experiments; no new requests.',
    method: 'Count developer skills_instructions blocks by task_started turn. Export hashes and counters only, not paths, session IDs or content.',
    catalogs, sessions }, null, 2));
}
