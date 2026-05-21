/**
 * CLI commands — each is a single function that takes a connection
 * and options, does its work, and returns an exit code.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Connection } from "./conn";
import type {
  ProviderId,
  ModelId,
  QueueTiming,
  Event,
  PongEvent,
  ConversationCreatedEvent,
  ConversationsListEvent,
  ConversationLoadedEvent,
  AckEvent,
  ConversationDeletedEvent,
  ConversationUpdatedEvent,
  LlmCompleteResultEvent,
  TranscriptionResultEvent,
  ConversationSummary,
  FolderSummary,
  SidebarItemRef,
} from "./shared/protocol";
import { inferProviderForModel } from "./model-spec";
import { collectResponse, type StreamCallback } from "./collect";
import { formatResponseAsJson, formatEntriesAsText, formatEntriesAsJson } from "./format";

export interface OutputOptions {
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
  detached?: boolean;
  notifyParent?: string | null;
  subagentFolder?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

let reqCounter = 0;
function nextReqId(): string {
  return `cli_${++reqCounter}_${Date.now()}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Auto-generate a conversation title from the first message. */
function autoTitle(text: string): string {
  // Take the first line, collapse whitespace, truncate. Prefixed so
  // CLI-originated conversations are easy to distinguish from human ones.
  const firstLine = text.split("\n")[0].trim();
  return "cli: " + truncate(firstLine, 75);
}

async function fetchSidebarState(conn: Connection): Promise<{ conversations: ConversationSummary[]; folders: FolderSummary[] }> {
  const reqId = nextReqId();
  const event = await conn.request<ConversationsListEvent>(
    { type: "list_conversations", reqId },
    (e): e is ConversationsListEvent => e.type === "conversations_list" && e.reqId === reqId,
  );
  return { conversations: event.conversations, folders: event.folders ?? [] };
}

interface SidebarStateSnapshot {
  conversations: ConversationSummary[];
  folders: FolderSummary[];
}

type FolderPathResolution =
  | { kind: "root"; folderId: null; path: "/" }
  | { kind: "folder"; folder: FolderSummary; folderId: string; path: string };

