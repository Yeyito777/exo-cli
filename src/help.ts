/**
 * Help text for the CLI.
 *
 * Extracted from main.ts to keep the entry point focused on
 * arg parsing and dispatch logic.
 */

const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

const INSTANCE_FLAG_SUMMARY = `  --instance <worktree>             Target a specific worktree daemon instance`;

const MODEL_FLAG_SUMMARY = `  --opus, --sonnet, --haiku         Claude model shortcuts
  --model <spec>                    Model: opus-4.6 | anthropic/opus-4.6 |
                                    claude-opus-4-6 | openai/gpt-5.5 |
                                    deepseek/deepseek-v4-pro
  --provider <id>                   Provider: anthropic | openai | deepseek`;

const MODEL_FLAG_SUMMARY_SEND = `  --opus, --sonnet, --haiku         Claude model shortcuts
  --model <spec>                    Model: opus-4.6 | anthropic/opus-4.6 |
                                    claude-opus-4-6 | openai/gpt-5.5 |
                                    deepseek/deepseek-v4-pro
  --provider <id>                   Provider: anthropic | openai | deepseek`;

export function printHelp(): void {
  process.stdout.write(`${b("exo")} — Exocortex CLI client

${b("USAGE")}
  exo send "message"                               New conversation
  exo send "message" -c <id>                       Continue a conversation
  exo send "message" --opus                        Claude Opus shortcut
  exo send "message" --model anthropic/opus-4.6    Explicit model
  exo send "message" --provider openai --model gpt-5.4-mini
  exo send "message" --model deepseek/deepseek-v4-pro
  exo transcribe call-segment.wav --mime-type audio/wav
  exo status --instance browse-links                Talk to a worktree daemon
  cat file | exo send -                             Read message from stdin

${b("COMMANDS")}
  send "message"                    Send a message to the AI
  list                              List conversations
  info <id>                         Conversation metadata
  history <id>                      Conversation history
  delete <id>                       Delete a conversation
  abort <id>                        Abort an in-flight stream
  queue <id> "msg" [--end]          Queue message for delivery
  rename <id> <title>               Rename a conversation
  llm "text" --system "..."         One-shot LLM (no conversation)
  transcribe <audio-file>           Transcribe audio through exocortexd
  status                            Check if daemon is running
  help [command]                    Show help

${b("ALIASES")}
  ls -> list        rm -> delete        mv -> rename

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
${MODEL_FLAG_SUMMARY}
  -c, --conv <id>                   Conversation ID
  --json                            Structured JSON output
  --full                            Include thinking + tool results
  --stream                          Stream events as NDJSON
  --id                              Print only conversation ID
  --timeout <sec>                   Max wait time (default 300)
  --system <prompt>                 System prompt (for llm)
  --mime-type <type>                Audio MIME type (for transcribe)
  --detach, --background            Start exo send and return immediately
  --foreground                      Disable parent-agent auto-detach for send
  --notify-parent <id>              Notify a parent conversation on send completion
  --no-notify                       Detach send without parent notification

${b("SUBAGENTS")}
  \`exo send\` starts or continues persisted conversation subagents. From inside
  an Exocortex parent conversation it auto-detaches and notifies the parent
  when done. \`--timeout\` controls how long this CLI waits; detached children
  continue in the daemon until they finish or are aborted.

Run ${b("exo <command> --help")} for command-specific usage.
`);
}

