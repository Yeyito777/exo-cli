/**
 * exo — Exocortex CLI client.
 *
 * A stateless, machine-friendly interface to exocortexd.
 * Each invocation connects, does its work, and disconnects.
 * The daemon holds all state; conversation IDs are the handles.
 *
 * Usage:
 *   exo send "message"              Send a message (new conversation)
 *   exo send "follow up" -c <id>    Continue a conversation
 *   exo ls                          List conversations
 *   exo info <id>                   Show conversation metadata
 *   exo history <id>                Show conversation history
 *   exo rm <id>                     Delete a conversation
 *   exo abort <id>                  Abort in-flight stream
 *   exo rename <id> <title>         Rename a conversation
 *   exo llm "text" --system "..."   One-shot LLM completion
 *   exo status                      Check daemon health
 *
 * Flags:
 *   --opus, --sonnet, --haiku       Anthropic model shortcuts
 *   --model <spec>                  Model spec (e.g. anthropic/opus-4.6)
 *   --provider <id>                 Explicit provider
 *   -c, --conv <id>                 Conversation ID
 *   --json                          JSON output
 *   --full                          Include thinking + tool results
 *   --stream                        Stream events as NDJSON
 *   --id                            Print only conversation ID
 *   --timeout <sec>                 Max wait time (default 300)
 *   --system <prompt>               System prompt (for llm command)
 */

import { Connection } from "./conn";
import { send, ls, info, history, rm, abort, queue, rename, llm, status, type OutputOptions } from "./commands";
import { printHelp, printCommandHelp, hasCommandHelp } from "./help";
import { inferProviderForModel, isProviderId, normalizeModelForProvider, parseModelSpecifier } from "./model-spec";
import { setRepoRootOverride, setWorktreeOverride, sourceRepoRoot, worktreeName } from "./shared/paths";
import type { ModelId, ProviderId } from "./shared/protocol";

// ── Arg parsing ─────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(["send", "ls", "info", "history", "rm", "abort", "queue", "rename", "llm", "status", "help"]);

// Aliases → canonical subcommand name
const ALIASES: Record<string, string> = {
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
  chat: "send",
  ask: "send",
  a: "send",
  one: "llm",          // "exo one 'quick question'" as shorthand for llm
};

interface ParsedArgs {
  subcommand: string | null;
  positionals: string[];
  conv: string | null;
  provider: ProviderId | null;
  model: ModelId | null;
  system: string;
  instance: string | null;
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
  wantsHelp: boolean;
  endTiming: boolean;
  parseError: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
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
    timeout: 300_000,
    wantsHelp: false,
    endTiming: false,
    parseError: null,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // Flags
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
    if (arg === "--json") { result.json = true; i++; continue; }
    if (arg === "--full") { result.full = true; i++; continue; }
    if (arg === "--stream") { result.stream = true; i++; continue; }
    if (arg === "--id") { result.idOnly = true; i++; continue; }
    if ((arg === "-c" || arg === "--conv") && i + 1 < argv.length) {
      result.conv = argv[++i]; i++; continue;
    }
    if (arg === "--system" && i + 1 < argv.length) {
      result.system = argv[++i]; i++; continue;
    }
    if (arg === "--timeout" && i + 1 < argv.length) {
      result.timeout = parseInt(argv[++i], 10) * 1000; i++; continue;
    }
    if (arg === "--end") { result.endTiming = true; i++; continue; }
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

  return result;
}

// ── Stdin reading ───────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
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

  // --help flag on a subcommand: exo ls --help
  if (args.wantsHelp) {
    if (args.subcommand && hasCommandHelp(args.subcommand)) {
      printCommandHelp(args.subcommand);
    } else {
      printHelp();
    }
    return 0;
  }

  if (args.parseError) {
    process.stderr.write(`Error: ${args.parseError}\n\n`);
    printHelp();
    return 1;
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

  if (args.instance) {
    setWorktreeOverride(args.instance);
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/${args.instance}`);
  }

  const opts: OutputOptions = {
    json: args.json,
    full: args.full,
    stream: args.stream,
    idOnly: args.idOnly,
    timeout: args.timeout,
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
      case "ls":
        return await ls(conn, opts);

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

      case "rm": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo rm <convId>\n"); return 1; }
        return await rm(conn, convId);
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
        const text = args.positionals[0] === "-"
          ? await readStdin()
          : args.positionals.join(" ");
        if (!text) { process.stderr.write("Usage: exo llm \"text\" --system \"prompt\"\nRun 'exo llm --help' for details.\n"); return 1; }
        return await llm(conn, text, args.system, args.provider, args.model, opts);
      }

      case "queue": {
        const convId = args.positionals[0];
        const text = args.positionals.slice(1).join(" ");
        if (!convId || !text) { process.stderr.write("Usage: exo queue <convId> \"message\" [--end]\nRun 'exo queue --help' for details.\n"); return 1; }
        const timing = args.endTiming ? "message-end" as const : "next-turn" as const;
        return await queue(conn, convId, text, timing);
      }

      case "send": {
        let text: string;
        if (args.positionals.length === 1 && args.positionals[0] === "-") {
          text = await readStdin();
        } else {
          text = args.positionals.join(" ");
        }
        if (!text) { process.stderr.write("Usage: exo send \"message\"\nRun 'exo send --help' for details.\n"); return 1; }
        return await send(conn, text, args.conv, args.provider, args.model, opts);
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
