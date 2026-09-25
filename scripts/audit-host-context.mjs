// Passive inspection of selected synthetic sessions. No model calls, transcript edits, or prompt export.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, globSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { skillBlocks } from './audit-codex-prefix.mjs';

const digest = content => {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { characters: text.length, sha256: createHash('sha256').update(text).digest('hex') };
};
export function contextRecords(host, rows, turns = []) {
  if (host === 'codex') return skillBlocks(rows);
  return rows.flatMap((row, index) => {
    if (host === 'claude' && row.type === 'attachment' && row.rendered) {
      const at = Date.parse(row.timestamp);
      const turn = turns.findIndex(t => at >= t.startedAt && at <= (t.finishedAt ?? Infinity));
      return [{ index, turn, kind: row.attachment?.type ?? 'unknown', ...digest(row.rendered) }];
    }
    if (host === 'grok' && (row.type === 'system' || (row.type === 'user' && !Number.isInteger(row.prompt_index)))) {
      return [{ index, kind: row.type === 'system' ? 'system' : row.synthetic_reason || 'unindexed_user', ...digest(row.content) }];
    }
    return [];
  });
}
if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'Pass a local JSON map of host -> controlled experiment state root');
  const roots = JSON.parse(readFileSync(process.argv[2], 'utf8')), sessions = [];
  for (const [host, root] of Object.entries(roots)) {
    assert.ok(['claude', 'codex', 'grok'].includes(host));
    const transcriptRoot = host === 'codex' ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
      : host === 'claude' ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
        : join(process.env.GROK_HOME || join(homedir(), '.grok'), 'sessions');
    for (const name of readdirSync(root).sort()) {
      const match = /^state-(\d+)-(control|keeper)$/.exec(name); if (!match) continue;
      const dir = join(root, name), files = readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      assert.equal(files.length, 1);
      const state = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
      assert.equal(state.host, host); assert.match(state.sessionId, /^[a-zA-Z0-9_-]{1,160}$/);
      const pattern = host === 'codex' ? `**/*-${state.sessionId}.jsonl` : host === 'claude' ? `**/${state.sessionId}.jsonl` : `*/${state.sessionId}/chat_history.jsonl`;
      const paths = globSync(pattern, { cwd: transcriptRoot }); assert.equal(paths.length, 1, 'Expected one original transcript');
      const raw = readFileSync(join(transcriptRoot, paths[0]), 'utf8');
      const lines = raw.trimEnd().split('\n');
      const rows = lines.map(line => JSON.parse(line));
      sessions.push({ host, trial: Number(match[1]), arm: match[2], transcriptSHA256: digest(raw).sha256,
        submittedRequests: state.turns.length, completedRequests: state.turns.filter(t => t.status === 'completed').length,
        context: contextRecords(host, rows, state.turns) });
    }
  }
  console.log(JSON.stringify({ observedAt: new Date().toISOString(),
    scope: 'Passive host transcript metadata; Codex skill blocks, Claude rendered attachments, Grok system/synthetic context. Not the complete outbound request or server cache key.',
    sessions }, null, 2));
}
