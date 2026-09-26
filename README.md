# exo-cli

`exo-cli` is the external debugging and administration client for Exocortex
daemons. It provides a stateless, shell-friendly interface to daemon sockets.

Inside an Exocortex AI conversation, use the native `exo` internal tool to
manage the current daemon. Use this external CLI when you need to:

- inspect or control another daemon/worktree with `--instance`;
- troubleshoot daemon sockets or protocol behavior from the shell;
- script daemon operations outside an AI conversation; or
- transcribe audio, which is intentionally not exposed by the internal tool.

```sh
exo status --instance browse-links
exo list --instance browse-links
exo history <conversation-id> --instance browse-links
exo transcribe recording.wav --mime-type audio/wav
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
