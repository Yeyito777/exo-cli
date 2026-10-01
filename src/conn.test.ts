import { describe, expect, test } from "bun:test";
import { Connection } from "./conn";
import { collectResponse } from "./collect";
import { emit, withDaemon } from "./test-utils";
import type { PongEvent, Event } from "./shared/protocol";

describe("socket transport", () => {
  test("preserves Unicode across every byte boundary and multiple JSON lines", () => {
    const bytes = Buffer.from(JSON.stringify({ type: "text_chunk", convId: "test", text: "🐋 café 日本語" }) + "\n");
    for (let split = 1; split < bytes.length; split++) {
      const conn = new Connection();
      const events: Event[] = [];
      conn.onEvent(event => events.push(event));
      (conn as any).onData(bytes.subarray(0, split));
      (conn as any).onData(bytes.subarray(split));
      expect(events).toEqual([{ type: "text_chunk", convId: "test", text: "🐋 café 日本語" }]);
    }
  });

  test("handles fragmented Unicode and matches correlated requests over a real socket", async () => {
    await withDaemon((command, socket) => {
      const bytes = Buffer.from(JSON.stringify({ type: "text_chunk", convId: "test", text: "🐋 café" }) + "\n");
      const split = bytes.indexOf(Buffer.from("🐋")) + 1;
      socket.write(bytes.subarray(0, split));
      setTimeout(() => {
        socket.write(bytes.subarray(split));
        socket.write("not JSON\n");
        emit(socket, { type: "pong", reqId: "unrelated" });
        emit(socket, { type: "pong", reqId: command.reqId });
      }, 10);
    }, async ({ conn }) => {
      const text: string[] = [];
      conn.onEvent(event => { if (event.type === "text_chunk") text.push(event.text); });
      const event = await conn.request<PongEvent>(
        { type: "ping", reqId: "ours" }, (e): e is PongEvent => e.type === "pong" && e.reqId === "ours",
      );
      expect(event.reqId).toBe("ours");
      expect(text).toEqual(["🐋 café"]);
    });
  });

  test("rejects requests and collectors promptly on disconnect", async () => {
    await withDaemon((_command, socket) => socket.end(), async ({ conn }) => {
      const started = Date.now();
      await expect(conn.request(
        { type: "ping", reqId: "close" }, (e): e is PongEvent => e.type === "pong", 30_000,
      )).rejects.toThrow("closed");
      expect(Date.now() - started).toBeLessThan(2000);
      expect((conn as any).listeners).toHaveLength(0);
      expect((conn as any).disconnectListeners.size).toBe(0);
      await conn.connect();
      await expect(collectResponse(conn, "test", "test", 30_000)).rejects.toThrow("closed");
      expect((conn as any).listeners).toHaveLength(0);
    });
  });

  test("send failures and match/callback failures reject and clean up", async () => {
    const disconnected = new Connection();
    await expect(disconnected.request({ type: "ping" }, (e): e is PongEvent => e.type === "pong")).rejects.toThrow("Not connected");
    await expect(collectResponse(disconnected, "test", "test", 30_000)).rejects.toThrow("Not connected");
    expect((disconnected as any).listeners).toHaveLength(0);
    expect((disconnected as any).disconnectListeners.size).toBe(0);
    await withDaemon((command, socket) => emit(socket, { type: "pong", reqId: command.reqId }), async ({ conn }) => {
      await expect(conn.request(
        { type: "ping" }, (_e): _e is PongEvent => { throw new Error("predicate failed"); },
      )).rejects.toThrow("predicate failed");
      expect((conn as any).listeners).toHaveLength(0);
    });
  });

  test("late data/close from a disconnected socket cannot affect a new connection", async () => {
    await withDaemon((command, socket) => emit(socket, { type: "pong", reqId: command.reqId }), async ({ conn }) => {
      const old = (conn as any).socket;
      const events: Event[] = [];
      conn.onEvent(event => events.push(event));
      conn.disconnect();
      await conn.connect();
      old.emit("data", Buffer.from('{"type":"text_chunk","convId":"old","text":"stale"}\n'));
      old.emit("close");
      await conn.request({ type: "ping", reqId: "new" }, (e): e is PongEvent => e.type === "pong" && e.reqId === "new");
      expect(events).toEqual([{ type: "pong", reqId: "new" }]);
    });
  });
});
