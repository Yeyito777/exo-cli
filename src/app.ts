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

/** Declare the connection an app client and check the daemon's app API version; `session` takes that session back. */
export async function declareApp(conn: Connection, app: string, timeout = 5_000, session?: string): Promise<AppWelcomeEvent> {
  const reqId = nextReqId();
  let welcome: AppWelcomeEvent;
  try {
    welcome = await conn.request<AppWelcomeEvent>(
      { type: "client_capabilities", reqId, capabilities: [], app: { name: app, ...(session ? { session } : {}) } },
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

/** A conversation id of our own (`^\d+-[a-z0-9]{6}$`), so the run can be sent again after a reconnect. */
export const newConvId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;

const isDisconnect = (error: unknown) => error instanceof Error
  && /Connection to exocortexd closed|Connection failed|Not connected|Disconnected from exocortexd/.test(error.message);

/** Connect again with backoff and take the session back. */
async function reconnect(conn: Connection, app: string, session: string, deadline: number, delayMs: number): Promise<void> {
  let delay = delayMs;
  for (;;) {
    try {
      await conn.connect(Math.max(1, Math.min(5_000, deadline - Date.now())));
      await declareApp(conn, app, 5_000, session);
      return;
    } catch (error) {
      conn.disconnect();
      if (Date.now() + delay > deadline) {
        throw new Error(`Lost the connection to exocortexd and could not reconnect: ${error instanceof Error ? error.message : String(error)}`);
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
}

/**
 * exo run: one app_run, printing the final text (or the turn_result with --json).
 * A daemon restart or a dropped connection is only a delay: it reconnects under
 * its session and sends the same run again, which the daemon carries on with.
 */
export async function runApp(conn: Connection, prompt: string, opts: RunOptions, deps: { reconnectDelayMs?: number } = {}): Promise<number> {
  const app = opts.app ?? DEFAULT_APP;
  const welcome = await declareApp(conn, app, Math.min(opts.timeout, 5_000));
  const command: AppRunCommand = { ...appRunCommand(prompt, opts, nextReqId()), convId: newConvId(), startedAt: Date.now() };
  const turnId = String(command.startedAt);
  const deadline = Date.now() + opts.timeout;
  let result: TurnResultEvent;
  for (;;) {
    const reqId = command.reqId;
    try {
      result = await conn.request<TurnResultEvent>(
        command,
        (e: Event): e is TurnResultEvent => e.type === "turn_result"
          && (e.reqId === reqId || (!e.reqId && e.convId === command.convId && e.turnId === turnId)),
        Math.max(1, deadline - Date.now()),
      );
      break;
    } catch (error) {
      // A daemon from before sessions would run it twice: only one with sessions gets it again.
      if (!welcome.session || !isDisconnect(error)) throw error;
      await reconnect(conn, app, welcome.session, deadline, deps.reconnectDelayMs ?? 100);
      command.reqId = nextReqId();
    }
  }
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
