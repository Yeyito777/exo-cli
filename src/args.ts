import { isProviderId, parseModelSpecifier } from "./model-spec";
import { EFFORT_LEVELS } from "./shared/messages";
import type { EffortLevel, FastMode, ModelId, ProviderId } from "./shared/protocol";

const COMMANDS = new Set([
  "send", "list", "jobs", "models", "folder", "info", "history", "delete", "abort",
  "queue", "rename", "generate-title", "llm", "transcribe", "status", "run", "help",
]);
const APP_LIFETIMES = ["saved", "temporary", "ephemeral"] as const;
const APP_SYSTEM_BASES = ["none", "agent", "full"] as const;
const APP_BUILTIN_TOOLS = ["bash", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch", "exo", "chrono", "goal", "attach"];
const ALIASES: Record<string, string> = { ls: "list", rm: "delete", mv: "rename" };
const RETIRED = new Set(["--custom-tool", "--internal-tool", "--external-tool"]);

export interface ParsedArgs {
  subcommand: string | null;
  positionals: string[];
  conv: string | null;
  provider: ProviderId | null;
  model: ModelId | null;
  effort: EffortLevel | null;
  legacy: boolean;
  systemFile: string | null;
  mimeType: string | null;
  instance: string | null;
  repoRoot: string | null;
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
  wantsHelp: boolean;
  version: boolean;
  endTiming: boolean;
  detach: boolean;
  foreground: boolean;
  notifyParent: string | null;
  noNotify: boolean;
  folderPath: string | null;
  autoTitle: boolean;
  fastMode: FastMode | null;
  newConversationId: string | null;
  /** exo run / exo list --apps: the app name. */
  app: string | null;
  lifetime: "saved" | "temporary" | "ephemeral" | null;
  base: "none" | "agent" | "full" | null;
  /** Neutral built-in tool names, or "all". */
  tools: string[] | "all" | null;
  cwd: string | null;
  keep: boolean;
  apps: boolean;
  saved: boolean;
  parseError: string | null;
  parseErrorCode: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null, positionals: [], conv: null, provider: null, model: null,
    effort: null, legacy: false, systemFile: null, mimeType: null, instance: null,
    repoRoot: null, json: false, full: false, stream: false, idOnly: false,
    timeout: 300_000, wantsHelp: false, version: false, endTiming: false,
    detach: false, foreground: false, notifyParent: null, noNotify: false,
    folderPath: null, autoTitle: false, fastMode: null, newConversationId: null,
    app: null, lifetime: null, base: null, tools: null, cwd: null, keep: false, apps: false, saved: false,
    parseError: null, parseErrorCode: 1,
  };
  const fail = (message: string, code = 1) => {
    result.parseError = message;
    result.parseErrorCode = code;
    return result;
  };
  let modelSpec: string | null = null;
  const seen = new Set<string>();
  const flags: Record<string, keyof ParsedArgs> = {
    "--json": "json", "--full": "full", "--stream": "stream", "--id": "idOnly",
    "--legacy": "legacy", "--end": "endTiming", "--detach": "detach",
    "--background": "detach", "--foreground": "foreground", "--no-notify": "noNotify",
    "--auto-title": "autoTitle", "--help": "wantsHelp", "-h": "wantsHelp",
    "--version": "version", "-v": "version", "--keep": "keep", "--apps": "apps", "--saved": "saved",
  };
  const values: Record<string, keyof ParsedArgs> = {
    "--conv": "conv", "-c": "conv", "--system-file": "systemFile",
    "--mime-type": "mimeType", "--instance": "instance", "--repo-root": "repoRoot",
    "--folder": "folderPath", "--notify-parent": "notifyParent",
    "--new-conversation-id": "newConversationId", "--app": "app", "--cwd": "cwd",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { result.positionals.push(...argv.slice(i + 1)); break; }
    const equal = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equal === -1 ? arg : arg.slice(0, equal);
    if (RETIRED.has(name)) return fail(`${name} is retired: tool selection and conversation-scoped custom modules are no longer supported`);
    if (name === "--system") return fail("--system is not accepted; use --system-file <path>", 2);
    if (Object.hasOwn(flags, name)) {
      if (equal !== -1) return fail(`${name} does not accept a value`);
      (result as any)[flags[name]] = true;
      continue;
    }
    if (["--fast", "--no-fast", "--ultrafast"].includes(name)) {
      if (equal !== -1) return fail(`${name} does not accept a value`);
      if (seen.has("fastMode")) return fail("Choose only one of --fast, --no-fast, or --ultrafast");
      seen.add("fastMode");
      result.fastMode = name === "--ultrafast" ? "ultrafast" : name === "--fast";
      continue;
    }
    if (Object.hasOwn(values, name) || ["--model", "--provider", "--effort", "--timeout", "--lifetime", "--base", "--tools"].includes(name)) {
      const key = values[name] ?? name.slice(2);
      if (seen.has(key)) return fail(`${name} may only be provided once`);
      seen.add(key);
      let value: string;
      if (equal !== -1) value = arg.slice(equal + 1);
      else {
        if (i + 1 >= argv.length || (argv[i + 1].startsWith("-") && argv[i + 1] !== "-")) {
          return fail(`${name} requires a value`);
        }
        value = argv[++i];
      }
      if (!value.trim()) return fail(`${name} requires a non-empty value`);
      if (name === "--model") modelSpec = value;
      else if (name === "--provider") {
        const provider = value.trim().toLowerCase();
        if (!isProviderId(provider)) return fail(`Unknown provider: ${provider}`);
        result.provider = provider;
      } else if (name === "--effort") {
        const effort = value.trim().toLowerCase() as EffortLevel;
        if (!EFFORT_LEVELS.includes(effort)) return fail(`Unknown effort: ${effort}; expected ${EFFORT_LEVELS.join(", ")}`);
        result.effort = effort;
      } else if (name === "--timeout") {
        const milliseconds = Math.round(Number(value) * 1000);
        if (!/^\d+(?:\.\d{1,3})?$/.test(value) || !Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 2_147_483_647) {
          return fail("--timeout must be positive seconds (1 ms to 2147483.647 seconds)");
        }
        result.timeout = milliseconds;
      } else if (name === "--lifetime") {
        if (!(APP_LIFETIMES as readonly string[]).includes(value)) return fail(`Unknown lifetime: ${value}; expected ${APP_LIFETIMES.join(", ")}`);
        result.lifetime = value as ParsedArgs["lifetime"];
      } else if (name === "--base") {
        if (!(APP_SYSTEM_BASES as readonly string[]).includes(value)) return fail(`Unknown system base: ${value}; expected ${APP_SYSTEM_BASES.join(", ")}`);
        result.base = value as ParsedArgs["base"];
      } else if (name === "--tools") {
        const names = value.split(",").map(t => t.trim()).filter(Boolean);
        if (names.length === 1 && names[0] === "all") result.tools = "all";
        else {
          const unknown = names.find(t => !APP_BUILTIN_TOOLS.includes(t));
          if (unknown) return fail(`Unknown tool: ${unknown}; expected a comma list of ${APP_BUILTIN_TOOLS.join(", ")}, or all`);
          if (!names.length) return fail("--tools requires at least one tool name");
          result.tools = names;
        }
      } else (result as any)[values[name]] = value;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return fail(`Unknown flag: ${arg}`);
    result.positionals.push(arg);
  }

  const first = result.positionals[0];
  if (COMMANDS.has(first) || Object.hasOwn(ALIASES, first)) {
    result.subcommand = Object.hasOwn(ALIASES, first) ? ALIASES[first] : first;
    result.positionals.shift();
  }
  if (modelSpec !== null) {
    try {
      const selection = parseModelSpecifier(modelSpec, result.provider);
      result.provider = selection.provider;
      result.model = selection.model;
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }
  if (result.instance && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result.instance)) {
    return fail("--instance must be a worktree name, not a path");
  }
  if (result.newConversationId && !/^\d{13}-[a-z0-9]{6}$/.test(result.newConversationId)) {
    return fail("--new-conversation-id must match <13-digit timestamp>-<6 lowercase letters/digits>");
  }
  if ([result.json, result.stream, result.idOnly].filter(Boolean).length > 1) {
    return fail("Choose only one output mode: --json, --stream, or --id");
  }
  if (result.detach && result.foreground) return fail("--detach and --foreground cannot be combined");
  if (result.notifyParent && result.noNotify) return fail("--notify-parent and --no-notify cannot be combined");
  const command = result.subcommand;
  if (result.conv && (result.folderPath || result.autoTitle || result.newConversationId)) {
    return fail("--folder, --auto-title, and --new-conversation-id are only valid when creating a new conversation");
  }
  if (result.conv && result.provider && !result.model) return fail("--provider requires --model when continuing a conversation");
  if (result.effort && !["send", "llm", "run"].includes(command ?? "")) return fail("--effort is only valid with exo send, llm, or run");
  if (result.legacy && !["send", "queue", "llm"].includes(command ?? "")) return fail("--legacy is only valid with exo send, queue, or llm");
  if (result.fastMode !== null && command !== "send") return fail("--fast/--no-fast/--ultrafast are only valid with exo send");
  if ((result.model || result.provider) && !["send", "llm", "run"].includes(command ?? "")) return fail("--model/--provider are only valid with exo send, llm, or run");
  if ((result.conv || result.detach || result.foreground || result.notifyParent || result.noNotify || result.folderPath || result.autoTitle || result.newConversationId || result.stream || result.idOnly) && command !== "send") {
    return fail("Conversation creation/delivery and --stream/--id options are only valid with exo send");
  }
  if (result.endTiming && command !== "queue") return fail("--end is only valid with exo queue");
  if (result.mimeType && command !== "transcribe") return fail("--mime-type is only valid with exo transcribe");
  if (result.systemFile && command !== "llm" && command !== "run") return fail("--system-file is only valid with exo llm or exo run");
  if ((result.lifetime || result.base || result.tools || result.cwd || result.keep) && command !== "run") {
    return fail("--lifetime, --base, --tools, --cwd, and --keep are only valid with exo run");
  }
  if (result.app && command !== "run" && !(command === "list" && result.apps)) return fail("--app is only valid with exo run or exo list --apps");
  if (result.app && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(result.app)) return fail("--app must be lowercase letters, digits and dashes (at most 40)");
  if ((result.apps && command !== "list") || (result.saved && !(command === "list" && result.apps))) return fail("--apps and --saved are only valid with exo list");
  if (result.keep && result.lifetime === "ephemeral") return fail("--keep keeps the conversation; it cannot be combined with --lifetime ephemeral");
  return result;
}
