/** Stateless shell client for debugging/administering exocortexd instances. */
import { Connection } from "./conn";
import {
  send, list, jobs, models, folderList, folderTree, folderMkdir, folderMove,
  folderRemove, info, history, deleteConversation, abort, queue, rename,
  generateTitle, llm, transcribeAudio, status, type OutputOptions,
} from "./commands";
import { parseArgs } from "./args";
import { printHelp, printCommandHelp, hasCommandHelp } from "./help";
import { DEFAULT_SYSTEM_PROMPT, readExactStdin, readExactUtf8File } from "./payload";
import { setRepoRootOverride, setWorktreeOverride, sourceRepoRoot, worktreeName } from "./shared/paths";
import { version } from "../package.json";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.parseError) {
    process.stderr.write(`Error: ${args.parseError}\n`);
    return args.parseErrorCode;
  }
  if (args.version) { process.stdout.write(`exo ${version}\n`); return 0; }
  if (args.wantsHelp || args.subcommand === "help") {
    const topic = args.subcommand === "help" ? args.positionals[0] : args.subcommand;
    if (topic && hasCommandHelp(topic)) printCommandHelp(topic);
    else printHelp();
    return 0;
  }
  if (!args.subcommand) {
    if (args.positionals.length) {
      process.stderr.write(`Unknown command: ${args.positionals[0]}\n`);
      return 1;
    }
    printHelp();
    return 0;
  }

  let payload: string | null = null;
  let system = DEFAULT_SYSTEM_PROMPT;
  try {
    if (args.subcommand === "send" || args.subcommand === "llm") {
      if (args.positionals.length) throw new Error(`${args.subcommand} ${args.subcommand === "send" ? "message" : "prompt"} must be provided via stdin; inline ${args.subcommand === "send" ? "message" : "prompt"} is not accepted`);
      payload = await readExactStdin(args.subcommand === "send" ? "send message" : "llm prompt");
      if (args.systemFile !== null) {
        if (args.systemFile === "-") throw new Error("--system-file cannot be '-'; stdin is reserved for the primary llm prompt");
        system = await readExactUtf8File(args.systemFile, "llm system prompt");
      }
    } else if (args.subcommand === "queue") {
      if (!args.positionals[0]) throw new Error("Usage: exo queue <convId> [--end]");
      if (args.positionals.length > 1) throw new Error("queue message must be provided via stdin; inline message is not accepted");
      payload = await readExactStdin("queue message");
    } else if (["info", "history", "delete", "abort", "generate-title", "transcribe"].includes(args.subcommand)) {
      if (args.positionals.length !== 1) throw new Error(`Usage: exo ${args.subcommand} <${args.subcommand === "transcribe" ? "audio-file" : "convId"}>`);
    } else if (args.subcommand === "rename") {
      if (args.positionals.length < 2) throw new Error("Usage: exo rename <convId> <title>");
    } else if (args.subcommand === "folder") {
      const [action = "ls", ...rest] = args.positionals;
      if (!["ls", "tree", "mkdir", "mv", "rm"].includes(action)) throw new Error(`Unknown folder command: ${action}`);
      if (["ls", "tree"].includes(action) && rest.length > 1) throw new Error(`Usage: exo folder ${action} [path]`);
      if (["mkdir", "rm"].includes(action) && !rest.length) throw new Error(`Usage: exo folder ${action} <path>`);
      if (action === "mv" && rest.length < 2) throw new Error("Usage: exo folder mv <source...> <dest>");
    } else if (args.positionals.length) throw new Error(`exo ${args.subcommand} does not accept positional arguments`);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (args.repoRoot) setRepoRootOverride(args.repoRoot);
  if (args.instance) {
    setWorktreeOverride(args.instance);
    setRepoRootOverride(`${args.repoRoot ?? sourceRepoRoot()}/.worktrees/${args.instance}`);
  }
  const parent = process.env.EXOCORTEX_PARENT_CONV_ID?.trim() || null;
  const opts: OutputOptions = {
    json: args.json, full: args.full, stream: args.stream, idOnly: args.idOnly,
    timeout: args.timeout,
    detached: args.detach || (Boolean(parent) && !args.foreground && args.conv !== parent),
    notifyParent: args.noNotify ? null : (args.notifyParent ?? parent),
    subagentFolder: Boolean(parent) || Boolean(args.notifyParent),
    folderPath: args.folderPath, autoTitle: args.autoTitle,
    newConversationId: args.newConversationId, effort: args.effort,
    legacy: args.legacy, fastMode: args.fastMode ?? undefined,
  };
  const conn = new Connection();
  try { await conn.connect(args.timeout); } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (args.instance && !args.json) process.stderr.write(`exo: targeting instance '${worktreeName()}'\n`);
  try {
    const id = args.positionals[0];
    switch (args.subcommand) {
      case "list": return await list(conn, opts);
      case "jobs": return await jobs(conn, opts);
      case "models": return await models(conn, opts);
      case "status": return await status(conn, opts);
      case "info": return await info(conn, id, opts);
      case "history": return await history(conn, id, opts);
      case "delete": return await deleteConversation(conn, id, opts);
      case "abort": return await abort(conn, id, opts);
      case "rename": return await rename(conn, id, args.positionals.slice(1).join(" "), opts);
      case "generate-title": return await generateTitle(conn, id, opts);
      case "llm": return await llm(conn, payload!, system, args.provider, args.model, opts);
      case "transcribe": return await transcribeAudio(conn, id, args.mimeType, opts);
      case "queue": return await queue(conn, id, payload!, args.endTiming ? "message-end" : "next-turn", args.legacy, opts);
      case "send": return await send(conn, payload!, args.conv, args.provider, args.model, opts);
      case "folder": {
        const [action = "ls", ...rest] = args.positionals;
        switch (action) {
          case "ls": return await folderList(conn, rest[0] ?? "/", opts);
          case "tree": return await folderTree(conn, rest[0] ?? "/", opts);
          case "mkdir": return await folderMkdir(conn, rest.join(" "), opts);
          case "rm": return await folderRemove(conn, rest.join(" "), opts);
          case "mv": return await folderMove(conn, rest.slice(0, -1).flatMap(p => p.split(",")).map(p => p.trim()).filter(Boolean), rest.at(-1)!, opts);
        }
      }
    }
    return 1;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally { conn.disconnect(); }
}

// Let stdout/stderr drain; forced process.exit can truncate large JSON/history.
main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