function normalizeFolderPath(input: string | null | undefined): string {
  const trimmed = (input ?? "/").trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function folderPath(folders: FolderSummary[], folderId: string | null | undefined): string {
  if (!folderId) return "/";
  const names: string[] = [];
  const seen = new Set<string>();
  let folder = folders.find((f) => f.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    names.unshift(folder.name);
    folder = folder.parentId ? folders.find((f) => f.id === folder?.parentId) : undefined;
  }
  return names.length ? names.join("/") : "/";
}

function resolveFolderPath(state: SidebarStateSnapshot, input: string | null | undefined): FolderPathResolution | null {
  const normalized = normalizeFolderPath(input);
  if (normalized === "/") return { kind: "root", folderId: null, path: "/" };
  const byPath = state.folders.find((f) => folderPath(state.folders, f.id).toLowerCase() === normalized.toLowerCase());
  if (byPath) return { kind: "folder", folder: byPath, folderId: byPath.id, path: folderPath(state.folders, byPath.id) };
  return null;
}

function directChildFolders(state: SidebarStateSnapshot, parentId: string | null): FolderSummary[] {
  return state.folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function directChildConversations(state: SidebarStateSnapshot, parentId: string | null): ConversationSummary[] {
  return state.conversations
    .filter((conversation) => (conversation.folderId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.title || "").localeCompare(b.title || ""));
}

function childItemCount(state: SidebarStateSnapshot, parentId: string | null): number {
  return directChildFolders(state, parentId).length + directChildConversations(state, parentId).length;
}

function jobStatus(c: ConversationSummary): "running" | "done" | null {
  if (c.streaming) return "running";
  if (c.unread) return "done";
  return null;
}

function conversationStatusLabel(c: ConversationSummary): string {
  return jobStatus(c) ?? "idle";
}

function sidebarItemParent(state: SidebarStateSnapshot, item: SidebarItemRef): string | null | undefined {
  if (item.type === "conversation") return state.conversations.find((c) => c.id === item.id)?.folderId ?? null;
  return state.folders.find((f) => f.id === item.id)?.parentId ?? null;
}

function descendantsOfFolder(state: SidebarStateSnapshot, folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of state.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

function resolveSidebarItem(state: SidebarStateSnapshot, input: string): SidebarItemRef {
  const conversation = state.conversations.find((c) => c.id === input);
  if (conversation) return { type: "conversation", id: conversation.id };
  const folder = resolveFolderPath(state, input);
  if (folder?.kind === "folder") return { type: "folder", id: folder.folderId };
  throw new Error(`No conversation ID or folder path found for ${JSON.stringify(input)}`);
}

function resolveMoveDestination(state: SidebarStateSnapshot, items: SidebarItemRef[], input: string): FolderPathResolution {
  const raw = input.trim();
  if (raw === "..") {
    const parents = new Set(items.map((item) => sidebarItemParent(state, item)));
    if (parents.has(undefined)) throw new Error("Cannot resolve parent for one or more source items");
    if (parents.size !== 1) throw new Error("'..' requires all source items to currently be in the same folder");
    const currentParent = [...parents][0] ?? null;
    if (!currentParent) return { kind: "root", folderId: null, path: "/" };
    const folder = state.folders.find((f) => f.id === currentParent);
    if (!folder?.parentId) return { kind: "root", folderId: null, path: "/" };
    const parent = state.folders.find((f) => f.id === folder.parentId);
    if (!parent) return { kind: "root", folderId: null, path: "/" };
    return { kind: "folder", folder: parent, folderId: parent.id, path: folderPath(state.folders, parent.id) };
  }

  const destination = resolveFolderPath(state, raw);
  if (!destination) throw new Error(`Folder not found: ${input}`);
  for (const item of items) {
    if (item.type === "folder" && destination.folderId && descendantsOfFolder(state, item.id).has(destination.folderId)) {
      throw new Error("Cannot move a folder into itself or one of its descendants");
    }
  }
  return destination;
}

function flattenFolderTree(state: SidebarStateSnapshot, parentId: string | null, depth = 0): Array<{ depth: number; type: "folder" | "conversation"; id: string; name: string; path: string; status?: string; children?: number }> {
  const rows: Array<{ depth: number; type: "folder" | "conversation"; id: string; name: string; path: string; status?: string; children?: number }> = [];
  for (const folder of directChildFolders(state, parentId)) {
    rows.push({ depth, type: "folder", id: folder.id, name: folder.name, path: folderPath(state.folders, folder.id), children: childItemCount(state, folder.id) });
    rows.push(...flattenFolderTree(state, folder.id, depth + 1));
  }
  for (const conversation of directChildConversations(state, parentId)) {
    rows.push({ depth, type: "conversation", id: conversation.id, name: conversation.title || "(untitled)", path: folderPath(state.folders, conversation.folderId ?? null), status: conversationStatusLabel(conversation) });
  }
  return rows;
}

// ── send ────────────────────────────────────────────────────────────

/**
 * Build a StreamCallback that writes human-readable text to stdout
 * as events arrive — live streaming for the default text mode.
 *
 * Handles text chunks, tool call summaries, and (with --full)
 * thinking chunks and tool result output.
 */
function makeLiveStreamCallback(targetConvId: string, full: boolean): StreamCallback {
  // Track cursor position so we insert exactly the right separators —
  // matching what formatBlocksAsText() produces with parts.join("\n").
  let wroteAnything = false;
  let atLineStart = true;

  return (event: Event) => {
    if (!("convId" in event) || event.convId !== targetConvId) return;

    switch (event.type) {
      case "block_start":
        if (event.blockType === "text") {
          // Separate from whatever came before (thinking, tool output, etc.)
          if (wroteAnything && !atLineStart) process.stdout.write("\n");
        } else if (event.blockType === "thinking" && full) {
          // Match buffered format: `  💭 ` prefix for the thinking block
          process.stdout.write("  💭 ");
          atLineStart = false;
        }
        break;

      case "text_chunk":
        process.stdout.write(event.text);
        wroteAnything = true;
        atLineStart = event.text.endsWith("\n");
        break;

      case "thinking_chunk":
        if (full) {
          process.stdout.write(event.text);
          wroteAnything = true;
          atLineStart = event.text.endsWith("\n");
        }
        break;

      case "tool_call":
        // Terminate the current line if mid-line, then print summary
        if (!atLineStart) process.stdout.write("\n");
        process.stdout.write(`  ╸ ${event.summary}\n`);
        wroteAnything = true;
        atLineStart = true;
        break;

      case "tool_result":
        if (full) {
          const prefix = event.isError ? "  ✗ " : "  ┃ ";
          const indented = event.output
            .split("\n")
            .map((l: string) => prefix + l)
            .join("\n");
          process.stdout.write(indented + "\n");
          atLineStart = true;
        }
        break;
    }
  };
}

export async function send(
  conn: Connection,
  text: string,
  convId: string | null,
  provider: ProviderId | null,
  model: ModelId | null,
  opts: OutputOptions,
): Promise<number> {
  const resolvedProvider = provider ?? inferProviderForModel(model);

  // Create conversation if needed
  if (!convId) {
    const reqId = nextReqId();
    const title = autoTitle(text);
    const created = await conn.request<ConversationCreatedEvent>(
      {
        type: "new_conversation",
        reqId,
        provider: resolvedProvider ?? undefined,
        model: model ?? undefined,
        title,
        subagent: opts.subagentFolder === true,
      },
      (e): e is ConversationCreatedEvent => e.type === "conversation_created" && e.reqId === reqId,
    );
    convId = created.convId;
  } else if (model) {
    // Switch model on existing conversation
    conn.send({ type: "set_model", convId, provider: resolvedProvider ?? undefined, model });
  }

  if (opts.detached) {
    const reqId = nextReqId();
    const notifyParent = opts.notifyParent
      ? { convId: opts.notifyParent }
      : undefined;
    await conn.request<AckEvent>(
      {
        type: "send_message",
        reqId,
        convId,
        text,
        startedAt: Date.now(),
        detached: true,
        notifyParent,
      },
      (e): e is AckEvent => e.type === "ack" && e.reqId === reqId,
    );
    if (opts.idOnly) {
      process.stdout.write(convId + "\n");
    } else if (opts.json) {
      process.stdout.write(JSON.stringify({ convId, detached: true, notifyParent: notifyParent?.convId ?? null }) + "\n");
    } else {
      const notifyText = notifyParent
        ? ` Parent will be notified when it completes.`
        : ` No parent notification configured.`;
      process.stdout.write(`Started detached subagent exo:${convId}.${notifyText}\n`);
    }
    return 0;
  }

  // Subscribe to get streaming events
  conn.send({ type: "subscribe", convId });

  // Decide which stream callback to use:
  //  - --stream:              raw NDJSON events
  //  - --json / --id:         no streaming (buffer for structured output)
  //  - default text mode:     live human-readable streaming
  const liveText = !opts.json && !opts.stream && !opts.idOnly;
  const onStream: StreamCallback | undefined = opts.stream
    ? (event) => {
        if ("convId" in event && event.convId === convId) {
          process.stdout.write(JSON.stringify(event) + "\n");
        }
      }
    : liveText
      ? makeLiveStreamCallback(convId, opts.full)
      : undefined;

  let response: Awaited<ReturnType<typeof collectResponse>>;
  try {
    response = await collectResponse(conn, convId, text, opts.timeout, onStream);
  } catch (err: any) {
    // If the conversation is actively streaming, auto-queue for next turn
    if (convId && err?.message?.includes("Already streaming")) {
      const reqId = nextReqId();
      await conn.request<AckEvent>(
        { type: "queue_message", reqId, convId, text, timing: "next-turn" },
        (e): e is AckEvent => e.type === "ack" && e.reqId === reqId,
      );
      process.stdout.write("Conversation is busy — message queued for next turn.\n");
      return 0;
    }
    throw err;
  }

  // Unsubscribe — symmetric with the subscribe above. Not strictly required
  // since disconnect() closes the socket, but keeps the protocol clean.
  // Wrapped in try/catch because the socket may have closed during a long response.
  try { conn.send({ type: "unsubscribe", convId }); } catch {};

  // Format output
  if (opts.idOnly) {
    process.stdout.write(response.convId + "\n");
  } else if (opts.json) {
    process.stdout.write(formatResponseAsJson(response) + "\n");
  } else {
    // In both live-text and --stream modes the content was already
    // written incrementally; just append the conversation ID footer.
    process.stdout.write(`\nexo:${response.convId}\n`);
  }

  return 0;
}

// ── list ────────────────────────────────────────────────────────────

export async function list(conn: Connection, opts: OutputOptions): Promise<number> {
  const event = await fetchSidebarState(conn);

  if (opts.json) {
    process.stdout.write(JSON.stringify(event.conversations) + "\n");
  } else {
    if (event.conversations.length === 0) {
      process.stdout.write("No conversations.\n");
    } else {
      for (const c of event.conversations) {
        const prefix = c.pinned ? "📌" : c.marked ? "★ " : "  ";
        const streaming = c.streaming ? " ⟳" : "";
        const title = c.title || "(untitled)";
        const date = new Date(c.updatedAt).toLocaleString();
        process.stdout.write(
          `${prefix}${c.id}  ${c.model}  ${c.messageCount} msgs  ${title}  ${date}${streaming}\n`
        );
      }
    }
  }

  return 0;
}

// ── jobs ─────────────────────────────────────────────────────────────

export async function jobs(conn: Connection, opts: OutputOptions): Promise<number> {
  const { conversations } = await fetchSidebarState(conn);
  const activeJobs = conversations
    .map((conversation) => ({ conversation, status: jobStatus(conversation) }))
    .filter((entry): entry is { conversation: ConversationSummary; status: "running" | "done" } => entry.status !== null);

  if (opts.json) {
    process.stdout.write(JSON.stringify(activeJobs.map(({ conversation, status }) => ({
      id: conversation.id,
      title: conversation.title || "",
      status,
      running: status === "running",
      done: status === "done",
      streaming: conversation.streaming,
      completed: conversation.unread && !conversation.streaming,
    }))) + "\n");
    return 0;
  }

  if (activeJobs.length === 0) {
    process.stdout.write("No jobs.\n");
    return 0;
  }

  for (const { conversation, status } of activeJobs) {
    process.stdout.write(`${conversation.id}  ${status}  ${conversation.title || "(untitled)"}\n`);
  }
  return 0;
}

// ── folder management ────────────────────────────────────────────

export async function folderList(conn: Connection, path: string | null, opts: OutputOptions): Promise<number> {
  const state = await fetchSidebarState(conn);
  const target = resolveFolderPath(state, path);
  if (!target) throw new Error(`Folder not found: ${path ?? "/"}`);
  const folders = directChildFolders(state, target.folderId);
  const conversations = directChildConversations(state, target.folderId);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      path: target.path,
      folderId: target.folderId,
      folders: folders.map((folder) => ({ id: folder.id, name: folder.name, path: folderPath(state.folders, folder.id), children: childItemCount(state, folder.id) })),
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title || "",
        status: conversationStatusLabel(conversation),
        streaming: conversation.streaming,
        completed: conversation.unread && !conversation.streaming,
      })),
    }) + "\n");
    return 0;
  }

  process.stdout.write(`${target.path}\n`);
  if (folders.length === 0 && conversations.length === 0) {
    process.stdout.write("  (empty)\n");
    return 0;
  }
  for (const folder of folders) {
    process.stdout.write(`  ${folder.name}/\n`);
  }
  for (const conversation of conversations) {
    process.stdout.write(`  ${conversation.id}  ${conversationStatusLabel(conversation)}  ${conversation.title || "(untitled)"}\n`);
  }
  return 0;
}

