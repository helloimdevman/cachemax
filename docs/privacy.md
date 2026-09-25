# Privacy

Cache Keeper launches installed CLIs using their normal login and configuration.
It never reads, copies, exports, logs, or distributes credential files. The CLIs
still send model requests to their providers under their own privacy policies.

Conversation text remains in host transcripts. The runner reads those files or
the host's history API to render existing conversations. It keeps rendered text
in process/browser memory and never deletes, rewinds, or edits the host history.

Own metadata: host/session ID, directory/model, generation, request and message
IDs, child PID, timestamps, activation settings and thresholds, usage, error
summaries, and the active local endpoint.
Its token exists only in a private local file while the runner is active. Session
files are `0600`; a newly created metadata directory is `0700`.

The HTTP listener is loopback-only, checks Host and Origin, and requires a random
token for session data and mutations. The page loads no third-party assets and
renders model text with `textContent`. Cache Keeper sends no telemetry.

Use `forget` on a stopped session to erase its metadata. Its original host
history remains, including maintenance turns. Erasing the mapping removes the
ability to hide those turns on future replays. Uninstalling the plugin does not
erase user conversations or unrelated schedules.
