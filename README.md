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
