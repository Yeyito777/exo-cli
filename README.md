# exo-cli

`exo-cli` is the external debugging and administration client for Exocortex
daemons. It provides a stateless, shell-friendly interface to daemon sockets.

The native `exo` internal tool starts/aborts subagents; it is not the daemon's
administration API. Use this external CLI when you need to:

- inspect or control another daemon/worktree with `--instance`;
- troubleshoot daemon sockets or protocol behavior from the shell;
- script daemon operations outside an AI conversation; or
- transcribe audio, which is intentionally not exposed by the internal tool.

```sh
exo status --instance browse-links
exo list --instance browse-links
exo history <conversation-id> --instance browse-links
exo transcribe recording.wav --mime-type audio/wav
exo models --json
exo --version
```

Commands with one primary opaque payload read it as exact UTF-8 from stdin:

```sh
printf '%s' 'diagnose this daemon' | exo send --instance browse-links
printf '%s' 'follow up' | exo send -c <conversation-id>
printf '%s' 'deliver after the current turn' | exo queue <conversation-id> --end
printf '%s' 'summarize this' | exo llm
```

Inline messages/prompts are rejected. Structural values such as conversation
IDs, models, instance names, and conversation titles remain argv arguments. A
custom secondary LLM system prompt comes from `--system-file PATH`, since stdin
is reserved for the primary prompt.

Run `exo -h` for the complete command reference.

## Delegation models

Almost never use subagents; do the work yourself by default, including testing.
For warranted delegation, omit `--model` and `--effort` to use `/default-model`.
The daemon resolves `astra`, `sol`, `terra`, and `luna` to the newest available
generation of that size. An outdated implicit size default is upgraded for
delegation without rewriting the saved setting. Effort is normalized for the
selected model, not forced to medium.

Explicit older OpenAI IDs require `--legacy`, only when the user requests legacy.
The flag applies to `send`, `queue`, and `llm`, including continued conversations.
An alias always means latest, even with `--legacy`; select an exact old ID when
you need one. A legacy unsized default has no safe same-size replacement and
requires the flag or a current model override. Ordinary interactive conversations
are unaffected.

## Current daemon compatibility

Providers: `openai`, `deepseek`, `opencode`, and `openrouter`. Read `exo models`
for the daemon's advertised models, reasoning efforts, and service tiers.
Namespaced IDs work as `--model openrouter/nousresearch/hermes-4-405b` or
`--provider openrouter --model nousresearch/hermes-4-405b`.

`--fast`, `--no-fast`, and `--ultrafast` select a tier explicitly; the daemon
validates whether that model/account supports it. Existing-conversation model,
effort, and tier changes are acknowledged before the message is dispatched.

Tool selection and conversation-scoped custom modules are retired. The old
`--custom-tool`, `--internal-tool`, and `--external-tool` flags fail locally with
a migration error; no draft-policy IPC is sent.

`--repo-root PATH` selects an Exocortex checkout/install root. `--instance NAME`
selects a worktree under its `.worktrees` directory. `EXOCORTEX_CONFIG_DIR` also
selects the same config root as the daemon. The default source installation
remains `<Exocortex>/external-tools/exo-cli`; compiled Windows executables use
the directory beside `exocortexd.exe`.

## Output and completion

Choose one of `--json`, `--stream`, or `--id` for `send`. These modes are also
honored for detached and automatically queued busy-foreground sends.
`--stream` contains only NDJSON: daemon events plus a final `response_complete`,
`response_started`, or `message_queued` CLI envelope. There is no text footer.
JSON mutation commands return structured acknowledgements as well.

Foreground sends follow stream handoffs, ignore prior-stream subscription
snapshots, and preserve persisted partial output on an interruption.
Responses include `status` (`completed`, `interrupted`, or `suspended`) and
an optional `stopReason`. Interrupted/suspended sends exit with code 1/3;
accepted detached/queued sends exit 0 but do not promise eventual task success.
A connection loss fails promptly instead of waiting for the response timeout.
Timeouts must be finite positive seconds; fractions down to 1 ms are supported.
They bound each connection/request/collection wait, not the total invocation.

**A timeout/disconnect is not cancellation or rollback.** A daemon job may still
run. Inspect the conversation before retrying any mutation, including one using
`--new-conversation-id`; duplicate IDs are rejected, not silently resumed.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun dist/exo.js --version
EXOCORTEX_SOURCE_DIR=/path/to/Exocortex bun run check:contract
```

Generated `dist/` output is ignored rather than checked in stale. Both source
and generated bundles resolve the checkout root; source changes need no rebuild
when using `bin/exo` / `bin/exo.cmd`.

Tests use unique temporary sockets/pipes and never send jobs to the user's
daemon. CI runs on Linux, macOS, and Windows, and checks the projected wire types
against Exocortex's current `main` without running a real daemon or provider API.
