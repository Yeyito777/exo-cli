/** App API commands (Exocortex docs/app-api.md): exo run and exo list --apps. */
import type { Connection } from "./conn";
import type {
  AppConversationInfo, AppConversationsListEvent, AppLifetime, AppRunCommand, AppSystemBase,
  AppWelcomeEvent, EffortLevel, Event, ModelId, ProviderId, TurnResultEvent,
} from "./shared/protocol";
import { inferProviderForModel } from "./model-spec";

export const APP_API_VERSION = 1;
export const DEFAULT_APP = "exo-cli";
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash";

let counter = 0;
const nextReqId = () => `app_${++counter}_${Date.now()}`;

/** Declare the connection an app client and check the daemon's app API version. */
export async function declareApp(conn: Connection, app: string, timeout = 5_000): Promise<AppWelcomeEvent> {
  const reqId = nextReqId();
  let welcome: AppWelcomeEvent;
  try {
    welcome = await conn.request<AppWelcomeEvent>(
      { type: "client_capabilities", reqId, capabilities: [], app: { name: app } },
      (e): e is AppWelcomeEvent => e.type === "app_welcome" && e.reqId === reqId,
      timeout,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timeout")) {
      throw new Error(`This Exocortex daemon is too old for the app API (no app_welcome). Update it:\n  ${INSTALL_COMMAND}`);
    }
    throw error;
  }
  if (welcome.appApiVersion !== APP_API_VERSION) {
    throw new Error(`The daemon speaks app API v${welcome.appApiVersion}; this exo CLI speaks v${APP_API_VERSION}. Update ${welcome.appApiVersion > APP_API_VERSION ? "the exo CLI" : "Exocortex"}.`);
  }
  return welcome;
}

export interface RunOptions {
  app: string | null;
  lifetime: AppLifetime | null;
  keep: boolean;
  system: string | null;
  base: AppSystemBase | null;
  tools: string[] | "all" | null;
  cwd: string | null;
  provider: ProviderId | null;
  model: ModelId | null;
  effort: EffortLevel | null;
  json: boolean;
  timeout: number;
}

/** Build the app_run request. `--keep` keeps the conversation: temporary unless a lifetime is given. */
export function appRunCommand(prompt: string, opts: RunOptions, reqId: string): AppRunCommand {
  const provider = opts.provider ?? inferProviderForModel(opts.model) ?? undefined;
  const lifetime = opts.lifetime ?? (opts.keep ? "temporary" : undefined);
  const system = opts.system !== null || opts.base !== null
    ? { ...(opts.system !== null ? { text: opts.system } : {}), ...(opts.base ? { base: opts.base } : {}) }
    : undefined;
  return {
    type: "app_run", reqId, prompt,
    ...(lifetime ? { lifetime } : {}),
    ...(system ? { system } : {}),
    ...(opts.tools ? { tools: { builtin: opts.tools } } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(provider ? { provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
}

/** exo run: one app_run, printing the final text (or the turn_result with --json). */
export async function runApp(conn: Connection, prompt: string, opts: RunOptions): Promise<number> {
  await declareApp(conn, opts.app ?? DEFAULT_APP, Math.min(opts.timeout, 5_000));
  const reqId = nextReqId();
  const command = appRunCommand(prompt, opts, reqId);
  const result = await conn.request<TurnResultEvent>(
    command,
    (e: Event): e is TurnResultEvent => e.type === "turn_result" && e.reqId === reqId,
    opts.timeout,
  );
  const kept = command.lifetime === "saved" || command.lifetime === "temporary";
  if (opts.json) process.stdout.write(JSON.stringify(result) + "\n");
  else {
    if (result.text) process.stdout.write(result.text.endsWith("\n") ? result.text : result.text + "\n");
    if (kept) process.stderr.write(`exo: conversation ${result.convId} (${command.lifetime})\n`);
  }
  if (result.stopReason === "end_turn") return 0;
  if (!opts.json) process.stderr.write(result.stopReason === "error" ? `Error: ${result.error ?? "the turn failed"}\n` : "exo: the turn was aborted\n");
  return 1;
}

/** exo list --apps: live hidden app conversations (and saved ones with --saved). */
export async function listApps(conn: Connection, opts: { app: string | null; saved: boolean; json: boolean; timeout: number }): Promise<number> {
  await declareApp(conn, DEFAULT_APP, Math.min(opts.timeout, 5_000));
  const reqId = nextReqId();
  const event = await conn.request<AppConversationsListEvent>(
    { type: "list_app_conversations", reqId, ...(opts.app ? { app: opts.app } : {}), ...(opts.saved ? { includeSaved: true } : {}) },
    (e): e is AppConversationsListEvent => e.type === "app_conversations_list" && e.reqId === reqId,
    opts.timeout,
  );
  if (opts.json) {
    process.stdout.write(JSON.stringify(event.conversations) + "\n");
    return 0;
  }
  if (!event.conversations.length) {
    process.stdout.write(opts.saved ? "No app conversations.\n" : "No live hidden app conversations (--saved adds saved ones).\n");
    return 0;
  }
  for (const c of event.conversations) process.stdout.write(formatAppConversation(c) + "\n");
  return 0;
}

export function formatAppConversation(c: AppConversationInfo): string {
  const state = c.streaming ? "running" : "idle";
  const owner = c.ownerConnected ? "owned" : "no owner";
  const expires = c.expiresAt ? `  expires ${new Date(c.expiresAt).toLocaleString()}` : "";
  return `${c.convId}  ${c.app}  ${c.lifetime}  ${c.model}  ${state}, ${owner}  ${c.title || "(untitled)"}${expires}`;
}