export async function folderTree(conn: Connection, path: string | null, opts: OutputOptions): Promise<number> {
  const state = await fetchSidebarState(conn);
  const target = resolveFolderPath(state, path);
  if (!target) throw new Error(`Folder not found: ${path ?? "/"}`);
  const rows = flattenFolderTree(state, target.folderId);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ path: target.path, folderId: target.folderId, entries: rows }) + "\n");
    return 0;
  }

  process.stdout.write(`${target.path}\n`);
  if (rows.length === 0) {
    process.stdout.write("  (empty)\n");
    return 0;
  }
  for (const row of rows) {
    const indent = "  ".repeat(row.depth + 1);
    if (row.type === "folder") {
      process.stdout.write(`${indent}${row.name}/\n`);
    } else {
      process.stdout.write(`${indent}${row.id}  ${row.status}  ${row.name}\n`);
    }
  }
  return 0;
}

async function createFolderAndRefresh(conn: Connection, name: string, parentId: string | null): Promise<SidebarStateSnapshot> {
  const reqId = nextReqId();
  await conn.request<AckEvent>(
    { type: "create_folder", reqId, name, parentId, items: [] },
    (e): e is AckEvent => e.type === "ack" && e.reqId === reqId,
  );
  return await fetchSidebarState(conn);
}

