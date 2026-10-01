import { describe, expect, test } from "bun:test";
import { llm, queue, send, type OutputOptions } from "./commands";
import { collectResponse } from "./collect";
import type { Connection } from "./conn";
import type { Command, Event } from "./shared/protocol";

const options: OutputOptions = { json: true, full: false, stream: false, idOnly: false, timeout: 1000, detached: true };

async function withoutOutput(run: () => Promise<unknown>) {
  const original = process.stdout.write;
  process.stdout.write = (() => true) as typeof original;
  try { await run(); } finally { process.stdout.write = original; }
}

function fixture(commands: Command[]) {
  return {
    request: async (command: Command, match: (event: Event) => boolean) => {
      commands.push(command);
      const event = command.type === "new_conversation"
        ? { type: "conversation_created", reqId: command.reqId, convId: "test-child" }
        : command.type === "llm_complete"
          ? { type: "llm_complete_result", reqId: command.reqId, text: "ok" }
          : { type: "ack", reqId: command.reqId };
      expect(match(event as Event)).toBe(true);
      return event;
    },
    send: (command: Command) => { commands.push(command); },
  } as unknown as Connection;
}

describe("delegation wire policy", () => {
  test("new sends omit model/effort overrides but propagate legacy opt-in through creation and dispatch", async () => {
    for (const legacy of [false, true]) {
      const commands: Command[] = [];
      await withoutOutput(() => send(fixture(commands), "test", null, null, null, { ...options, legacy }));
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({ type: "new_conversation", delegation: true, legacy, model: undefined, effort: undefined });
      expect(commands[1]).toMatchObject({ type: "send_message", delegation: true, legacy });
    }
  });

  test("existing model switches are acknowledged before delegated send", async () => {
    const commands: Command[] = [];
    await withoutOutput(() => send(fixture(commands), "test", "child", "openai", "sol", { ...options, legacy: false }));
    expect(commands.map(command => command.type)).toEqual(["set_model", "send_message"]);
    expect(commands[0]).toMatchObject({ delegation: true, legacy: false, model: "sol" });
    const rejected = fixture([]);
    rejected.request = async () => { throw new Error("legacy denied"); };
    await expect(send(rejected, "test", "child", "openai", "gpt-5.6-sol", options)).rejects.toThrow("legacy denied");
  });

  test("queue and stateless completions carry opt-in and effort", async () => {
    const commands: Command[] = [];
    const conn = fixture(commands);
    await withoutOutput(async () => {
      await queue(conn, "child", "test", "next-turn", true);
      await llm(conn, "test", "", null, "astra", { ...options, legacy: true, effort: "xhigh" });
    });
    expect(commands[0]).toMatchObject({ type: "queue_message", delegation: true, legacy: true });
    expect(commands[1]).toMatchObject({ type: "llm_complete", delegation: true, legacy: true, effort: "xhigh" });
  });

  test("foreground collector also carries delegation and legacy flags", async () => {
    const commands: Command[] = [];
    let handler: (event: Event) => void;
    const conn = {
      onEvent: (callback: typeof handler) => { handler = callback; },
      offEvent: () => {},
      onDisconnect: () => {},
      offDisconnect: () => {},
      send: (command: Command) => {
        commands.push(command);
        handler({ type: "error", convId: "child", message: "test stop" } as Event);
      },
    } as unknown as Connection;
    await expect(collectResponse(conn, "child", "test", 1000, undefined, { delegation: true, legacy: true })).rejects.toThrow("test stop");
    expect(commands[0]).toMatchObject({ type: "send_message", delegation: true, legacy: true });
  });
});
