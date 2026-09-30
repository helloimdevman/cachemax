# cachemax

**English** | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-orange)

Keep your **Claude Code, Codex, or Grok Build conversation** warm while you step away.
cachemax periodically sends `Only ".". No tools.` to the same session, hides those turns
in a local browser page, and stops at your limits. Uses your existing CLI login;
no API key, npm dependencies, or build step.

> [!WARNING]
> **Maintenance can increase total usage and cost.** Even a `.` reply reads the conversation.
> Cache retention and savings are not guaranteed. Your TTL choice sets the local schedule only.

## Quick start

Requires **Node.js 22.18+**, macOS, and a signed-in host CLI. Linux and Windows are untested.

```sh
npx skills add helloimdevman/cachemax -g -a claude-code codex grok
```

1. In the conversation to keep, run `/cachemax` in Claude Code or Grok Build, or `$cachemax` in Codex.
2. Choose the maximum requests (**default 5**) and cache TTL (**default unknown**).
3. **Exit the CLI within 10 minutes.** cachemax takes over and opens the conversation in your
   browser. Continue there; your messages take priority over maintenance.

To cancel before exiting, run the same skill with `off`. The skill includes the runtime.

<details>
<summary>Preview the managed page</summary>

![cachemax managed page showing maintenance status and usage](docs/assets/screenshot.png)

</details>

## Measured cache effect and usage

The chart shows **the share of the next user turn's input read from cache**, not the
probability of a cache hit. Subscription-account runs on 2026-09-29 used a 3-minute
interval and longer windows/request caps for each condition; **the default stops after 5 requests**.

![Cache read ranges after 5 minutes to 2 hours away, with and without cachemax, alongside added usage. Claude's paused 2-hour runs are marked separately.](docs/assets/cache-retention.svg)

- **Claude Code and Codex:** controls already retained most of the cache through 1 hour.
  At 2 hours, Codex read 0–15.2% without maintenance and 99.5% with it.
- **Grok Build:** without maintenance, 7 of 8 return turns from 15 minutes onward read
  only 0–21.6% from cache; with maintenance, they read 99.7–99.9%.
- **Usage rose in every completed pair.** The left column includes maintenance + return
  after warm-up. Claude/Grok show CLI dollar estimates; Codex shows input tokens, not dollars or quota.

† Both Claude 2-hour runs paused on an API retry around minute 98, after 31 completed
maintenance requests. Their return values are shown for reference and excluded from
the usage ranges. Two pairs per condition on shared accounts do not establish a provider TTL.
[Method, all results, and source data](docs/idle-sweep-2026-09-29.md).

## How it behaves

- **Your turn goes first.** A running maintenance request is cancelled before your message is sent.
- **Waits from the last reply**, including replies before activation or in the native CLI.
  Each completed turn resets the wait; if already overdue at activation, the first request starts immediately.
- **Stops at the first limit or error.** Fixed end time, request cap, and optional token/$ budgets.
  Unexpected replies also pause it. It never restarts automatically or replays missed requests after sleep.
- **Hidden in the managed page.** Maintenance stays in the host transcript and may appear in native clients.

## Limits and defaults

| Setting | Default | Limit / behavior |
| --- | --- | --- |
| Requests | 5 | 1–120 |
| Duration | Skill: fits request count; page: 30m | Up to 24h; end time fixed at activation |
| Interval | Unknown/5m TTL → 3m; 1h → 50m | Custom TTL → 5/6 of TTL; interval must be shorter than TTL |
| Token / $ budget | Off | Maintenance only; checked after responses, so one request can overshoot |

Dollar budgets work on Claude and Grok. Missing budget usage pauses maintenance.
It uses the session's model and blocks maintenance tools. Native `/loop` and
`--require-native-loop` are unsupported. For interactive approvals, close the runner and use the native CLI.
Measurements used Claude Code **2.1.284**, Codex **0.158.0**, and Grok Build **1.0.41**;
see the [compatibility matrix](docs/compatibility-matrix.md) for guard and transport details.

<details>
<summary>Plugin installation and terminal commands</summary>

```sh
# Plugin: choose your host
claude plugin marketplace add helloimdevman/cachemax && claude plugin install cachemax@cachemax
codex plugin marketplace add helloimdevman/cachemax && codex plugin add cachemax@cachemax
grok plugin install helloimdevman/cachemax#plugins/cachemax

# Standalone CLI
git clone https://github.com/helloimdevman/cachemax.git && cd cachemax
npm install --global .
cachemax run codex          # or: claude, grok
```

`run` opens a local conversation with maintenance **off**. Set TTL and limits, then click
**Keep ready**. For an existing session, close its native client first, then use:

```sh
cachemax run codex --session ID --cwd /original/dir --handoff
```

In the host, pass `[requests] [ttl]`, `off`, `status`, or `logs` to the skill
(`/cachemax` or `$cachemax`). In the managed page, use `/cachemax 30m`, `/cachemax off`,
`/cachemax status`, `/cachemax logs`, or `/cachemax show-hidden`. From another terminal:

```sh
cachemax on     --host codex --session ID --duration 30m --ttl 5m --max-ticks 5
cachemax off    --host codex --session ID
cachemax status --host codex --session ID      # no model request
cachemax logs   --host codex --session ID
cachemax forget --host codex --session ID      # remove stopped session metadata
```

`on` also accepts `--max-tokens N` and `--max-cost-usd N` (Claude/Grok only).
To uninstall, stop maintenance, then run `npx skills remove cachemax -g`; for plugin/CLI
installs, remove the host plugin and run `npm uninstall --global cachemax` as applicable.

</details>

## Privacy

- Local only: binds to `127.0.0.1` with a random access token. Treat the URL as session access.
- No telemetry; credentials are never read or copied. The host owns the conversation text.
- Metadata: `~/.cachemax` (or `CACHEMAX_HOME`), mode `0600`. [Privacy details](docs/privacy.md).

<details>
<summary>Development and measurement reports</summary>

```sh
npm test                                    # offline; no model usage
npm run check
node scripts/render-readme-charts.mjs        # regenerate both charts from saved data
node scripts/render-readme-charts.mjs --check
```

Browser check: `node tests/browser-reconnect.mjs` (Ego Lite + local fake host).
Live checks: `npm run test:live -- --confirm-usage` (3 real model turns per host).

Reports: [Validation](docs/validation-report.md) · [Cache analysis](docs/cache-analysis.md) ·
[Three-host follow-up](docs/reproducibility-report.md) · [Remeasurement](docs/remeasurement-2026-09-27.md) ·
[Idle sweep](docs/idle-sweep-2026-09-29.md) · [Usage reduction](docs/usage-minimization.md).

</details>

[Troubleshooting](docs/troubleshooting.md) · [MIT license](LICENSE)
