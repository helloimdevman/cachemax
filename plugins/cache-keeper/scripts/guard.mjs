#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// This guard only denies. It never grants a tool permission or changes its input.
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const event = JSON.parse(input);
  if (!process.env.CACHE_KEEPER_GUARD) process.exit(0);
  const state = JSON.parse(readFileSync(process.env.CACHE_KEEPER_GUARD, 'utf8'));
  const name = event.tool_name || event.toolName || '';
  if (state.source !== 'keeper' && !/^(Agent|Task|spawn_agent|spawn_team|team_create)$/i.test(name)) process.exit(0);
  const reason = state.source === 'keeper' ? 'Cache Keeper blocks tools during maintenance turns.' : 'Subagents are disabled in Cache Keeper.';
  process.stdout.write(JSON.stringify({ decision: 'deny', reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
} catch {
  process.stderr.write('Cache Keeper tool guard could not read its state. Tool denied.');
  process.exitCode = 2;
}
