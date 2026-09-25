---
name: cache-keeper
description: Enable, inspect, or stop bounded keepalive for Claude Code, Codex, and Grok sessions in Cache Keeper's managed conversation screen. Use when the user asks to keep a session or its cache ready while away.
argument-hint: "[30m|off|status|logs|show-hidden]"
disable-model-invocation: true
user-invocable: true
license: MIT
---

# Cache Keeper

Use the bundled `scripts/cli.mjs`, resolved from this skill's directory as
`../../scripts/cli.mjs`. It requires Node.js 22.18 or newer and the host CLI's
existing login. Do not read, copy, or replace authentication files.

1. Run `node <plugin-root>/scripts/cli.mjs status` to find managed sessions.
2. Before activation, use the user's selected TTL. If not provided, ask them to
   choose unknown, 5m, 1h, or a custom duration; never infer TTL from their plan.
   Use the given duration or default 30m, with 10 requests by default. Honor any
   requested interval, token threshold or cost threshold. For an owned session:
   `node <plugin-root>/scripts/cli.mjs on --host <host> --session <id> --duration 30m --ttl <ttl> --max-ticks 10`,
   omitting `--ttl` for unknown. Optional flags: `--interval <duration>`,
   `--max-tokens <integer>`, `--max-cost-usd <amount>` (Claude/Grok only).
   For read/stop requests, execute
   or `off`, `status`, `logs`, `show-hidden` with the same host/session options.
3. If the conversation is still running in the native CLI, provide this exact
   handoff command with its actual host, session ID, and working directory:
   `node <plugin-root>/scripts/cli.mjs run <host> --session <id> --cwd <cwd> --handoff`.
   Tell the user to finish the native turn, close that native session, then run
   the command in a terminal. Do not launch a second writer into this live session.
4. For a new managed session, `node <plugin-root>/scripts/cli.mjs run <host>` opens
   the local conversation page. Its keeper starts off; choose TTL and limits there.

Activation consumes subscription usage. Default duration 30m, default 10 requests,
maximum 120 requests and 24h. Auto interval: unknown/5m TTL → 3m; 1h → 50m;
other TTL → 5/6 of TTL. Custom intervals must be shorter than the selected TTL.
TTL is a user scheduling assumption, not a provider-side cache setting.
Status reports outcomes, last success, next scheduled request and maintenance-only
tokens/cost. Logs and status do not call the model. Missing costs remain unknown.
Thresholds stop the next maintenance request after reported usage reaches the
limit; one request can exceed it. Missing budget usage pauses; Codex does not
support a dollar threshold. Reopening keeps maintenance off.
Maintenance can increase total usage.
Do not promise savings or a TTL without measurements for the actual request path.
The managed page hides maintenance; the original host transcript retains it.
Do not promise hidden output in native CLI screens. `--require-native-loop`
deliberately rejects currently unverified native loop routes.

Never call a subagent, invoke a skill on each tick, change system instructions,
delete transcript rows, expand tool permissions, or start a recurring task from
a Stop hook. Only the runner submits the fixed maintenance prompt.