export async function folderMkdir(conn: Connection, path: string, opts: OutputOptions): Promise<number> {
  const normalized = normalizeFolderPath(path);
  if (normalized === "/") throw new Error("Cannot create root folder");
  const parts = normalized.split("/").filter(Boolean);
  let state = await fetchSidebarState(conn);
  let parentId: string | null = null;
  let currentPath = "";
  const created: Array<{ name: string; path: string; parentId: string | null }> = [];

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = state.folders.find((folder) => (folder.parentId ?? null) === parentId && folder.name.toLowerCase() === part.toLowerCase());
    if (existing) {
      parentId = existing.id;
      continue;
    }
    state = await createFolderAndRefresh(conn, part, parentId);
    const made = state.folders.find((folder) => (folder.parentId ?? null) === parentId && folder.name.toLowerCase() === part.toLowerCase());
    if (!made) throw new Error(`Folder was created but could not be found again: ${currentPath}`);
    created.push({ name: part, path: currentPath, parentId });
    parentId = made.id;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ path: normalized, created }) + "\n");
  } else if (created.length === 0) {
    process.stdout.write(`Folder already exists: ${normalized}\n`);
  } else {
    process.stdout.write(`Created ${created.map((folder) => folder.path).join(", ")}\n`);
  }
  return 0;
}