const COMMAND_HELP: Record<string, string> = {
  send: `${b("exo send")} "message" [flags]

Send a message to the AI. Creates a new conversation unless -c is given.

${b("USAGE")}
  exo send "what is 2+2"                          New conversation
  exo send "explain this" --opus                  Claude Opus shortcut
  exo send "explain this" --model anthropic/opus-4.6
  exo send "follow up" -c <id>                    Continue existing conversation
  cat prompt.txt | exo send -                      Read message from stdin
  echo "question" | exo send - -c <id>            Stdin + continue conversation

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  -c, --conv <id>                   Continue this conversation
${MODEL_FLAG_SUMMARY_SEND}
  --json                            Output as JSON (blocks, tokens, duration)
  --full                            Include thinking blocks and tool results
  --stream                          Stream events as NDJSON as they arrive
  --id                              Print only the conversation ID
  --timeout <sec>                   Max wait time (default 300)
  --detach, --background            Start the turn and return immediately
  --foreground                      Disable parent-agent auto-detach
  --notify-parent <id>              Notify a parent conversation on completion
  --no-notify                       Detach without parent notification

${b("SUBAGENT BEHAVIOR")}
  When exo send is called from inside an Exocortex parent conversation, it
  automatically runs detached and the daemon notifies the parent when done.

${b("SUBAGENT RUNTIME")}
  Detached sends return after the daemon accepts the turn. Use \`exo abort <id>\`
  to stop a detached child conversation if needed. In foreground mode,
  --timeout controls how long this CLI waits for the response.

${b("OUTPUT")}
  Default: response text + tool call summaries, then "exo:<convId>" on the last line.
  Thinking blocks and tool result output are hidden unless --full is given.
`,

  list: `${b("exo list")} [flags]

List all conversations.
Alias: ls

${b("USAGE")}
  exo list
  exo list --json

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --json                            Output as JSON array

${b("OUTPUT")}
  Default: table with ID, model, message count, title, last updated.
  Pinned conversations show 📌, marked conversations show ★.
`,

  info: `${b("exo info")} <id> [flags]

Show metadata for a conversation.

${b("USAGE")}
  exo info <convId>
  exo info <convId> --json

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --json                            Output as JSON object

${b("OUTPUT")}
  Conversation ID, model, message count, context token count, queued messages.
`,

  history: `${b("exo history")} <id> [flags]

Show the full message history of a conversation.

${b("USAGE")}
  exo history <convId>
  exo history <convId> --full
  exo history <convId> --json

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --json                            Output as JSON array of display entries
  --full                            Include thinking blocks and tool results

${b("OUTPUT")}
  Default: user and assistant messages with role labels.
  Tool calls shown as summaries. Thinking and tool results hidden unless --full.
`,

  delete: `${b("exo delete")} <id>

Delete a conversation. The daemon soft-deletes to trash.
Alias: rm

${b("USAGE")}
  exo delete <convId>

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
`,

  abort: `${b("exo abort")} <id>

Abort an in-flight stream for a conversation.

${b("USAGE")}
  exo abort <convId>

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
`,

  queue: `${b("exo queue")} <id> "message" [--end]

Queue a message for delivery to a conversation. The message is held by the
daemon and injected automatically — either before the next AI turn (default)
or appended after the current response finishes (--end).

Useful when a conversation is actively streaming and \`exo send\` would fail
with "Already streaming".

${b("USAGE")}
  exo queue <convId> "message"           Queue for next turn (default)
  exo queue <convId> "message" --end     Queue for message-end delivery

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --end                             Deliver at message-end instead of next-turn
`,

  rename: `${b("exo rename")} <id> <title>

Rename a conversation.
Alias: mv

${b("USAGE")}
  exo rename <convId> "new title"

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
`,

  transcribe: `${b("exo transcribe")} <audio-file> [flags]

Transcribe a local audio file through exocortexd. The daemon owns OpenAI OAuth,
so this works from detached/background processes without exposing tokens.

${b("USAGE")}
  exo transcribe segment.wav
  exo transcribe segment.wav --mime-type audio/wav
  exo transcribe call.webm --mime-type audio/webm --json

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --mime-type <type>                Audio MIME type (default inferred from extension)
  --json                            Output as JSON object
  --timeout <sec>                   Max wait time (default 300)

${b("OUTPUT")}
  Default: transcript text.
`,

  status: `${b("exo status")} [flags]

Check if the daemon is running and show a quick summary.

${b("USAGE")}
  exo status
  exo status --json

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --json                            Output as JSON object

${b("OUTPUT")}
  Daemon latency, conversation count, active streams.
  Exit code 2 if daemon is not running.
`,

  llm: `${b("exo llm")} "text" [flags]

One-shot LLM completion. No conversation is created or persisted.
Useful for quick utility calls (classification, summarization, etc).

${b("USAGE")}
  exo llm "summarize this text"
  exo llm "translate to spanish" --system "You are a translator"
  exo llm "refactor this" --model anthropic/sonnet-4.6
  cat file.txt | exo llm - --system "Summarize" --haiku

${b("FLAGS")}
${INSTANCE_FLAG_SUMMARY}
  --system <prompt>                 System prompt (default: "You are a helpful assistant.")
${MODEL_FLAG_SUMMARY_SEND}
  --json                            Output as JSON object
  --timeout <sec>                   Max wait time (default 300)
`,
};

// Resolve the small Unix-style alias set for help lookups.
const HELP_ALIASES: Record<string, string> = {
  ls: "list",
  rm: "delete",
  mv: "rename",
};

function resolveHelp(command: string): string {
  return HELP_ALIASES[command] ?? command;
}

export function printCommandHelp(command: string): void {
  const resolved = resolveHelp(command);
  const help = COMMAND_HELP[resolved];
  if (help) {
    process.stdout.write(help);
  } else {
    process.stderr.write(`No help available for '${command}'.\n`);
  }
}

export function hasCommandHelp(command: string): boolean {
  const resolved = resolveHelp(command);
  return resolved in COMMAND_HELP;
}
