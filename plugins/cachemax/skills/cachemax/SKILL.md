---
name: cachemax
description: Keep this Claude Code, Codex, or Grok Build conversation's cache warm while the user steps away, with a user-chosen number of hidden keepalive requests. Use when the user asks to keep a session or its cache ready while away, or to check or stop cachemax.
argument-hint: "[requests] [ttl] | off | status | logs"
disable-model-invocation: true
user-invocable: true
license: MIT
---

# cachemax

Run `node scripts/cli.mjs` from this skill's directory. It needs Node.js 22.18 or
newer and uses the host CLI's existing login. Do not read, copy, or replace
authentication files. The commands write to `~/.cachemax`, and `keep` starts a
background process. If this host sandboxes commands, request permission to run
them outside the sandbox.

## Keep this session ready (default)

1. Unless the user already gave them, ask for both in one short message:
   - How many keepalive requests to send at most: 1–120, default 5.
   - Cache TTL: unknown (default), 5m, 1h, or a custom duration. Never infer it
     from their plan.
   Mention that each request re-reads the whole conversation and can increase usage.
2. Run `node <skill-dir>/scripts/cli.mjs keep --max-ticks <N>`, adding
   `--ttl <ttl>` unless it is unknown. Add `--interval`, `--duration`,
   `--max-tokens` or `--max-cost-usd` (Claude and Grok only) only when the user
   asked for them.
3. Relay the output. The user must exit this session (for example `/exit`)
   within 10 minutes. cachemax then takes the session over, opens its page in
   the browser, and sends at most N requests. The user continues the
   conversation in that page, where their message always goes first.

## Other requests

- off: `node <skill-dir>/scripts/cli.mjs off` cancels a pending takeover or
  stops maintenance.
- status, logs: `node <skill-dir>/scripts/cli.mjs status` or `logs`. Neither
  calls the model.

## Limits

Default 5 requests. Without `--duration`, the window fits the request count.
Maximum 120 requests and 24h. Auto interval: unknown/5m TTL → 3m; 1h → 50m;
other TTL → 5/6 of TTL. Custom intervals must be shorter than the selected TTL.
TTL is a user scheduling assumption, not a provider-side cache setting.
Thresholds count maintenance only and stop the next request after usage is
reported; one request can exceed them. Missing budget usage pauses. Errors or
unexpected replies pause maintenance, and it never restarts on its own.
Do not promise savings or a TTL without measurements for the actual request path.
The page hides maintenance; the original host transcript retains it, and native
CLI screens may show it.

Never call a subagent, invoke a skill on each tick, change system instructions,
delete transcript rows, expand tool permissions, or start a recurring task from
a Stop hook. Only the runner submits the fixed maintenance prompt.