export async function folderMove(conn: Connection, sources: string[], destinationInput: string, opts: OutputOptions): Promise<number> {
  const state = await fetchSidebarState(conn);
  const items = sources.map((source) => resolveSidebarItem(state, source));
  const seen = new Set<string>();
  const uniqueItems = items.filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueItems.length === 0) throw new Error("folder mv requires at least one source");
  const destination = resolveMoveDestination(state, uniqueItems, destinationInput);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for folder move"));
    }, opts.timeout);
    const handler = (event: Event) => {
      if (event.type !== "conversation_moved") return;
      const folders = event.folders ?? state.folders;
      const allMoved = uniqueItems.every((item) => {
        if (item.type === "conversation") {
          const conversation = event.conversations.find((c) => c.id === item.id);
          return conversation && (conversation.folderId ?? null) === destination.folderId;
        }
        const folder = folders.find((f) => f.id === item.id);
        return folder && (folder.parentId ?? null) === destination.folderId;
      });
      if (!allMoved) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      conn.offEvent(handler);
    };
    conn.onEvent(handler);
    conn.send({ type: "move_sidebar_items", items: uniqueItems, parentId: destination.folderId });
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ items: uniqueItems, folderId: destination.folderId, folder: destination.path }) + "\n");
  } else {
    process.stdout.write(`Moved ${uniqueItems.length} item(s) to ${destination.path}\n`);
  }
  return 0;
}

