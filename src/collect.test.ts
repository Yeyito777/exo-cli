import { describe, expect, test } from "bun:test";
import { collectResponse } from "./collect";
import type { Connection } from "./conn";
import type { Command, Event, SendMessageCommand } from "./shared/protocol";

function stream(run: (command: SendMessageCommand, emit: (event: Event) => void) => void) {
  const events = new Set<(event: Event) => void>();
  const losses = new Set<(error: Error) => void>();
  const conn = {
    onEvent: (handler: (event: Event) => void) => events.add(handler),
    offEvent: (handler: (event: Event) => void) => events.delete(handler),
    onDisconnect: (handler: (error: Error) => void) => losses.add(handler),
    offDisconnect: (handler: (error: Error) => void) => losses.delete(handler),
    send: (command: Command) => {
      if (command.type === "send_message") run(command, event => {
        for (const handler of [...events]) handler(event);
      });
    },
  } as unknown as Connection;
  return { conn, events, losses };
}

describe("foreground collection", () => {
  test("ignores a previous subscription snapshot/stop and unrelated errors", async () => {
    const { conn, events, losses } = stream((command, emit) => {
      emit({ type: "streaming_started", convId: "child", model: "test", startedAt: command.startedAt - 10 });
      emit({ type: "message_complete", convId: "child", blocks: [{ type: "text", text: "stale" }], tokens: 99, endedAt: 1 });
      emit({ type: "streaming_stopped", convId: "child" });
      emit({ type: "error", convId: "child", reqId: "another-request", message: "unrelated" });
      emit({ type: "streaming_started", convId: "child", model: "test", startedAt: command.startedAt });
      emit({ type: "message_complete", convId: "child", blocks: [{ type: "text", text: "ours" }], tokens: 1, endedAt: 1 });
      emit({ type: "streaming_stopped", convId: "child" });
    });
    expect(await collectResponse(conn, "child", "test", 1000)).toMatchObject({
      status: "completed", tokens: 1, blocks: [{ type: "text", text: "ours" }],
    });
    expect(events.size).toBe(0);
    expect(losses.size).toBe(0);
  });

  test("accepts globally correlated errors without convId", async () => {
    const { conn, events, losses } = stream((command, emit) =>
      emit({ type: "error", reqId: command.reqId, message: "dispatch rejected" }));
    await expect(collectResponse(conn, "child", "test", 1000)).rejects.toThrow("dispatch rejected");
    expect(events.size + losses.size).toBe(0);
  });

  test("callback failures clean up rather than becoming malformed JSON/timeouts", async () => {
    const { conn, events, losses } = stream((command, emit) =>
      emit({ type: "streaming_started", convId: "child", model: "test", startedAt: command.startedAt }));
    await expect(collectResponse(conn, "child", "test", 1000, () => {
      throw new Error("output failed");
    })).rejects.toThrow("output failed");
    expect(events.size + losses.size).toBe(0);
  });

  test("timeout removes all listeners without aborting daemon work", async () => {
    const { conn, events, losses } = stream(() => {});
    await expect(collectResponse(conn, "child", "test", 5)).rejects.toThrow("Timeout");
    expect(events.size + losses.size).toBe(0);
  });
});
