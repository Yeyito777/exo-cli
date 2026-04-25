// @bun
// src/conn.ts
import { connect } from "net";
import { existsSync } from "fs";

// src/shared/paths.ts
import { join, resolve } from "path";
var SOURCE_REPO_ROOT = resolve(import.meta.dir, "../../../..");
var _worktreeOverride = null;
var _repoRootOverride = null;
function effectiveRepoRoot() {
  return _repoRootOverride ?? SOURCE_REPO_ROOT;
}
function effectiveWorktreeName() {
  return _worktreeOverride;
}
function configDirForRoot(root) {
  return join(root, "config");
}
function repoRoot() {
  return effectiveRepoRoot();
}
function configDir() {
  return configDirForRoot(repoRoot());
}
function runtimeDir() {
  const wt = effectiveWorktreeName();
  return wt ? join(configDir(), "runtime", wt) : join(configDir(), "runtime");
}
function socketPath() {
  return join(runtimeDir(), "exocortexd.sock");
}
function worktreeName() {
  return effectiveWorktreeName();
}
function setWorktreeOverride(name) {
  _worktreeOverride = name && name.trim() ? name.trim() : null;
}
function setRepoRootOverride(path) {
  _repoRootOverride = path && path.trim() ? resolve(path.trim()) : null;
}
function sourceRepoRoot() {
  return SOURCE_REPO_ROOT;
}

