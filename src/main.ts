/**
 * exo — Exocortex daemon debugging CLI.
 *
 * A stateless, machine-friendly shell client for debugging, inspecting, and
 * administering exocortexd instances. AI conversations should use the native
 * exo internal tool for their current daemon; this external client remains for
 * other instances, protocol/socket troubleshooting, and audio transcription.
 * Each invocation connects, does its work, and disconnects.
 * The daemon holds all state; conversation IDs are the handles.
 *
 * Usage:
 *   printf '%s' "message" | exo send              Send a message (new conversation)
 *   printf '%s' "follow up" | exo send -c <id>    Continue a conversation
 *   exo list                        List conversations
 *   exo info <id>                   Show conversation metadata
 *   exo history <id>                Show conversation history
 *   exo delete <id>                 Delete a conversation
 *   exo abort <id>                  Abort in-flight stream
 *   exo rename <id> <title>         Rename a conversation
 *   printf '%s' "text" | exo llm     One-shot LLM completion
 *   exo transcribe file.wav          Transcribe audio through the daemon
 *   exo status                      Check daemon health
 *
 * Flags:
 *   --model <spec>                  Model spec (e.g. openai/gpt-5.6-sol)
 *   --provider <id>                 Explicit provider
 *   -c, --conv <id>                 Conversation ID
 *   --json                          JSON output
 *   --full                          Include thinking + tool results
 *   --stream                        Stream events as NDJSON
 *   --id                            Print only conversation ID
 *   --timeout <sec>                 Max wait time (default 300)
 *   --system-file <path>            System prompt file (for llm command)
 *   --detach, --background          Start exo send and return immediately
 *   --foreground                    Disable parent-agent auto-detach for send
 *   --notify-parent <id>            Notify a parent conversation on send completion
 *   --no-notify                     Detach send without parent notification
 */

import { Connection } from "./conn";
import { send, list, jobs, folderList, folderTree, folderMkdir, folderMove, folderRemove, info, history, deleteConversation, abort, queue, rename, llm, transcribeAudio, status, type OutputOptions } from "./commands";
import { printHelp, printCommandHelp, hasCommandHelp } from "./help";
import { inferProviderForModel, isProviderId, normalizeModelForProvider, parseModelSpecifier } from "./model-spec";
import { DEFAULT_SYSTEM_PROMPT, readExactStdin, readExactUtf8File } from "./payload";
import { setRepoRootOverride, setWorktreeOverride, sourceRepoRoot, worktreeName } from "./shared/paths";
import type { ModelId, ProviderId } from "./shared/protocol";

// ── Arg parsing ─────────────────────────────────────────────────────

const SUBCOMMANDS = new Set([
  "send",
  "list",
  "jobs",
  "folder",
  "info",
  "history",
  "delete",
  "abort",
  "queue",
  "rename",
  "llm",
  "transcribe",
  "status",
  "help",
]);

// Small Unix-style aliases only. Canonical commands are listed above.
const ALIASES: Record<string, string> = {
  ls: "list",
  rm: "delete",
  mv: "rename",
};

