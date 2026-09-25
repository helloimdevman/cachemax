# Troubleshooting

- **No runner owns this session:** start `cache-keeper run HOST`. The `on` command
  only controls a running owner; it cannot attach to an arbitrary native window.
- **Existing native conversation:** finish the native turn, exit that client,
  and use `run HOST --session ID --cwd ORIGINAL_DIRECTORY --handoff`.
- **Already owned / stale lock:** stop the existing runner. After an abnormal
  exit, `cache-keeper unlock --host HOST --session ID` checks that the recorded
  parent and active child processes have exited. Reopen the session afterward;
  keepalive remains off.
- **Guard not activated:** confirm the tested Codex version with `doctor`.
  Organization policy may disable hooks. Keeper refuses to activate if its
  deny-only guard is missing or untrusted; do not weaken organization policy.
- **Auth, rate limit, or API error:** inspect the host CLI normally and restore
  login/usage availability there. The runner does not extract tokens or switch
  accounts. Reopen and explicitly enable keepalive after resolving the issue.
- **Unexpected answer or tool attempt:** keeper pauses and shows one local
  warning. It does not ask the model to correct itself. Inspect Activity and
  Show hidden turns before explicitly enabling it again.
- **Approval needed for real work:** managed headless turns do not grant new
  permissions. Close the runner and resume with the native CLI to approve the
  operation through its normal interface.
- **Native turns visible:** full hiding is a property of the managed page.
  Original host history and native screens may show maintenance turns.
- **Model/configuration changed:** restart with the original settings. Session
  identity alone does not establish an unchanged prompt prefix or warm cache.
- **Blank or disconnected page:** use the complete private URL with its fragment.
  A transient display connection reconnects while preserving the draft and reading
  position. A runner shutdown ends that URL; use the new runner's private URL.
  Reconnection never enables maintenance or resubmits input. Avoid sharing the URL.
- **Network or sleep gap:** missed intervals are not replayed. Cache state is
  unknown; there is no operating-system sleep prevention.
- **Higher usage despite cache hits:** include all maintenance requests in the
  comparison. The tested Claude and Grok conditions increased CLI cost estimates.
  Keep maintenance off when its measured benefit does not justify its usage.
- **Confirm periodic requests:** for a running session, use `status --host HOST
  --session ID` to inspect `intervalMs`, `nextDueAt`, and `admittedTicks`. Use
  `logs --host HOST --session ID` or Activity to check keeper turns' timestamps,
  completion status, usage, and `request_ok` events. Prefix CLI commands with
  `cache-keeper`. These reads do not send model requests. Admitted counts alone
  do not prove completion. The interval starts after the previous request finishes.
- **Check minimal usage:** count cached input, new cache writes, and output as
  well as ordinary input. A dot response does not mean one total token. Claude
  reports cumulative session cost; use differences between consecutive requests.
  An unavailable cost is unknown, not zero. The 0.2.0 page and `status` show current
  or last activation totals, plus success/failure/interruption counts. Use optional
  `--max-tokens` / `--max-cost-usd` to stop subsequent maintenance after the threshold
  is observed. One request can exceed it; this is not a prepaid spending cap.
  See the maintenance-only figures in the
  [three-host follow-up](reproducibility-report.md).
- **Budget usage unavailable:** required usage was missing or a request was
  interrupted. Maintenance pauses without a retry; normal user turns still work.
  Claude needs consecutive cost reports from the current runner, so its first
  maintenance request after handoff/reopen may lack a cost baseline. Codex has no
  reported dollar cost; use token/request limits instead. Changing a limit and
  activating again explicitly begins a new budget period.
- **TTL / interval mismatch:** choose unknown, 5m, 1h or a custom TTL when enabling.
  The selected TTL guides scheduling but does not set provider retention. Leave
  interval empty for automatic scheduling or choose a shorter interval than TTL.
  A duration shorter than the interval sends no maintenance request (for example,
  30m duration with a 1h TTL's 50m automatic interval).

The public package has no external runtime dependencies. To diagnose packaging,
run `npm run check`, then the native `claude plugin validate` and
`grok plugin validate` commands on `plugins/cache-keeper`.