// src/conn.ts
class Connection {
  socket = null;
  buffer = "";
  listeners = [];
  async connect() {
    const path = socketPath();
    const instance = worktreeName();
    if (!existsSync(path)) {
      const target = instance ? ` for instance '${instance}'` : "";
      throw new Error(`exocortexd socket${target} not found. Is the daemon running?
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

// src/model-spec.ts
var ANTHROPIC_ALIASES = {
  opus: "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "haiku-4.5": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001"
};
function isProviderId(value) {
  return value === "anthropic" || value === "openai";
}
function inferProviderForModel(model) {
  if (!model)
    return;
  const lowered = model.trim().toLowerCase();
  return lowered in ANTHROPIC_ALIASES ? "anthropic" : undefined;
}
function normalizeModelForProvider(provider, model) {
  const trimmed = model.trim();
  const lowered = trimmed.toLowerCase();
  if (provider === "anthropic" || provider === null) {
    const anthropic = ANTHROPIC_ALIASES[lowered];
    if (anthropic)
      return anthropic;
  }
  return trimmed;
}
function parseModelSpecifier(spec) {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("--model requires a non-empty value");
  }
  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const providerPart = trimmed.slice(0, slash).trim().toLowerCase();
    const modelPart = trimmed.slice(slash + 1).trim();
    if (!isProviderId(providerPart)) {
      throw new Error(`Unknown provider in model spec: ${providerPart}`);
    }
    if (!modelPart) {
      throw new Error(`Missing model name after provider in --model ${JSON.stringify(spec)}`);
    }
    return {
      provider: providerPart,
      model: normalizeModelForProvider(providerPart, modelPart)
    };
  }
  const anthropic = ANTHROPIC_ALIASES[trimmed.toLowerCase()];
  if (anthropic) {
    return { provider: "anthropic", model: anthropic };
  }
  return { provider: null, model: trimmed };
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
      process.stderr.write(`waiting for response\u2026
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
        parts.push(`  \u2578 ${block.summary}`);
        break;
      case "tool_result":
        if (full) {
          const prefix = block.isError ? "  \u2717 " : "  \u2503 ";
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
        parts.push(`\x1B[1;34m\u25B6 You\x1B[0m`);
        parts.push(entry.text);
        parts.push("");
        break;
      case "ai":
        parts.push(`\x1B[1;32m\u25B6 Assistant\x1B[0m`);
        parts.push(formatBlocksAsText(entry.blocks, full));
        parts.push("");
        break;
      case "system":
        parts.push(`\x1B[1;33m\u25B6 System\x1B[0m ${entry.text}`);
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
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
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
        process.stdout.write(`  \u2578 ${event.summary}
`);
        wroteAnything = true;
        atLineStart = true;
        break;
      case "tool_result":
        if (full) {
          const prefix = event.isError ? "  \u2717 " : "  \u2503 ";
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
async function send(conn, text, convId, provider, model, opts) {
  const resolvedProvider = provider ?? inferProviderForModel(model);
  if (!convId) {
    const reqId = nextReqId();
    const title = autoTitle(text);
    const created = await conn.request({ type: "new_conversation", reqId, provider: resolvedProvider ?? undefined, model: model ?? undefined, title }, (e) => e.type === "conversation_created" && e.reqId === reqId);
    convId = created.convId;
  } else if (model) {
    conn.send({ type: "set_model", convId, provider: resolvedProvider ?? undefined, model });
  }
  if (opts.detached) {
    const reqId = nextReqId();
    const notifyParent = opts.notifyParent ? { convId: opts.notifyParent } : undefined;
    await conn.request({
      type: "send_message",
      reqId,
      convId,
      text,
      startedAt: Date.now(),
      detached: true,
      notifyParent
    }, (e) => e.type === "ack" && e.reqId === reqId);
    if (opts.idOnly) {
      process.stdout.write(convId + `
`);
    } else if (opts.json) {
      process.stdout.write(JSON.stringify({ convId, detached: true, notifyParent: notifyParent?.convId ?? null }) + `
`);
    } else {
      const notifyText = notifyParent ? ` Parent will be notified when it completes.` : ` No parent notification configured.`;
      process.stdout.write(`Started detached subagent exo:${convId}.${notifyText}
`);
    }
    return 0;
  }
  conn.send({ type: "subscribe", convId });
  const liveText = !opts.json && !opts.stream && !opts.idOnly;
  const onStream = opts.stream ? (event) => {
    if ("convId" in event && event.convId === convId) {
      process.stdout.write(JSON.stringify(event) + `
`);
    }
  } : liveText ? makeLiveStreamCallback(convId, opts.full) : undefined;
  let response;
  try {
    response = await collectResponse(conn, convId, text, opts.timeout, onStream);
  } catch (err) {
    if (convId && err?.message?.includes("Already streaming")) {
      const reqId = nextReqId();
      await conn.request({ type: "queue_message", reqId, convId, text, timing: "next-turn" }, (e) => e.type === "ack" && e.reqId === reqId);
      process.stdout.write(`Conversation is busy \u2014 message queued for next turn.
`);
      return 0;
    }
    throw err;
  }
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
async function list(conn, opts) {
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
        const prefix = c.pinned ? "\uD83D\uDCCC" : c.marked ? "\u2605 " : "  ";
        const streaming = c.streaming ? " \u27F3" : "";
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
async function deleteConversation(conn, convId) {
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
async function queue(conn, convId, text, timing) {
  const reqId = nextReqId();
  await conn.request({ type: "queue_message", reqId, convId, text, timing }, (e) => e.type === "ack" && e.reqId === reqId);
  process.stdout.write(`Queued (${timing}) for ${convId}
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
async function llm(conn, userText, system, provider, model, opts) {
  const reqId = nextReqId();
  const resolvedProvider = provider ?? inferProviderForModel(model);
  const event = await conn.request({ type: "llm_complete", reqId, provider: resolvedProvider ?? undefined, system, userText, model: model ?? undefined }, (e) => e.type === "llm_complete_result" && e.reqId === reqId, opts.timeout);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ text: event.text }) + `
`);
  } else {
    process.stdout.write(event.text + `
`);
  }
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
var INSTANCE_FLAG_SUMMARY = `  --instance <worktree>             Target a specific worktree daemon instance`;
var MODEL_FLAG_SUMMARY = `  --opus, --sonnet, --haiku         Claude model shortcuts
  --model <spec>                    Model: opus-4.6 | anthropic/opus-4.6 |
                                    claude-opus-4-6 | openai/gpt-5.5
  --provider <id>                   Provider: anthropic | openai`;
var MODEL_FLAG_SUMMARY_SEND = `  --opus, --sonnet, --haiku         Claude model shortcuts
  --model <spec>                    Model: opus-4.6 | anthropic/opus-4.6 |
                                    claude-opus-4-6 | openai/gpt-5.5
  --provider <id>                   Provider: anthropic | openai`;
function printHelp() {
  process.stdout.write(`${b("exo")} \u2014 Exocortex CLI client

${b("USAGE")}
  exo send "message"                               New conversation
  exo send "message" -c <id>                       Continue a conversation
  exo send "message" --opus                        Claude Opus shortcut
  exo send "message" --model anthropic/opus-4.6    Explicit model
  exo send "message" --provider openai --model gpt-5.4-mini
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
var COMMAND_HELP = {
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
  Pinned conversations show \uD83D\uDCCC, marked conversations show \u2605.
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
daemon and injected automatically \u2014 either before the next AI turn (default)
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
`
};
var HELP_ALIASES = {
  ls: "list",
  rm: "delete",
  mv: "rename"
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
var SUBCOMMANDS = new Set(["send", "list", "info", "history", "delete", "abort", "queue", "rename", "llm", "status", "help"]);
var ALIASES = {
  ls: "list",
  rm: "delete",
  mv: "rename"
};
function parseArgs(argv) {
  const result = {
    subcommand: null,
    positionals: [],
    conv: null,
    provider: null,
    model: null,
    system: "You are a helpful assistant.",
    instance: null,
    json: false,
    full: false,
    stream: false,
    idOnly: false,
    timeout: 300000,
    wantsHelp: false,
    endTiming: false,
    detach: false,
    foreground: false,
    notifyParent: null,
    noNotify: false,
    parseError: null
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--opus" || arg === "--sonnet" || arg === "--haiku") {
      const selection = parseModelSpecifier(arg.slice(2));
      result.provider = selection.provider;
      result.model = selection.model;
      i++;
      continue;
    }
    if (arg === "--provider") {
      if (i + 1 >= argv.length) {
        result.parseError = "--provider requires a value";
        return result;
      }
      const provider = argv[++i].trim().toLowerCase();
      if (!isProviderId(provider)) {
        result.parseError = `Unknown provider: ${provider}`;
        return result;
      }
      result.provider = provider;
      i++;
      continue;
    }
    if (arg === "--model") {
      if (i + 1 >= argv.length) {
        result.parseError = "--model requires a value";
        return result;
      }
      try {
        const spec = argv[++i];
        if (spec.includes("/")) {
          const selection = parseModelSpecifier(spec);
          result.provider = selection.provider;
          result.model = selection.model;
        } else {
          const model = normalizeModelForProvider(result.provider, spec);
          result.model = model;
          result.provider = result.provider ?? inferProviderForModel(model) ?? null;
        }
      } catch (err) {
        result.parseError = err instanceof Error ? err.message : String(err);
        return result;
      }
      i++;
      continue;
    }
    if (arg === "--instance") {
      if (i + 1 >= argv.length) {
        result.parseError = "--instance requires a value";
        return result;
      }
      result.instance = argv[++i].trim() || null;
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
    if (arg === "--end") {
      result.endTiming = true;
      i++;
      continue;
    }
    if (arg === "--detach" || arg === "--background") {
      result.detach = true;
      i++;
      continue;
    }
    if (arg === "--foreground") {
      result.foreground = true;
      i++;
      continue;
    }
    if (arg === "--no-notify") {
      result.noNotify = true;
      i++;
      continue;
    }
    if (arg === "--notify-parent") {
      if (i + 1 >= argv.length) {
        result.parseError = "--notify-parent requires a conversation ID";
        return result;
      }
      result.notifyParent = argv[++i];
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
      result.subcommand = ALIASES[first];
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
    } else {
      printHelp();
    }
    return 0;
  }
  if (args.parseError) {
    process.stderr.write(`Error: ${args.parseError}

`);
    printHelp();
    return 1;
  }
  if (!args.subcommand && args.positionals.length === 0) {
    printHelp();
    return 0;
  }
  if (!args.subcommand && args.positionals.length > 0) {
    process.stderr.write(`Unknown command: ${args.positionals[0]}

`);
    printHelp();
    return 1;
  }
  if (args.instance) {
    setWorktreeOverride(args.instance);
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/${args.instance}`);
  }
  const parentConvId = process.env.EXOCORTEX_PARENT_CONV_ID?.trim() || null;
  const autoDetachSend = Boolean(parentConvId) && !args.foreground && args.conv !== parentConvId;
  const opts = {
    json: args.json,
    full: args.full,
    stream: args.stream,
    idOnly: args.idOnly,
    timeout: args.timeout,
    detached: args.detach || autoDetachSend,
    notifyParent: args.noNotify ? null : args.notifyParent ?? parentConvId
  };
  const conn = new Connection;
  try {
    await conn.connect();
  } catch (err) {
    process.stderr.write(`Error: ${err.message}
`);
    return 2;
  }
  if (!args.json) {
    const target = worktreeName();
    if (args.instance && target) {
      process.stderr.write(`exo: targeting instance '${target}'
`);
    }
  }
  try {
    switch (args.subcommand) {
      case "list":
        return await list(conn, opts);
      case "status":
        return await status(conn, opts);
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
      case "delete": {
        const convId = args.positionals[0];
        if (!convId) {
          process.stderr.write(`Usage: exo delete <convId>
Run 'exo delete --help' for details.
`);
          return 1;
        }
        return await deleteConversation(conn, convId);
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
        return await llm(conn, text, args.system, args.provider, args.model, opts);
      }
      case "queue": {
        const convId = args.positionals[0];
        const text = args.positionals.slice(1).join(" ");
        if (!convId || !text) {
          process.stderr.write(`Usage: exo queue <convId> "message" [--end]
Run 'exo queue --help' for details.
`);
          return 1;
        }
        const timing = args.endTiming ? "message-end" : "next-turn";
        return await queue(conn, convId, text, timing);
      }
      case "send": {
        let text;
        if (args.positionals.length === 1 && args.positionals[0] === "-") {
          text = await readStdin();
        } else {
          text = args.positionals.join(" ");
        }
        if (!text) {
          process.stderr.write(`Usage: exo send "message"
Run 'exo send --help' for details.
`);
          return 1;
        }
        return await send(conn, text, args.conv, args.provider, args.model, opts);
      }
      default: {
        process.stderr.write(`Unknown command: ${args.subcommand}

`);
        printHelp();
        return 1;
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