interface ParsedArgs {
  subcommand: string | null;
  positionals: string[];
  conv: string | null;
  provider: ProviderId | null;
  model: ModelId | null;
  systemFile: string | null;
  mimeType: string | null;
  instance: string | null;
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
  wantsHelp: boolean;
  endTiming: boolean;
  detach: boolean;
  foreground: boolean;
  notifyParent: string | null;
  noNotify: boolean;
  customToolModules: string[];
  internalTools: string[] | null;
  externalTools: string[] | null;
  folderPath: string | null;
  autoTitle: boolean;
  newConversationId: string | null;
  parseError: string | null;
  parseErrorCode: number;
  parseErrorShowsHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    positionals: [],
    conv: null,
    provider: null,
    model: null,
    systemFile: null,
    mimeType: null,
    instance: null,
    json: false,
    full: false,
    stream: false,
    idOnly: false,
    timeout: 300_000,
    wantsHelp: false,
    endTiming: false,
    detach: false,
    foreground: false,
    notifyParent: null,
    noNotify: false,
    customToolModules: [],
    internalTools: null,
    externalTools: null,
    folderPath: null,
    autoTitle: false,
    newConversationId: null,
    parseError: null,
    parseErrorCode: 1,
    parseErrorShowsHelp: true,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // Flags
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
    if (arg === "--json") { result.json = true; i++; continue; }
    if (arg === "--full") { result.full = true; i++; continue; }
    if (arg === "--stream") { result.stream = true; i++; continue; }
    if (arg === "--id") { result.idOnly = true; i++; continue; }
    if ((arg === "-c" || arg === "--conv") && i + 1 < argv.length) {
      result.conv = argv[++i]; i++; continue;
    }
    if (arg === "--system" || arg.startsWith("--system=")) {
      result.parseError = "--system is not accepted; use --system-file <path>";
      result.parseErrorCode = 2;
      result.parseErrorShowsHelp = false;
      return result;
    }
    if (arg === "--system-file") {
      if (i + 1 >= argv.length) {
        result.parseError = "--system-file requires a path";
        return result;
      }
      if (result.systemFile !== null) {
        result.parseError = "--system-file may only be provided once";
        return result;
      }
      result.systemFile = argv[++i]; i++; continue;
    }
    if (arg.startsWith("--system-file=")) {
      if (result.systemFile !== null) {
        result.parseError = "--system-file may only be provided once";
        return result;
      }
      result.systemFile = arg.slice("--system-file=".length);
      if (!result.systemFile) {
        result.parseError = "--system-file requires a path";
        return result;
      }
      i++; continue;
    }
    if (arg === "--mime-type" && i + 1 < argv.length) {
      result.mimeType = argv[++i]; i++; continue;
    }
    if (arg === "--timeout" && i + 1 < argv.length) {
      result.timeout = parseInt(argv[++i], 10) * 1000; i++; continue;
    }
    if (arg === "--end") { result.endTiming = true; i++; continue; }
    if (arg === "--detach" || arg === "--background") { result.detach = true; i++; continue; }
    if (arg === "--foreground") { result.foreground = true; i++; continue; }
    if (arg === "--no-notify") { result.noNotify = true; i++; continue; }
    if (arg === "--custom-tool") {
      if (i + 1 >= argv.length) {
        result.parseError = "--custom-tool requires a module path";
        return result;
      }
      result.customToolModules.push(argv[++i]);
      i++;
      continue;
    }
    if (arg === "--internal-tool") {
      if (i + 1 >= argv.length) {
        result.parseError = "--internal-tool requires a tool name";
        return result;
      }
      if (result.internalTools === null) result.internalTools = [];
      result.internalTools.push(argv[++i]);
      i++;
      continue;
    }
    if (arg === "--external-tool") {
      if (i + 1 >= argv.length) {
        result.parseError = "--external-tool requires a tool name";
        return result;
      }
      if (result.externalTools === null) result.externalTools = [];
      result.externalTools.push(argv[++i]);
      i++;
      continue;
    }
    if (arg === "--folder") {
      if (i + 1 >= argv.length) {
        result.parseError = "--folder requires a sidebar folder path";
        return result;
      }
      if (result.folderPath !== null) {
        result.parseError = "--folder may only be provided once";
        return result;
      }
      result.folderPath = argv[++i];
      i++;
      continue;
    }
    if (arg === "--auto-title") { result.autoTitle = true; i++; continue; }
    if (arg === "--new-conversation-id") {
      if (i + 1 >= argv.length) {
        result.parseError = "--new-conversation-id requires an ID";
        return result;
      }
      result.newConversationId = argv[++i];
      if (!/^\d{13}-[a-z0-9]{6}$/.test(result.newConversationId)) {
        result.parseError = "--new-conversation-id must match <13-digit timestamp>-<6 lowercase letters/digits>";
        return result;
      }
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
      result.wantsHelp = true; i++; continue;
    }

