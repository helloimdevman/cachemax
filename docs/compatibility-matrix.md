# Compatibility matrix

For cache retention by time away on Claude Code 2.1.284, Codex 0.158.0, and
Grok Build 1.0.41, see the [2026-09-29 idle sweep](idle-sweep-2026-09-29.md).
Without cachemax, Claude Code and Codex read 95.7–99.6% from cache up to 1 hour
and 0–21% at 2 hours; Grok Build read 0–22% in 7 of 8 runs from 15 minutes.
With cachemax at the default 3-minute interval, all three read 96.1–99.9%, and
estimated cost or input rose in every pair. The cache rows below are the
2026-09-25 results; the [2026-09-27 remeasurement](remeasurement-2026-09-27.md)
covers Claude Code 2.1.283 and Codex 0.157.1. This matrix records the 2026-09-25
checks.

Checked on 2026-09-25, macOS arm64, Node 26.7.0. Support applies to these tested
CLI versions; other versions must pass the same opt-in live test.

| Capability | Claude Code 2.1.282 | Codex 0.156.1 | Grok Build 1.0.41 |
| --- | --- | --- | --- |
| Existing account authentication | Claude.ai Max | ChatGPT Pro | OIDC, SuperGrok Heavy |
| Same session continuation | Passed | Passed | Passed |
| Default managed UI hides input, output, deltas | Passed | Passed | Passed |
| Host history replay hides owned turns | Passed | Passed | Passed |
| Next real turn remembers earlier task | Passed | Passed | Passed |
| Process restart leaves keeper off | Passed | Passed | Passed |
| Original transcript retained | Passed | Passed | Passed |
| Usage available | Read/write/input/output, session cost | Input/cached input/output/reasoning | Input/read/write/output, reported cost |
| Confirmed effective TTL | Unknown | Unknown | Unknown |
| Cache write TTL exposed in this test | 1h writes reported | Not exposed | Not exposed |
| Next-turn cache effect in paired tests | No improvement at 70m | Improved at 35m and 70m | Intermittent at 12m and 70m |
| Cost including maintenance | Estimate increased in 6/6 pairs | Dollar/quota comparison unavailable | Estimate increased in 6/6 pairs at both intervals |
| Actual two-hour run, expiry, resumed conversation | 2 maintenance turns completed | 39 maintenance turns completed | 38 maintenance turns completed |
| Actual hardware sleep/wake | Unverified | Unverified | Unverified |
| Native full hiding / native-loop strict option | Unsupported | Unsupported | Unsupported |

Each condition used six pairs. CLI estimates are not subscription invoices.
An exposed write TTL does not establish actual retention of the whole conversation.
See the [Korean validation report](validation-report.md) for measurements and limits.
The endurance timing check initially failed across an OS clock adjustment; exact
macOS correction records resolved it without changing tolerance. Follow-up chat
was verified by reopening the original sessions. The report retains that history.

Claude and Grok use one child process per request. A process and its EOF/exit
form the request boundary; subsequent requests cannot inherit trailing output
from that child. Claude user/assistant UUIDs and Grok's persisted `prompt_index`
map host history back to the owning request. Grok synthetic context rows are
not user chat messages. Unknown identities are preserved, not guessed from `.`.

Codex buffers events arriving before `turn/start` returns, then binds the host
turn ID before handling them. Cancellation waits for `turn/completed`. Empty
new paginated threads are not asked to list nonexistent turns. Failure to
confirm cancellation closes the App Server before another request is admitted.

Grok's ACP initialization/authentication/session creation were probed: session
load is advertised. Its documented streaming example waits for apparent text
stability after the prompt response, which does not establish an exact late-event
boundary. The release therefore uses the official headless resume fallback.
The installed Grok CLI also rejects the documented `--plugin-dir` option.

Claude uses the bundled PreToolUse guard and limits keeper requests to one
model turn. Codex installs an inline reference to that same deny-only script;
only its exact hook definition is trusted in the child process, without changing
global hook trust. Codex hosted web search is disabled throughout the managed
session because it bypasses local hooks. Other specialized host tool paths and
third-party hook side effects are not claimed to be universally impossible.
Grok uses its native wildcard deny rule for keeper requests; tools remain in
the normal host interface. All managed routes disable or deny subagents.

Native-to-managed takeover requires an explicit handoff after the native client
exits. The skill's `keep` command automates only the wait: it starts nothing
until the host process it was run from has exited.
Local lock files coordinate cachemax instances; they cannot prevent
an unrelated native client from ignoring that ownership contract. Automatic
attachment to the current live native conversation is deliberately rejected.

References checked against installed CLI behavior:

- [Claude structured print and resume](https://code.claude.com/docs/en/headless)
- [Claude PreToolUse and MessageDisplay](https://code.claude.com/docs/en/hooks)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex hook coverage](https://developers.openai.com/codex/hooks)
- [Grok headless and ACP](https://docs.x.ai/build/cli/headless-scripting)
- [Grok permission rules](https://docs.x.ai/build/features/permissions)
- [Grok plugin packaging](https://docs.x.ai/build/features/skills-plugins-marketplaces)