export async function folderRemove(conn: Connection, path: string, opts: OutputOptions): Promise<number> {
  const state = await fetchSidebarState(conn);
  const target = resolveFolderPath(state, path);
  if (!target || target.kind !== "folder") throw new Error(`Folder not found: ${path}`);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for folder removal"));
    }, opts.timeout);
    const handler = (event: Event) => {
      if (event.type !== "conversation_moved") return;
      const folders = event.folders ?? [];
      if (folders.some((folder) => folder.id === target.folderId)) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      conn.offEvent(handler);
    };
    conn.onEvent(handler);
    conn.send({ type: "delete_folder", folderId: target.folderId, mode: "recursive" });
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ removed: target.path, folderId: target.folderId }) + "\n");
  } else {
    process.stdout.write(`Removed ${target.path}/\n`);
  }
  return 0;
}

// ── info ────────────────────────────────────────────────────────────

export async function info(conn: Connection, convId: string, opts: OutputOptions): Promise<number> {
  // Fetch both the summary (title, pinned, marked) and the loaded conversation
  // (context tokens). Safe to fire in parallel: request() filters by reqId so
  // responses won't cross-match even though they share the same connection.
  const listReqId = nextReqId();
  const loadReqId = nextReqId();

  const [listEvent, loadEvent] = await Promise.all([
    conn.request<ConversationsListEvent>(
      { type: "list_conversations", reqId: listReqId },
      (e): e is ConversationsListEvent => e.type === "conversations_list" && e.reqId === listReqId,
    ),
    conn.request<ConversationLoadedEvent>(
      { type: "load_conversation", reqId: loadReqId, convId },
      (e): e is ConversationLoadedEvent => e.type === "conversation_loaded" && e.reqId === loadReqId,
    ),
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
      queuedMessages: loadEvent.queuedMessages ?? [],
    }) + "\n");
  } else {
    const title = summary?.title || "(untitled)";
    process.stdout.write(`Conversation: ${loadEvent.convId}\n`);
    process.stdout.write(`Title:        ${title}\n`);
    process.stdout.write(`Model:        ${loadEvent.model}\n`);
    process.stdout.write(`Messages:     ${loadEvent.entries.length}\n`);
    process.stdout.write(`Context:      ${loadEvent.contextTokens ?? "unknown"} tokens\n`);
    if (summary?.pinned) process.stdout.write(`Pinned:       yes\n`);
    if (summary?.marked) process.stdout.write(`Marked:       yes\n`);
    if (summary?.streaming) process.stdout.write(`Streaming:    yes\n`);
    if (loadEvent.queuedMessages?.length) {
      process.stdout.write(`Queued:       ${loadEvent.queuedMessages.length} message(s)\n`);
    }
  }

  return 0;
}

// ── history ─────────────────────────────────────────────────────────

export async function history(conn: Connection, convId: string, opts: OutputOptions): Promise<number> {
  const reqId = nextReqId();
  const event = await conn.request<ConversationLoadedEvent>(
    { type: "load_conversation", reqId, convId },
    (e): e is ConversationLoadedEvent => e.type === "conversation_loaded" && e.reqId === reqId,
  );

  if (opts.json) {
    process.stdout.write(formatEntriesAsJson(event.entries) + "\n");
  } else {
    const output = formatEntriesAsText(event.entries, opts.full);
    if (output) process.stdout.write(output + "\n");
  }

  return 0;
}

// ── delete ──────────────────────────────────────────────────────────

export async function deleteConversation(conn: Connection, convId: string): Promise<number> {
  const reqId = nextReqId();
  await conn.request<ConversationDeletedEvent>(
    { type: "delete_conversation", reqId, convId },
    (e): e is ConversationDeletedEvent => e.type === "conversation_deleted" && e.convId === convId,
  );
  process.stdout.write(`Deleted ${convId}\n`);
  return 0;
}

// ── abort ───────────────────────────────────────────────────────────

export async function abort(conn: Connection, convId: string): Promise<number> {
  const reqId = nextReqId();
  await conn.request<AckEvent>(
    { type: "abort", reqId, convId },
    (e): e is AckEvent => e.type === "ack" && e.reqId === reqId,
  );
  process.stdout.write("Aborted.\n");
  return 0;
}

// ── queue ──────────────────────────────────────────────────────────

