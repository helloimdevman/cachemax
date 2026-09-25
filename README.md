# Cache Keeper

**English** | [한국어](README.ko.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Version](https://img.shields.io/badge/version-0.2.0-orange)

Cache Keeper sends short, bounded maintenance requests to the **same conversation**
in Claude Code, Codex, or Grok Build while you are away. Choose your TTL, interval,
duration and limits, then inspect actual completions and maintenance usage.
The managed page sends `Only .` and hides maintenance turns. Your real messages,
including `.`, stay visible; the host's original transcript is preserved.

> [!WARNING]
> **Maintenance uses your signed-in account and can increase total cost.** A dot
> response still reads conversation context. Cost savings, near-zero usage and
> provider cache retention are not guaranteed. The selected TTL guides local
> scheduling; it does not change the provider's cache lifetime.

## Contents

- [Requirements](#requirements)
- [Install the plugin](#install-the-plugin)
- [Run](#run)
- [Controls](#controls)
- [Supported paths](#supported-paths)
- [Privacy and removal](#privacy-and-removal)
- [Development](#development)
- [License](#license)

## Requirements

- Node.js **22.18+**
- macOS or Linux
- A signed-in host CLI (Claude Code, Codex, or Grok Build)

No API key, credential export, npm dependency, or build step is needed.

## Install the plugin

This repository contains both marketplace formats and a self-contained plugin
at [`plugins/cache-keeper`](plugins/cache-keeper). All runtime paths are relative
to the installed plugin.

**Claude Code**

```sh
claude plugin marketplace add Oct7/cachemax
claude plugin install cache-keeper@cache-keeper
```

**Codex**

```sh
codex plugin marketplace add Oct7/cachemax
codex plugin add cache-keeper@cache-keeper
```

**Grok Build**

```sh
grok plugin install Oct7/cachemax#plugins/cache-keeper
```

After restarting the host, invoke the `cache-keeper` skill. The skill controls
an already managed session or gives the handoff command for the current native
session. It does not secretly attach another writer to a running native chat.

<details>
<summary>Install from a local checkout (for testing)</summary>

```sh
git clone https://github.com/Oct7/cachemax.git && cd cachemax
claude plugin marketplace add "$PWD"
codex plugin marketplace add .
grok plugin install ./plugins/cache-keeper
```

</details>

## Run

Install the CLI from a checkout:

```sh
git clone https://github.com/Oct7/cachemax.git && cd cachemax
npm install --global .
cache-keeper doctor
cache-keeper run claude
# Or: cache-keeper run codex / cache-keeper run grok
```

Without installing globally:

```sh
node plugins/cache-keeper/scripts/cli.mjs run codex
```

Open the private localhost URL printed by the runner. Keepalive starts **off**.
Choose a TTL (**Unknown**, **5 minutes**, **1 hour**, or **Custom**), duration,
interval and limits, then click **Keep ready**. Defaults are **30 minutes**,
**10 requests**, and a **3-minute** interval when TTL is unknown. Maintenance
status shows last success, next scheduled request, outcomes, tokens and estimated
cost. **Activity** provides raw records; **Show hidden turns** reads original
history. Inspecting status and logs sends no model requests.

### Hand off an existing session

An existing native session must first finish its turn and be closed:

```sh
cache-keeper run codex --session SESSION_ID --cwd /path/to/project --handoff
```

Use its original directory and model. Keep the native client closed while the
runner owns the session. A Cache Keeper lock refuses a second runner; native
clients do not participate in that lock. Handoff is an explicit assertion that
the previous writer has exited. A previously owned session can be reopened
with `--session`; paid maintenance never restarts automatically.

## Controls

The managed page accepts:

```text
/cache-keeper 30m
/cache-keeper off
/cache-keeper status
/cache-keeper logs
/cache-keeper show-hidden
```

From another terminal, address an existing runner:

```sh
cache-keeper on --host codex --session SESSION_ID --duration 30m --ttl 5m --max-ticks 10
# Optional maintenance token threshold, including cached input:
cache-keeper on --host codex --session SESSION_ID --ttl 5m --max-tokens 100000
# Dollar thresholds use reported estimates (Claude / Grok only):
cache-keeper on --host grok --session SESSION_ID --ttl 1h --duration 2h --max-cost-usd 0.10
cache-keeper off --host codex --session SESSION_ID
cache-keeper status --host codex --session SESSION_ID
cache-keeper logs --host codex --session SESSION_ID
```

### Duration and request limits

| Setting | Default | Maximum |
| --- | --- | --- |
| Duration | 30 minutes | 24 hours |
| Maintenance requests | 10 | 120 |

Activation fixes the end time; user activity never extends it. The first
maintenance request waits for the interval. No backlog is replayed after sleep.
A shorter duration than the interval makes no maintenance request. The page and
CLI both accept `--interval` / `--max-ticks`. The page's `/cache-keeper DURATION`
command uses its current form settings.

### TTL and interval

Select your TTL on activation or use `--ttl DURATION` (for example `5m`, `1h`,
or `20m`, up to 24h). Omit it for unknown.

| TTL | Auto interval |
| --- | --- |
| Unknown | 3m |
| 5m | 3m |
| 1h | 50m |
| Custom | 5/6 of the TTL |

An explicit interval must be shorter than the selected TTL. Allow time for the
request itself and possible delays; selecting a TTL does not establish provider
retention.

### Token and cost thresholds

Token and dollar thresholds are optional and apply only to the current activation's
maintenance. They reset when you explicitly activate again. Total tokens include
all input, cached reads/writes and output without double-counting provider fields.
Claude cost uses consecutive session-cost differences, Grok uses request estimates,
and Codex cost remains **unknown** (dollar thresholds are rejected).
The first Claude request after opening a runner may have no cost baseline; with a
dollar threshold, that pauses maintenance. Missing or interrupted budget usage
also pauses. No extra request is sent to measure usage or repair a response.

> [!IMPORTANT]
> **Thresholds are checked after a response. One request can exceed the threshold.**
> They stop subsequent maintenance, not real user turns.

Time and request limits remain active. The last activation's settings and measured
totals survive reopening; maintenance itself always starts off. CLI estimates are
not subscription bills.

### User input priority

User input takes priority. An active keeper request is cancelled and its
termination is confirmed before the user receives a separate turn. Ordinary
user turns are not cancelled by **Turn off**. Authentication errors, invalid
responses, unexpected tools, protocol errors, and ambiguous timeouts pause
maintenance. No corrective model prompts or immediate retries are sent.

## Supported paths

| Host | Tested version | Managed transport | Maintenance guard |
| --- | --- | --- | --- |
| Claude Code | 2.1.282 | Structured print + resume | Bundled PreToolUse deny handler |
| Codex | 0.156.1 | App Server thread/turn API | Exact bundled hook; hosted web search disabled for the managed session |
| Grok Build | 1.0.41 | Structured headless + resume | Native `--deny '*'` on keeper requests |

All three were tested with existing subscription login. Model defaults remain
those of the CLI; there is no cheaper model or subagent for maintenance.
Native-to-managed handoff can alter the prompt prefix. Headless user turns deny
interactive approval requests; use the native client after closing the runner
for work requiring interactive approvals. Existing host tool rules still apply.

**Full hiding is supported in the managed page only.** Native `/loop` routes
cannot establish all required display and dispatch guarantees in this release.
`--require-native-loop` therefore rejects activation on all three hosts.
Original host viewers may display maintenance turns. See the
[compatibility matrix](docs/compatibility-matrix.md) and
[validation report](docs/validation-report.md) for the tested limits.

## Privacy and removal

The runner binds only to `127.0.0.1` and requires its random token for every
session API request. Treat the private URL like access to the session. Rendered
model output is text, never executable HTML. No telemetry is sent by Cache Keeper.

Local metadata lives in `~/.cache-keeper`, or `CACHE_KEEPER_HOME`. It stores
session IDs, ownership mappings, settings, counts, times, and usage; the host owns the
conversation text and credentials. Metadata files use mode `0600`.

Stop the runner with Ctrl+C before uninstalling. Use the host's plugin removal
command and, if globally installed, `npm uninstall --global cache-keeper`.
`cache-keeper forget --host HOST --session ID` removes keeper metadata for a
stopped session. This also removes its hiding map; the original transcript is
untouched. No native scheduled tasks are installed or deleted.

## Development

```sh
npm test
npm run check
node tests/browser-reconnect.mjs  # Ego Lite; local fake host, no model usage
npm run test:live -- --confirm-usage
# Limit the live test to one account:
npm run test:live -- --confirm-usage codex
npm pack
```

Offline tests cover deadlines, cancellation ordering, queueing, stale callbacks,
locks, display ownership, API security, and tool guards. The `test:live` smoke test
uses **three model turns per host** and then reopens the same session. Controlled
idle and endurance tests have separate explicit duration and request limits;
their commands are in the validation report. All model tests require usage opt-in
and never copy authentication files. Reports contain usage summaries, not
credentials or account identifiers.

The runtime uses Node's standard library in executable ES modules; TypeScript
build tooling and a monorepo dependency graph are unnecessary for this release.
The release archive includes the test scripts and sanitized measurements so its
validation commands can be run from an extracted copy.

### Documents

- [Troubleshooting](docs/troubleshooting.md) · [Privacy](docs/privacy.md)
- [Compatibility matrix](docs/compatibility-matrix.md)
- [Original validation](docs/validation-report.md) · [Deeper analysis](docs/cache-analysis.md)
- [Three-host follow-up](docs/reproducibility-report.md) · [Usage reduction study](docs/usage-minimization.md)

The historical studies retain their original versions and experimental settings.
The common short-idle comparison did not establish an economic benefit; earlier
Codex cache gains also included warming newly added instructions. These studies
do not measure the 0.2.0 UI or budget features.

## License

[MIT](LICENSE)