    // Positionals
    result.positionals.push(arg);
    i++;
  }

  // Detect subcommand: first positional if it's a known command or alias
  if (result.positionals.length > 0) {
    const first = result.positionals[0];
    if (SUBCOMMANDS.has(first)) {
      result.subcommand = result.positionals.shift()!;
    } else if (first in ALIASES) {
      result.positionals.shift();
      result.subcommand = ALIASES[first];
    }
  }

  if (result.conv && (result.customToolModules.length > 0 || result.internalTools !== null || result.externalTools !== null || result.folderPath || result.autoTitle || result.newConversationId)) {
    result.parseError = "--custom-tool, tool selection, --folder, --auto-title, and --new-conversation-id are only valid when creating a new conversation";
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // help subcommand: exo help <command>
  if (args.subcommand === "help") {
    const topic = args.positionals[0];
    if (topic && hasCommandHelp(topic)) {
      printCommandHelp(topic);
    } else {
      printHelp();
    }
    return 0;
  }

  // --help flag on a subcommand: exo list --help
  if (args.wantsHelp) {
    if (args.subcommand && hasCommandHelp(args.subcommand)) {
      printCommandHelp(args.subcommand);
    } else {
      printHelp();
    }
    return 0;
  }

  if (args.parseError) {
    process.stderr.write(`Error: ${args.parseError}\n`);
    if (args.parseErrorShowsHelp) {
      process.stderr.write("\n");
      printHelp();
    }
    return args.parseErrorCode;
  }

  // No args at all → show help
  if (!args.subcommand && args.positionals.length === 0) {
    printHelp();
    return 0;
  }

  // Positionals but no recognized subcommand → unknown command
  if (!args.subcommand && args.positionals.length > 0) {
    process.stderr.write(`Unknown command: ${args.positionals[0]}\n\n`);
    printHelp();
    return 1;
  }

  let primaryPayload: string | null = null;
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  try {
    if (args.systemFile !== null && args.subcommand !== "llm") {
      throw new Error("--system-file is only valid with exo llm");
    }
    switch (args.subcommand) {
      case "send":
        if (args.positionals.length > 0) {
          throw new Error("send message must be provided via stdin; inline message is not accepted");
        }
        primaryPayload = await readExactStdin("send message");
        break;
      case "llm":
        if (args.positionals.length > 0) {
          throw new Error("llm prompt must be provided via stdin; inline prompt is not accepted");
        }
        primaryPayload = await readExactStdin("llm prompt");
        if (args.systemFile !== null) {
          if (args.systemFile === "-") {
            throw new Error("--system-file cannot be '-'; stdin is reserved for the primary llm prompt");
          }
          systemPrompt = await readExactUtf8File(args.systemFile, "llm system prompt");
        }
        break;
      case "queue":
        if (!args.positionals[0]) {
          process.stderr.write("Usage: exo queue <convId> [--end]\nRun 'exo queue --help' for details.\n");
          return 1;
        }
        if (args.positionals.length > 1) {
          throw new Error("queue message must be provided via stdin; inline message is not accepted");
        }
        primaryPayload = await readExactStdin("queue message");
        break;
    }
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (args.instance) {
    setWorktreeOverride(args.instance);
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/${args.instance}`);
  }

  const parentConvId = process.env.EXOCORTEX_PARENT_CONV_ID?.trim() || null;
  const autoDetachSend = Boolean(parentConvId) && !args.foreground && args.conv !== parentConvId;
  const spawnedByAgent = Boolean(parentConvId) || Boolean(args.notifyParent);

  const opts: OutputOptions = {
    json: args.json,
    full: args.full,
    stream: args.stream,
    idOnly: args.idOnly,
    timeout: args.timeout,
    detached: args.detach || autoDetachSend,
    notifyParent: args.noNotify ? null : (args.notifyParent ?? parentConvId),
    subagentFolder: spawnedByAgent,
    customToolModules: args.customToolModules,
    internalTools: args.internalTools ?? undefined,
    externalTools: args.externalTools ?? undefined,
    folderPath: args.folderPath,
    autoTitle: args.autoTitle,
    newConversationId: args.newConversationId,
  };

  const conn = new Connection();

  try {
    await conn.connect();
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 2;
  }

  if (!args.json) {
    const target = worktreeName();
    if (args.instance && target) {
      process.stderr.write(`exo: targeting instance '${target}'\n`);
    }
  }

  try {
    switch (args.subcommand) {
      case "list":
        return await list(conn, opts);

      case "jobs":
        return await jobs(conn, opts);

      case "folder": {
        const action = args.positionals[0] ?? "ls";
        const rest = args.positionals.slice(1);
        switch (action) {
          case "ls":
            return await folderList(conn, rest[0] ?? "/", opts);
          case "tree":
            return await folderTree(conn, rest[0] ?? "/", opts);
          case "mkdir": {
            const path = rest.join(" ").trim();
            if (!path) { process.stderr.write("Usage: exo folder mkdir <path>\nRun 'exo folder --help' for details.\n"); return 1; }
            return await folderMkdir(conn, path, opts);
          }
          case "mv": {
            if (rest.length < 2) { process.stderr.write("Usage: exo folder mv <source...> <dest>\nRun 'exo folder --help' for details.\n"); return 1; }
            const destination = rest.at(-1)!;
            const sources = rest.slice(0, -1).flatMap((part) => part.split(",")).map((part) => part.trim()).filter(Boolean);
            return await folderMove(conn, sources, destination, opts);
          }
          case "rm": {
            const path = rest.join(" ").trim();
            if (!path) { process.stderr.write("Usage: exo folder rm <path>\nRun 'exo folder --help' for details.\n"); return 1; }
            return await folderRemove(conn, path, opts);
          }
          default:
            process.stderr.write(`Unknown folder command: ${action}\n\n`);
            printCommandHelp("folder");
            return 1;
        }
      }

      case "status":
        return await status(conn, opts);

      case "info": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo info <convId>\nRun 'exo info --help' for details.\n"); return 1; }
        return await info(conn, convId, opts);
      }

      case "history": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo history <convId>\nRun 'exo history --help' for details.\n"); return 1; }
        return await history(conn, convId, opts);
      }

      case "delete": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo delete <convId>\nRun 'exo delete --help' for details.\n"); return 1; }
        return await deleteConversation(conn, convId);
      }

      case "abort": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo abort <convId>\n"); return 1; }
        return await abort(conn, convId);
      }

      case "rename": {
        const convId = args.positionals[0];
        const title = args.positionals.slice(1).join(" ");
        if (!convId || !title) { process.stderr.write("Usage: exo rename <convId> <title>\nRun 'exo rename --help' for details.\n"); return 1; }
        return await rename(conn, convId, title);
      }

      case "llm": {
        return await llm(conn, primaryPayload!, systemPrompt, args.provider, args.model, opts);
      }

      case "transcribe": {
        const path = args.positionals[0];
        if (!path) { process.stderr.write("Usage: exo transcribe <audio-file> [--mime-type audio/wav]\nRun 'exo transcribe --help' for details.\n"); return 1; }
        return await transcribeAudio(conn, path, args.mimeType, opts);
      }

      case "queue": {
        const convId = args.positionals[0];
        const timing = args.endTiming ? "message-end" as const : "next-turn" as const;
        return await queue(conn, convId, primaryPayload!, timing);
      }

      case "send": {
        return await send(conn, primaryPayload!, args.conv, args.provider, args.model, opts);
      }

      default: {
        // Should be unreachable — unknown commands are caught before connecting
        process.stderr.write(`Unknown command: ${args.subcommand}\n\n`);
        printHelp();
        return 1;
      }
    }
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  } finally {
    conn.disconnect();
  }
}

main().then((code) => process.exit(code));
