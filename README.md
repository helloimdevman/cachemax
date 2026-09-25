# cachemax

**English** | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-orange)

Keep a Claude Code, Codex, or Grok Build conversation warm while you step away.
cachemax sends a tiny hidden `Only .` turn to the **same session** on a timer,
stops at hard limits, and shows exactly what each request used.

![cachemax managed page showing maintenance status and usage](docs/assets/screenshot.png)

> [!WARNING]
> Maintenance runs on your signed-in account and **can increase total cost**.
> A `.` reply still reads the whole conversation. Savings and provider cache
> retention are not guaranteed; the TTL you pick only sets the local schedule.

## How it works

![Timeline: Keep ready, hidden Only . turns every interval, your message goes first, hard stop](docs/assets/how-it-works.svg)

- **Same conversation, hidden turns.** The managed page hides maintenance turns. The host transcript keeps everything.
- **You go first.** A running keeper request is cancelled before your message is sent.
- **Bounded by default.** 30 minutes and 10 requests unless you change them. Errors or unexpected replies pause it, and it never restarts on its own.
- **No extra setup.** No API key, no npm dependencies, no build step. It uses your existing CLI login.

## Measured results

From real runs on subscription accounts ([validation report](docs/validation-report.md)),
including the cases where it did not help:

| Metric | Result | Conditions |
| --- | --- | --- |
| Reliability | **79 / 79** maintenance requests completed | 2-hour run, 3 hosts |
| Schedule accuracy | **1.1–5.8 ms** late vs. plan | 27 timed requests, 3-minute interval |
| Codex cache read on return | **83.8% → 99.5%** | 35 and 70 min idle, 6 pairs each |
| First-token latency on return | No consistent change (−0.6 s to +2.5 s) | median paired difference, 8 conditions |
| Reported cost (Claude, Grok) | **+100% to +592%** | every one of 18 pairs cost more |
| Offline tests | **40 / 40** pass | `npm test`, no model calls |

![Chart: next-message cache read per host with and without cachemax, and reported cost change](docs/assets/results.svg)

**Bottom line:** it keeps a session active reliably and within the limits you set.
It is not a proven way to save money. Part of the Codex gain came from warming
newly added instructions ([analysis](docs/cache-analysis.md)). With a 12-minute idle,
Codex and Grok already read over 99.5% from cache without it
([follow-up](docs/reproducibility-report.md)).

## Quick start

Requires Node.js 22.18+, macOS or Linux, and a signed-in host CLI.

```sh
# 1. Plugin (pick your host)
claude plugin marketplace add Oct7/cachemax && claude plugin install cachemax@cachemax
codex plugin marketplace add Oct7/cachemax && codex plugin add cachemax@cachemax
grok plugin install Oct7/cachemax#plugins/cachemax

# 2. CLI, then start a managed session
git clone https://github.com/Oct7/cachemax.git && cd cachemax
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
| Claude Code | 2.1.282 | Structured print + resume | Bundled PreToolUse deny hook |
| Codex | 0.156.1 | App Server thread/turn API | Bundled hook; hosted web search off |
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
[Three-host follow-up](docs/reproducibility-report.md) · [Usage reduction](docs/usage-minimization.md)

## License

[MIT](LICENSE)
