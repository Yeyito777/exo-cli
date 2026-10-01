/**
 * Event collector for the send command.
 *
 * Subscribes to a conversation, sends a message, and collects
 * all events until streaming_stopped. Handles the full agentic
 * loop (multiple API turns with tool calls).
 */

import type { Connection } from "./conn";
import type { Event, Block, SendMessageCommand, StreamingStopReason } from "./shared/protocol";

export interface CollectedResponse {
  convId: string;
  /** All blocks from all agentic turns, in order. */
  blocks: Block[];
  /** Total output tokens across all turns. */
  tokens: number;
  /** Wall-clock duration in seconds. */
  duration: number;
  status: "completed" | "interrupted" | "suspended";
  stopReason?: StreamingStopReason | "aborted";
}

export type StreamCallback = (event: Event) => void;

/**
 * Send a message and collect the full response.
 *
 * Assumes the connection is already established and the client
 * is subscribed to the conversation.
 */
export function collectResponse(
  conn: Connection,
  convId: string,
  text: string,
  timeoutMs: number,
  onStream?: StreamCallback,
  delegation?: Pick<SendMessageCommand, "delegation" | "legacy">,
): Promise<CollectedResponse> {
  return new Promise((resolve, reject) => {
    const blocks: Block[] = [];
    let tokens = 0;
    const startedAt = Date.now();
    const reqId = `send_${startedAt}_${Math.random().toString(36).slice(2)}`;
    let active = false;
    let handoff = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for response"));
    }, timeoutMs);

    // Stderr hint if the response is taking a while. Useful for humans
    // watching; harmless for scripts (goes to stderr, not stdout).
    const waitHint = setTimeout(() => {
      process.stderr.write("waiting for response…\n");
    }, 5_000);

    const handleEvent = (event: Event) => {
      // A request-correlated error can be global (no convId).
      if (event.type === "error" && event.reqId === reqId) {
        onStream?.(event);
        cleanup();
        reject(new Error(event.message));
        return;
      }
      // Only care about events for our conversation
      if (!("convId" in event) || event.convId !== convId) return;
      if (event.type === "error" && event.reqId && event.reqId !== reqId) return;
      if (event.type === "streaming_started") {
        if (!handoff && event.startedAt !== startedAt) return;
        active = true;
        handoff = false;
      }
      // Subscribe may replay the previous stream's snapshot/stop before this
      // send is dispatched. Don't confuse that with completion of our request.
      if (event.type !== "error" && !active) return;

      onStream?.(event);

      switch (event.type) {
        case "message_complete":
          // Each agentic turn produces a message_complete with its blocks.
          blocks.push(...event.blocks);
          tokens += event.tokens;
          break;

        case "streaming_stopped":
          // Queued/goal successor turns are part of the same foreground chain.
          if (event.reason === "handoff") { active = false; handoff = true; return; }
          if (event.persistedBlocks !== undefined) blocks.push(...event.persistedBlocks);
          cleanup();
          resolve({
            convId,
            blocks,
            tokens,
            duration: (Date.now() - startedAt) / 1000,
            status: event.reason === "suspended" ? "suspended"
              : event.reason || event.persistedBlocks !== undefined ? "interrupted" : "completed",
            stopReason: event.reason ?? (event.persistedBlocks !== undefined ? "aborted" : undefined),
          });
          break;

        case "error":
          cleanup();
          reject(new Error(event.message));
          break;
      }
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const handler = (event: Event) => {
      try { handleEvent(event); } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(waitHint);
      conn.offEvent(handler);
      conn.offDisconnect(fail);
    };

    conn.onEvent(handler);
    conn.onDisconnect(fail);
    try { conn.send({
      type: "send_message",
      reqId,
      ...delegation,
      convId,
      text,
      startedAt,
    }); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}
