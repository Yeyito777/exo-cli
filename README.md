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

Run `exo -h` for the complete command reference.
