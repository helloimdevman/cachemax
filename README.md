# cachemax

**English** | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-orange)

Keep a Claude Code, Codex, or Grok Build conversation warm while you step away.
cachemax sends a hidden `Only ".". No tools.` turn to the **same session** on a timer,
stops at hard limits, and shows exactly what each request used.

![cachemax managed page showing maintenance status and usage](docs/assets/screenshot.png)

> [!WARNING]
> Maintenance runs on your signed-in account and **can increase total cost**.
> A `.` reply still reads the whole conversation. Savings and provider cache
> retention are not guaranteed; the TTL you pick only sets the local schedule.

## How it works

![Timeline: Keep ready, hidden period requests every interval, your message goes first, hard stop](docs/assets/how-it-works.svg)

- **Same conversation, hidden turns.** The managed page hides maintenance turns. The host transcript keeps everything.
- **You go first.** A running keeper request is cancelled before your message is sent.
- **Only while you are away.** The wait counts from the last reply, including one from before **Keep ready** or from the native CLI. With a 1h TTL (50-minute interval), a message at minute 25 moves the next request to 50 minutes after its reply. If the interval has already passed, the first request goes right away.
- **Bounded by default.** 30 minutes and 10 requests unless you change them. Errors or unexpected replies pause it, and it never restarts on its own.
- **No extra setup.** No API key, no npm dependencies, no build step. It uses your existing CLI login.

## Does it keep the cache?

How much of your next message was read from cache after you stepped away, with and
without cachemax at the default 3-minute interval. Real subscription-account runs on
2026-09-29, two per host and time (one dot each):

![Cache read on return by time away. With cachemax: 96–99.9% on all three hosts up to 2 hours. Without: Claude Code 96–98% up to 1 hour and 21% at 2 hours; Codex 99.5% up to 1 hour and 0–15% at 2 hours; Grok Build 0–22% in 7 of 8 runs from 15 minutes](docs/assets/cache-retention.svg)

| Away | Claude Code | Codex | Grok Build |
| --- | --- | --- | --- |
| 5 min | 95.7–96.2% → **96.1–99.9%** | 99.5–99.6% → **99.5%** | 99.9% → **99.8%** |
| 10 min | 96.6–97.7% → **99.9%** | 99.5–99.6% → **99.4%** | 99.8% → **99.8–99.9%** |
| 15 min | 96.1–96.7% → **99.9%** | 99.5–99.6% → **99.7%** | 0–99.9% → **99.7%** |
| 30 min | 95.7–98.4% → **97.4–99.9%** | 99.5–99.6% → **99.5%** | 0–21.6% → **99.7%** |
| 1 h | 96.6–96.8% → **98.5–99.9%** | 99.5–99.6% → **99.7%** | 0% → **99.9%** |
| 2 h | 20.7–20.8% → **97.4–98.2%**† | 0–15.2% → **99.5%** | 0% → **99.8%** |

Without → **with** cachemax, range over the two runs.

- **Claude Code** keeps the cache on its own for an hour. At 2 hours it fell to about 21%.
- **Codex** keeps it on its own for an hour. At 2 hours it fell to 0–15%.
- **Grok Build** lost it on its own in 7 of 8 runs from 15 minutes on.

Keeping it costs more, because every request re-reads the whole conversation. The
estimated cost rose in every Claude and Grok pair (Claude +38% to +904%, Grok +27% to
+1,357%), and Codex used 1.7–47× the input.

† In both runs a Claude API retry at 98 minutes paused cachemax after 31 of 39 requests,
as designed. It never restarts on its own. The last request was 25 minutes before the return.
[Full results](docs/idle-sweep-2026-09-29.md)

## Quick start

Requires Node.js 22.18+, macOS (Linux and Windows are untested), and a signed-in host CLI.

```sh
# 1. Plugin (pick your host)
claude plugin marketplace add helloimdevman/cachemax && claude plugin install cachemax@cachemax
codex plugin marketplace add helloimdevman/cachemax && codex plugin add cachemax@cachemax
grok plugin install helloimdevman/cachemax#plugins/cachemax

# 2. CLI, then start a managed session
git clone https://github.com/helloimdevman/cachemax.git && cd cachemax
npm install --global .
cachemax doctor
cachemax run claude          # or: codex, grok
```

Open the private localhost URL it prints, choose a TTL and limits, and click **Keep ready**.
Maintenance always starts **off**. In the host, the `cachemax` skill controls a managed
session or gives you the handoff command for the current one.

**Existing session:** finish its turn, close the native client, then run
`cachemax run codex --session ID --cwd /original/dir --handoff`.

## Settings

| Setting | Default | Rule |
| --- | --- | --- |
| Duration | 30m | Up to 24h. The end time is fixed at activation. |
| Max requests | 10 | 1–120 |
| Interval | From TTL: unknown or 5m → 3m, 1h → 50m, custom → 5/6 of TTL | Must be shorter than the TTL |
| Token / $ stop | Off | Checked after each response, so one request can overshoot. $ works on Claude and Grok only. |

No backlog is replayed after sleep. Each completed turn restarts the interval wait.

## Commands

```text
# In the managed page
/cachemax 30m | off | status | logs | show-hidden

# From another terminal
cachemax on     --host codex --session ID --duration 30m --ttl 5m --max-ticks 10 [--max-tokens N] [--max-cost-usd N]
cachemax off    --host codex --session ID
cachemax status --host codex --session ID      # reads only, no model request
cachemax logs   --host codex --session ID
cachemax forget --host codex --session ID      # delete metadata of a stopped session
```

## Supported hosts

| Host | Tested | Transport | Tool guard on maintenance |
| --- | --- | --- | --- |
| Claude Code | 2.1.283 | Structured print + resume | Bundled PreToolUse deny hook |
| Codex | 0.157.1 | App Server thread/turn API | Bundled hook; hosted web search off |
| Grok Build | 1.0.41 | Structured headless + resume | Native `--deny '*'` |

Maintenance uses the session's own model, with no cheaper model or subagent. Turns are
hidden only in the managed page, so native viewers may show them. Native `/loop` is not
supported, and `--require-native-loop` is rejected. Headless turns deny interactive
approvals, so close the runner and use the native CLI for those.
See the [compatibility matrix](docs/compatibility-matrix.md).

## Privacy

- Binds to `127.0.0.1` only and requires a random token. Treat the URL like session access.
- No telemetry. Credentials are never read or copied. The host owns conversation text.
- Metadata lives in `~/.cachemax` (or `CACHEMAX_HOME`) with mode `0600`.
- To uninstall: stop the runner, remove the plugin with your host's command, and run `npm uninstall --global cachemax`.

## Development

```sh
npm test                                   # offline, no model usage
npm run check
node tests/browser-reconnect.mjs           # Ego Lite + local fake host
npm run test:live -- --confirm-usage       # 3 real model turns per host
```

Docs: [Troubleshooting](docs/troubleshooting.md) · [Privacy](docs/privacy.md) ·
[Validation](docs/validation-report.md) · [Cache analysis](docs/cache-analysis.md) ·
[Three-host follow-up](docs/reproducibility-report.md) · [Remeasurement](docs/remeasurement-2026-09-27.md) ·
[Idle sweep](docs/idle-sweep-2026-09-29.md) · [Usage reduction](docs/usage-minimization.md)

## License

[MIT](LICENSE)
