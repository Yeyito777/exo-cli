// src/conn.ts
import { connect } from "net";
import { existsSync } from "fs";

// src/shared/paths.ts
import { execSync } from "child_process";
import { join, basename, resolve } from "path";
var REPO_ROOT = resolve(import.meta.dir, "../../../..");
var CONFIG_DIR = join(REPO_ROOT, "config");
var _worktreeName;
function detectWorktree() {
  if (_worktreeName !== undefined)
    return _worktreeName;
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (resolve(gitDir) !== resolve(gitCommonDir)) {
      _worktreeName = basename(gitDir);
    } else {
      _worktreeName = null;
    }
  } catch {
    _worktreeName = null;
  }
  return _worktreeName;
}
function runtimeDir() {
  const wt = detectWorktree();
  return wt ? join(CONFIG_DIR, "runtime", wt) : join(CONFIG_DIR, "runtime");
}
function socketPath() {
  return join(runtimeDir(), "exocortexd.sock");
}

// src/conn.ts
class Connection {
  socket = null;
  buffer = "";
  listeners = [];
  async connect() {
    const path = socketPath();
    if (!existsSync(path)) {
      throw new Error(`exocortexd socket not found. Is the daemon running?
` + "Start it with: cd daemon && bun run start");
    }
    return new Promise((resolve2, reject) => {
      const socket = connect(path);
      let resolved = false;
      socket.on("connect", () => {
        this.socket = socket;
        resolved = true;
        resolve2();
      });
      socket.on("data", (data) => this.onData(data));
      socket.on("error", (err) => {
        if (!resolved)
          reject(new Error(`Connection failed: ${err.message}`));
      });
      socket.on("close", () => {
        this.socket = null;
      });
    });
  }
  disconnect() {
    this.socket?.end();
    this.socket = null;
  }
  send(command) {
    if (!this.socket)
      throw new Error("Not connected");
    this.socket.write(JSON.stringify(command) + `
`);
  }
  onEvent(listener) {
    this.listeners.push(listener);
  }
  offEvent(listener) {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1)
      this.listeners.splice(idx, 1);
  }
  request(command, match, timeoutMs = 1e4) {
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for response to ${command.type}`));
      }, timeoutMs);
      const handler = (event) => {
        if (event.type === "error" && event.reqId && event.reqId === command.reqId) {
          cleanup();
          reject(new Error(event.message));
          return;
        }
        if (match(event)) {
          cleanup();
          resolve2(event);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.offEvent(handler);
      };
      this.onEvent(handler);
      this.send(command);
    });
  }
  onData(data) {
    this.buffer += typeof data === "string" ? data : data.toString("utf-8");
    let idx;
    while ((idx = this.buffer.indexOf(`
`)) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line)
        continue;
      try {
        const event = JSON.parse(line);
        for (const listener of [...this.listeners])
          listener(event);
      } catch {}
    }
  }
}

// src/collect.ts
function collectResponse(conn, convId, text, timeoutMs, onStream) {
  return new Promise((resolve2, reject) => {
    const blocks = [];
    let tokens = 0;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for response"));
    }, timeoutMs);
    const waitHint = setTimeout(() => {
      process.stderr.write(`waiting for response…
`);
    }, 5000);
    const handler = (event) => {
      if (!("convId" in event) || event.convId !== convId)
        return;
      onStream?.(event);
      switch (event.type) {
        case "message_complete":
          blocks.push(...event.blocks);
          tokens += event.tokens;
          break;
        case "streaming_stopped":
          cleanup();
          resolve2({
            convId,
            blocks,
            tokens,
            duration: (Date.now() - startedAt) / 1000
          });
          break;
        case "error":
          cleanup();
          reject(new Error(event.message));
          break;
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(waitHint);
      conn.offEvent(handler);
    };
    conn.onEvent(handler);
    conn.send({
      type: "send_message",
      convId,
      text,
      startedAt
    });
  });
}

// src/format.ts
function formatBlocksAsText(blocks, full) {
  const parts = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "tool_call":
        parts.push(`  ╸ ${block.summary}`);
        break;
      case "tool_result":
        if (full) {
          const prefix = block.isError ? "  ✗ " : "  ┃ ";
          const indented = block.output.split(`
`).map((l) => prefix + l).join(`
`);
          parts.push(indented);
        }
        break;
      case "thinking":
        if (full) {
          parts.push(`  \uD83D\uDCAD ${block.text}`);
        }
        break;
    }
  }
  return parts.join(`
`);
}
function formatResponseAsJson(response) {
  return JSON.stringify({
    convId: response.convId,
    blocks: response.blocks,
    tokens: response.tokens,
    duration: response.duration
  });
}
function formatEntriesAsText(entries, full) {
  const parts = [];
  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        parts.push(`\x1B[1;34m▶ You\x1B[0m`);
        parts.push(entry.text);
        parts.push("");
        break;
      case "ai":
        parts.push(`\x1B[1;32m▶ Assistant\x1B[0m`);
        parts.push(formatBlocksAsText(entry.blocks, full));
        parts.push("");
        break;
      case "system":
        parts.push(`\x1B[1;33m▶ System\x1B[0m ${entry.text}`);
        parts.push("");
        break;
    }
  }
  return parts.join(`
`).trimEnd();
}
function formatEntriesAsJson(entries) {
  return JSON.stringify(entries);
}

// src/commands.ts
var reqCounter = 0;
function nextReqId() {
  return `cli_${++reqCounter}_${Date.now()}`;
}
function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
function autoTitle(text) {
  const firstLine = text.split(`
`)[0].trim();
  return "cli: " + truncate(firstLine, 75);
}
function makeLiveStreamCallback(targetConvId, full) {
  let wroteAnything = false;
  let atLineStart = true;
  return (event) => {
    if (!("convId" in event) || event.convId !== targetConvId)
      return;
    switch (event.type) {
      case "block_start":
        if (event.blockType === "text") {
          if (wroteAnything && !atLineStart)
            process.stdout.write(`
`);
        } else if (event.blockType === "thinking" && full) {
          process.stdout.write("  \uD83D\uDCAD ");
          atLineStart = false;
        }
        break;
      case "text_chunk":
        process.stdout.write(event.text);
        wroteAnything = true;
        atLineStart = event.text.endsWith(`
`);
        break;
      case "thinking_chunk":
        if (full) {
          process.stdout.write(event.text);
          wroteAnything = true;
          atLineStart = event.text.endsWith(`
`);
        }
        break;
      case "tool_call":
        if (!atLineStart)
          process.stdout.write(`
`);
        process.stdout.write(`  ╸ ${event.summary}
`);
        wroteAnything = true;
        atLineStart = true;
        break;
      case "tool_result":
        if (full) {
          const prefix = event.isError ? "  ✗ " : "  ┃ ";
          const indented = event.output.split(`
`).map((l) => prefix + l).join(`
`);
          process.stdout.write(indented + `
`);
          atLineStart = true;
        }
        break;
    }
  };
}
async function send(conn, text, convId, model, opts) {
  if (!convId) {
    const reqId = nextReqId();
    const title = autoTitle(text);
    const created = await conn.request({ type: "new_conversation", reqId, model: model ?? undefined, title }, (e) => e.type === "conversation_created" && e.reqId === reqId);
    convId = created.convId;
  } else if (model) {
    conn.send({ type: "set_model", convId, model });
  }
  conn.send({ type: "subscribe", convId });
  const liveText = !opts.json && !opts.stream && !opts.idOnly;
  const onStream = opts.stream ? (event) => {
    if ("convId" in event && event.convId === convId) {
      process.stdout.write(JSON.stringify(event) + `
`);
    }
  } : liveText ? makeLiveStreamCallback(convId, opts.full) : undefined;
  const response = await collectResponse(conn, convId, text, opts.timeout, onStream);
  try {
    conn.send({ type: "unsubscribe", convId });
  } catch {}
  if (opts.idOnly) {
    process.stdout.write(response.convId + `
`);
  } else if (opts.json) {
    process.stdout.write(formatResponseAsJson(response) + `
`);
  } else {
    process.stdout.write(`
exo:${response.convId}
`);
  }
  return 0;
}
async function ls(conn, opts) {
  const reqId = nextReqId();
  const event = await conn.request({ type: "list_conversations", reqId }, (e) => e.type === "conversations_list" && e.reqId === reqId);
  if (opts.json) {
    process.stdout.write(JSON.stringify(event.conversations) + `
`);
  } else {
    if (event.conversations.length === 0) {
      process.stdout.write(`No conversations.
`);
    } else {
      for (const c of event.conversations) {
        const prefix = c.pinned ? "\uD83D\uDCCC" : c.marked ? "★ " : "  ";
        const streaming = c.streaming ? " ⟳" : "";
        const title = c.title || "(untitled)";
        const date = new Date(c.updatedAt).toLocaleString();
        process.stdout.write(`${prefix}${c.id}  ${c.model}  ${c.messageCount} msgs  ${title}  ${date}${streaming}
`);
      }
    }
  }
  return 0;
}
async function info(conn, convId, opts) {
  const listReqId = nextReqId();
  const loadReqId = nextReqId();
  const [listEvent, loadEvent] = await Promise.all([
    conn.request({ type: "list_conversations", reqId: listReqId }, (e) => e.type === "conversations_list" && e.reqId === listReqId),
    conn.request({ type: "load_conversation", reqId: loadReqId, convId }, (e) => e.type === "conversation_loaded" && e.reqId === loadReqId)
  ]);
  const summary = listEvent.conversations.find((c) => c.id === convId);
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      convId: loadEvent.convId,
      title: summary?.title ?? "",
      model: loadEvent.model,
      contextTokens: loadEvent.contextTokens,
      messageCount: loadEvent.entries.length,
      pinned: summary?.pinned ?? false,
      marked: summary?.marked ?? false,
      streaming: summary?.streaming ?? false,
      createdAt: summary?.createdAt ?? null,
      updatedAt: summary?.updatedAt ?? null,
      queuedMessages: loadEvent.queuedMessages ?? []
    }) + `
`);
  } else {
    const title = summary?.title || "(untitled)";
    process.stdout.write(`Conversation: ${loadEvent.convId}
`);
    process.stdout.write(`Title:        ${title}
`);
    process.stdout.write(`Model:        ${loadEvent.model}
`);
    process.stdout.write(`Messages:     ${loadEvent.entries.length}
`);
    process.stdout.write(`Context:      ${loadEvent.contextTokens ?? "unknown"} tokens
`);
    if (summary?.pinned)
      process.stdout.write(`Pinned:       yes
`);
    if (summary?.marked)
      process.stdout.write(`Marked:       yes
`);
    if (summary?.streaming)
      process.stdout.write(`Streaming:    yes
`);
    if (loadEvent.queuedMessages?.length) {
      process.stdout.write(`Queued:       ${loadEvent.queuedMessages.length} message(s)
`);
    }
  }
  return 0;
}
async function history(conn, convId, opts) {
  const reqId = nextReqId();
  const event = await conn.request({ type: "load_conversation", reqId, convId }, (e) => e.type === "conversation_loaded" && e.reqId === reqId);
  if (opts.json) {
    process.stdout.write(formatEntriesAsJson(event.entries) + `
`);
  } else {
    const output = formatEntriesAsText(event.entries, opts.full);
    if (output)
      process.stdout.write(output + `
`);
  }
  return 0;
}
async function rm(conn, convId) {
  const reqId = nextReqId();
  await conn.request({ type: "delete_conversation", reqId, convId }, (e) => e.type === "conversation_deleted" && e.convId === convId);
  process.stdout.write(`Deleted ${convId}
`);
  return 0;
}
async function abort(conn, convId) {
  const reqId = nextReqId();
  await conn.request({ type: "abort", reqId, convId }, (e) => e.type === "ack" && e.reqId === reqId);
  process.stdout.write(`Aborted.
`);
  return 0;
}
async function rename(conn, convId, title) {
  const reqId = nextReqId();
  await conn.request({ type: "rename_conversation", reqId, convId, title }, (e) => e.type === "conversation_updated" && e.summary.id === convId);
  process.stdout.write(`Renamed ${convId}
`);
  return 0;
}
async function llm(conn, userText, system, model, opts) {
  const reqId = nextReqId();
  const event = await conn.request({ type: "llm_complete", reqId, system, userText, model: model ?? undefined }, (e) => e.type === "llm_complete_result" && e.reqId === reqId, opts.timeout);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ text: event.text }) + `
`);
  } else {
    process.stdout.write(event.text + `
`);
  }
  return 0;
}
async function rescan(conn) {
  const reqId = nextReqId();
  const event = await conn.request({ type: "rescan_conversations", reqId }, (e) => e.type === "conversations_list" && e.reqId === reqId);
  process.stdout.write(`Rescanned: ${event.conversations.length} conversation(s) total
`);
  return 0;
}
async function status(conn, opts) {
  const reqId = nextReqId();
  const startedAt = Date.now();
  await conn.request({ type: "ping", reqId }, (e) => e.type === "pong" && e.reqId === reqId, 5000);
  const latencyMs = Date.now() - startedAt;
  const listReqId = nextReqId();
  const listEvent = await conn.request({ type: "list_conversations", reqId: listReqId }, (e) => e.type === "conversations_list" && e.reqId === listReqId);
  const convCount = listEvent.conversations.length;
  const streaming = listEvent.conversations.filter((c) => c.streaming).length;
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: "ok",
      latencyMs,
      conversations: convCount,
      streaming
    }) + `
`);
  } else {
    process.stdout.write(`Daemon:        online (${latencyMs}ms)
`);
    process.stdout.write(`Conversations: ${convCount}
`);
    if (streaming > 0) {
      process.stdout.write(`Streaming:     ${streaming} active
`);
    }
  }
  return 0;
}

// src/help.ts
var b = (s) => `\x1B[1m${s}\x1B[0m`;
function printHelp() {
  process.stdout.write(`${b("exo")} — Exocortex CLI client

${b("USAGE")}
  exo "message"                     Send a message (new conversation)
  exo "message" -c <id>             Continue a conversation
  exo "message" --opus              Use a specific model
  cat file | exo -                  Read message from stdin

${b("COMMANDS")}
  ls (list)                         List conversations
  info (show) <id>                  Conversation metadata
  history (log) <id>                Conversation history
  rm (delete, del) <id>             Delete a conversation
  abort (kill, cancel) <id>         Abort in-flight stream
  rename (mv, title) <id> <title>   Rename a conversation
  llm "text" --system "prompt"      One-shot LLM (no conversation)
  status (ping)                     Check if daemon is running
  help                              Show this help

${b("FLAGS")}
  --opus, --sonnet, --haiku         Model selection (default: opus)
                                    opus for complex/quality-critical tasks,
                                    sonnet for routine code, haiku for lookups
  -c, --conv <id>                   Conversation ID
  --json                            Structured JSON output
  --full                            Include thinking + tool results
  --stream                          Stream events as NDJSON
  --id                              Print only conversation ID
  --timeout <sec>                   Max wait time (default 300)
  --system <prompt>                 System prompt (for llm)

${b("SUBAGENT TIMEOUTS")}
  Subagent conversations (sending tasks to the AI) can take a long time.
  Always pass --timeout appropriate to the task complexity:
    Simple lookups/questions:         --timeout 300   (5 min)
    Moderate coding/research:         --timeout 600   to --timeout 1800 (10-30 min)
    Complex multi-step work:          --timeout 3600  (1 hour)

Run ${b("exo <command> --help")} for command-specific usage.
`);
}
var COMMAND_HELP = {
  send: `${b("exo")} "message" [flags]

Send a message to the AI. Creates a new conversation unless -c is given.

${b("USAGE")}
  exo "what is 2+2"                 New conversation, default model
  exo "explain this" --opus         New conversation, specific model
  exo "follow up" -c <id>           Continue existing conversation
  cat prompt.txt | exo -            Read message from stdin
  echo "question" | exo - -c <id>   Stdin + continue conversation

${b("FLAGS")}
  -c, --conv <id>                   Continue this conversation
  --opus, --sonnet, --haiku         Model selection (default: opus)
  --json                            Output as JSON (blocks, tokens, duration)
  --full                            Include thinking blocks and tool results
  --stream                          Stream events as NDJSON as they arrive
  --id                              Print only the conversation ID
  --timeout <sec>                   Max wait time (default 300)

${b("SUBAGENT TIMEOUTS")}
  Subagent conversations (sending tasks to the AI) can take a long time.
  Always pass --timeout appropriate to the task complexity:
    Simple lookups/questions:         --timeout 300   (5 min)
    Moderate coding/research:         --timeout 600   to --timeout 1800 (10-30 min)
    Complex multi-step work:          --timeout 3600  (1 hour)

${b("OUTPUT")}
  Default: response text + tool call summaries, then "exo:<convId>" on the last line.
  Thinking blocks and tool result output are hidden unless --full is given.
`,
  ls: `${b("exo ls")} [flags]

List all conversations.

${b("FLAGS")}
  --json                            Output as JSON array

${b("OUTPUT")}
  Default: table with ID, model, message count, title, last updated.
  Pinned conversations show \uD83D\uDCCC, marked conversations show ★.
`,
  info: `${b("exo info")} <id> [flags]

Show metadata for a conversation.

${b("USAGE")}
  exo info <convId>
  exo info <convId> --json

${b("FLAGS")}
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
  --json                            Output as JSON array of display entries
  --full                            Include thinking blocks and tool results

${b("OUTPUT")}
  Default: user and assistant messages with role labels.
  Tool calls shown as summaries. Thinking and tool results hidden unless --full.
`,
  rm: `${b("exo rm")} <id>

Delete a conversation. The daemon soft-deletes to trash.

${b("USAGE")}
  exo rm <convId>
`,
  abort: `${b("exo abort")} <id>

Abort an in-flight stream for a conversation.

${b("USAGE")}
  exo abort <convId>
`,
  rename: `${b("exo rename")} <id> <title>

Rename a conversation.

${b("USAGE")}
  exo rename <convId> "new title"
`,
  status: `${b("exo status")} [flags]

Check if the daemon is running and show a quick summary.

${b("USAGE")}
  exo status
  exo status --json

${b("FLAGS")}
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
  cat file.txt | exo llm - --system "Summarize" --haiku

${b("FLAGS")}
  --system <prompt>                 System prompt (default: "You are a helpful assistant.")
  --opus, --sonnet, --haiku         Model selection (default: haiku)
  --json                            Output as JSON object
  --timeout <sec>                   Max wait time (default 300)
`
};
var HELP_ALIASES = {
  list: "ls",
  delete: "rm",
  remove: "rm",
  del: "rm",
  kill: "abort",
  cancel: "abort",
  mv: "rename",
  title: "rename",
  ping: "status",
  health: "status",
  log: "history",
  show: "info",
  send: "send",
  chat: "send",
  ask: "send",
  one: "llm"
};
function resolveHelp(command) {
  return HELP_ALIASES[command] ?? command;
}
function printCommandHelp(command) {
  const resolved = resolveHelp(command);
  const help = COMMAND_HELP[resolved];
  if (help) {
    process.stdout.write(help);
  } else {
    process.stderr.write(`No help available for '${command}'.
`);
  }
}
function hasCommandHelp(command) {
  const resolved = resolveHelp(command);
  return resolved in COMMAND_HELP;
}

// src/main.ts
var SUBCOMMANDS = new Set(["ls", "info", "history", "rm", "abort", "rename", "llm", "rescan", "status", "help"]);
var ALIASES = {
  list: "ls",
  delete: "rm",
  remove: "rm",
  del: "rm",
  kill: "abort",
  cancel: "abort",
  mv: "rename",
  title: "rename",
  ping: "status",
  health: "status",
  log: "history",
  show: "info",
  send: "send",
  chat: "send",
  ask: "send",
  one: "llm"
};
function looksLikeCommand(word) {
  return /^[a-z][-a-z0-9]{1,15}$/.test(word) && !word.includes("/") && !word.includes(".") && !word.startsWith("http");
}
function parseArgs(argv) {
  const result = {
    subcommand: null,
    positionals: [],
    conv: null,
    model: null,
    system: "You are a helpful assistant.",
    json: false,
    full: false,
    stream: false,
    idOnly: false,
    timeout: 300000,
    wantsHelp: false
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--opus") {
      result.model = "opus";
      i++;
      continue;
    }
    if (arg === "--sonnet") {
      result.model = "sonnet";
      i++;
      continue;
    }
    if (arg === "--haiku") {
      result.model = "haiku";
      i++;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      i++;
      continue;
    }
    if (arg === "--full") {
      result.full = true;
      i++;
      continue;
    }
    if (arg === "--stream") {
      result.stream = true;
      i++;
      continue;
    }
    if (arg === "--id") {
      result.idOnly = true;
      i++;
      continue;
    }
    if ((arg === "-c" || arg === "--conv") && i + 1 < argv.length) {
      result.conv = argv[++i];
      i++;
      continue;
    }
    if (arg === "--system" && i + 1 < argv.length) {
      result.system = argv[++i];
      i++;
      continue;
    }
    if (arg === "--timeout" && i + 1 < argv.length) {
      result.timeout = parseInt(argv[++i], 10) * 1000;
      i++;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      result.wantsHelp = true;
      i++;
      continue;
    }
    result.positionals.push(arg);
    i++;
  }
  if (result.positionals.length > 0) {
    const first = result.positionals[0];
    if (SUBCOMMANDS.has(first)) {
      result.subcommand = result.positionals.shift();
    } else if (first in ALIASES) {
      result.positionals.shift();
      const resolved = ALIASES[first];
      result.subcommand = resolved === "send" ? null : resolved;
    }
  }
  return result;
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.subcommand === "help") {
    const topic = args.positionals[0];
    if (topic && hasCommandHelp(topic)) {
      printCommandHelp(topic);
    } else {
      printHelp();
    }
    return 0;
  }
  if (args.wantsHelp) {
    if (args.subcommand && hasCommandHelp(args.subcommand)) {
      printCommandHelp(args.subcommand);
    } else if (!args.subcommand && args.positionals.length === 0) {
      printHelp();
    } else {
      printCommandHelp("send");
    }
    return 0;
  }
  if (args.positionals.length === 0 && !args.subcommand) {
    printHelp();
    return 0;
  }
  const opts = {
    json: args.json,
    full: args.full,
    stream: args.stream,
    idOnly: args.idOnly,
    timeout: args.timeout
  };
  const conn = new Connection;
  try {
    await conn.connect();
  } catch (err) {
    process.stderr.write(`Error: ${err.message}
`);
    return 2;
  }
  try {
    switch (args.subcommand) {
      case "ls":
        return await ls(conn, opts);
      case "status":
        return await status(conn, opts);
      case "rescan":
        return await rescan(conn);
      case "info": {
        const convId = args.positionals[0];
        if (!convId) {
          process.stderr.write(`Usage: exo info <convId>
Run 'exo info --help' for details.
`);
          return 1;
        }
        return await info(conn, convId, opts);
      }
      case "history": {
        const convId = args.positionals[0];
        if (!convId) {
          process.stderr.write(`Usage: exo history <convId>
Run 'exo history --help' for details.
`);
          return 1;
        }
        return await history(conn, convId, opts);
      }
      case "rm": {
        const convId = args.positionals[0];
        if (!convId) {
          process.stderr.write(`Usage: exo rm <convId>
`);
          return 1;
        }
        return await rm(conn, convId);
      }
      case "abort": {
        const convId = args.positionals[0];
        if (!convId) {
          process.stderr.write(`Usage: exo abort <convId>
`);
          return 1;
        }
        return await abort(conn, convId);
      }
      case "rename": {
        const convId = args.positionals[0];
        const title = args.positionals.slice(1).join(" ");
        if (!convId || !title) {
          process.stderr.write(`Usage: exo rename <convId> <title>
Run 'exo rename --help' for details.
`);
          return 1;
        }
        return await rename(conn, convId, title);
      }
      case "llm": {
        const text = args.positionals[0] === "-" ? await readStdin() : args.positionals.join(" ");
        if (!text) {
          process.stderr.write(`Usage: exo llm "text" --system "prompt"
Run 'exo llm --help' for details.
`);
          return 1;
        }
        return await llm(conn, text, args.system, args.model, opts);
      }
      default: {
        let text;
        if (args.positionals.length === 1 && args.positionals[0] === "-") {
          text = await readStdin();
        } else {
          text = args.positionals.join(" ");
        }
        if (!text) {
          printHelp();
          return 0;
        }
        if (args.positionals.length <= 3 && args.positionals.every((w) => looksLikeCommand(w)) && !args.conv) {
          const allCommands = [...SUBCOMMANDS].filter((c) => c !== "help").concat(Object.keys(ALIASES));
          process.stderr.write(`Unknown command: ${text}
` + `Available commands: ${[...SUBCOMMANDS].filter((c) => c !== "help").join(", ")}
` + `Aliases: ${Object.entries(ALIASES).map(([a, c]) => `${a}→${c}`).join(", ")}

` + `If you meant to send this as a message, quote it:
` + `  exo "${text}"
`);
          return 1;
        }
        return await send(conn, text, args.conv, args.model, opts);
      }
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}
`);
    return 1;
  } finally {
    conn.disconnect();
  }
}
main().then((code) => process.exit(code));