export async function queue(conn: Connection, convId: string, text: string, timing: QueueTiming): Promise<number> {
  const reqId = nextReqId();
  await conn.request<AckEvent>(
    { type: "queue_message", reqId, convId, text, timing },
    (e): e is AckEvent => e.type === "ack" && e.reqId === reqId,
  );
  process.stdout.write(`Queued (${timing}) for ${convId}\n`);
  return 0;
}

// ── rename ──────────────────────────────────────────────────────────

export async function rename(conn: Connection, convId: string, title: string): Promise<number> {
  const reqId = nextReqId();
  await conn.request<ConversationUpdatedEvent>(
    { type: "rename_conversation", reqId, convId, title },
    (e): e is ConversationUpdatedEvent => e.type === "conversation_updated" && e.summary.id === convId,
  );
  process.stdout.write(`Renamed ${convId}\n`);
  return 0;
}

// ── transcribe ──────────────────────────────────────────────────────

function inferAudioMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".mp4": return "audio/mp4";
    case ".ogg": return "audio/ogg";
    case ".opus": return "audio/ogg; codecs=opus";
    case ".webm": return "audio/webm";
    case ".flac": return "audio/flac";
    default: return "audio/wav";
  }
}

export async function transcribeAudio(conn: Connection, path: string, mimeType: string | null, opts: OutputOptions): Promise<number> {
  const reqId = nextReqId();
  const audioBytes = await readFile(path);
  const resolvedMimeType = mimeType ?? inferAudioMimeType(path);
  const event = await conn.request<TranscriptionResultEvent>(
    {
      type: "transcribe_audio",
      reqId,
      audioBase64: audioBytes.toString("base64"),
      mimeType: resolvedMimeType,
    },
    (e): e is TranscriptionResultEvent => e.type === "transcription_result" && e.reqId === reqId,
    opts.timeout,
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify({ text: event.text, mimeType: resolvedMimeType }) + "\n");
  } else {
    process.stdout.write(event.text + "\n");
  }

  return 0;
}

// ── llm ─────────────────────────────────────────────────────────────

export async function llm(
  conn: Connection,
  userText: string,
  system: string,
  provider: ProviderId | null,
  model: ModelId | null,
  opts: OutputOptions,
): Promise<number> {
  const reqId = nextReqId();
  const resolvedProvider = provider ?? inferProviderForModel(model);
  const event = await conn.request<LlmCompleteResultEvent>(
    { type: "llm_complete", reqId, provider: resolvedProvider ?? undefined, system, userText, model: model ?? undefined },
    (e): e is LlmCompleteResultEvent => e.type === "llm_complete_result" && e.reqId === reqId,
    opts.timeout,
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify({ text: event.text }) + "\n");
  } else {
    process.stdout.write(event.text + "\n");
  }

  return 0;
}

// ── status ─────────────────────────────────────────────────────────

export async function status(conn: Connection, opts: OutputOptions): Promise<number> {
  const reqId = nextReqId();
  const startedAt = Date.now();

  await conn.request<PongEvent>(
    { type: "ping", reqId },
    (e): e is PongEvent => e.type === "pong" && e.reqId === reqId,
    5_000,
  );

  const latencyMs = Date.now() - startedAt;

  // Also fetch conversation count for a useful summary
  const listReqId = nextReqId();
  const listEvent = await conn.request<ConversationsListEvent>(
    { type: "list_conversations", reqId: listReqId },
    (e): e is ConversationsListEvent => e.type === "conversations_list" && e.reqId === listReqId,
  );

  const convCount = listEvent.conversations.length;
  const streaming = listEvent.conversations.filter((c) => c.streaming).length;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: "ok",
      latencyMs,
      conversations: convCount,
      streaming,
    }) + "\n");
  } else {
    process.stdout.write(`Daemon:        online (${latencyMs}ms)\n`);
    process.stdout.write(`Conversations: ${convCount}\n`);
    if (streaming > 0) {
      process.stdout.write(`Streaming:     ${streaming} active\n`);
    }
  }

  return 0;
}
