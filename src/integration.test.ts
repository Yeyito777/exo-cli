import { describe, expect, test } from "bun:test";
import { send } from "./commands";
import { capture, emit, options, runCli, withDaemon } from "./test-utils";
import type { Command } from "./shared/protocol";
import type { Socket } from "node:net";

function complete(command: Command, socket: Socket) {
  if (command.type !== "send_message") return;
  emit(socket, { type: "streaming_started", convId: command.convId, model: "test", startedAt: command.startedAt });
  emit(socket, { type: "text_chunk", convId: command.convId, text: "ok 🐋" });
  emit(socket, { type: "message_complete", convId: command.convId, blocks: [{ type: "text", text: "ok 🐋" }], tokens: 2, endedAt: Date.now() });
  emit(socket, { type: "streaming_stopped", convId: command.convId });
}

describe("isolated daemon integration", () => {
  test("acknowledges all settings before dispatch and prevents rejected-setting sends", async () => {
    await withDaemon((command, socket) => emit(socket, { type: "ack", reqId: command.reqId }), async ({ conn, commands }) => {
      await capture(() => send(conn, "test", "child", "openai", "astra", {
        ...options, detached: true, effort: "high", fastMode: "ultrafast",
      }));
      expect(commands.map(c => c.type)).toEqual(["set_model", "set_effort", "set_fast_mode", "send_message"]);
      expect(commands.every(c => Boolean(c.reqId))).toBe(true);
    });
    for (const setting of ["set_effort", "set_fast_mode"] as const) for (const detached of [false, true]) {
      await withDaemon((command, socket) => emit(socket, {
        type: "error", reqId: command.reqId, convId: "child", message: "setting rejected",
      }), async ({ conn, commands }) => {
        await expect(send(conn, "test", "child", null, null, {
          ...options, detached, ...(setting === "set_effort" ? { effort: "ultra" as const } : { fastMode: true }),
        })).rejects.toThrow("setting rejected");
        expect(commands.map(c => c.type)).toEqual([setting]);
      });
    }
  });

  test("foreground JSON/NDJSON/ID output remains parseable including busy fallback", async () => {
    for (const busy of [false, true]) for (const flag of ["--json", "--stream", "--id"]) {
      await withDaemon((command, socket) => {
        if (command.type === "queue_message") emit(socket, { type: "ack", reqId: command.reqId });
        if (command.type !== "send_message") return;
        if (busy) emit(socket, { type: "error", reqId: command.reqId, convId: command.convId, message: "Already streaming" });
        else complete(command, socket);
      }, async ({ args, commands }) => {
        const result = await runCli([...args, "send", "--foreground", "-c", "child", flag]);
        expect(result.code).toBe(0);
        if (flag === "--id") expect(result.output).toBe("child\n");
        else {
          const events = result.output.trim().split("\n").map(line => JSON.parse(line));
          expect(events.at(-1).convId).toBe("child");
          if (busy) expect(events.at(-1).queued).toBe(true);
          else expect(events.at(-1).status).toBe("completed");
        }
        expect(commands.find(c => c.type === "send_message")).toMatchObject({ text: "audit 🐋 café" });
      });
    }
  });

  test("new and detached sends preserve provider/tier settings and structured output", async () => {
    for (const flag of ["--json", "--stream", "--id"]) {
      await withDaemon((command, socket) => {
        if (command.type === "new_conversation") emit(socket, { type: "conversation_created", reqId: command.reqId, convId: "child", model: command.model! });
        if (command.type === "send_message") emit(socket, { type: "ack", reqId: command.reqId });
      }, async ({ args, commands }) => {
        const result = await runCli([...args, "send", "--detach", "--model", "openrouter/nousresearch/hermes-4-405b", "--ultrafast", flag]);
        expect(result.code).toBe(0);
        if (flag === "--id") expect(result.output).toBe("child\n");
        else expect(JSON.parse(result.output)).toMatchObject({ convId: "child", detached: true });
        expect(commands[0]).toMatchObject({ type: "new_conversation", provider: "openrouter", model: "nousresearch/hermes-4-405b", fastMode: "ultrafast" });
        expect(JSON.stringify(commands)).not.toContain("draftToolPolicy");
      });
    }
  });

  test("follows handoffs and preserves partial interrupted/suspended responses", async () => {
    await withDaemon((command, socket) => {
      if (command.type !== "send_message") return;
      emit(socket, { type: "streaming_stopped", convId: command.convId });
      emit(socket, { type: "streaming_started", convId: command.convId, model: "test", startedAt: command.startedAt });
      emit(socket, { type: "message_complete", convId: command.convId, blocks: [{ type: "text", text: "first" }], tokens: 1, endedAt: 1 });
      emit(socket, { type: "streaming_stopped", convId: command.convId, reason: "handoff" });
      complete(command, socket);
    }, async ({ args }) => {
      const result = await runCli([...args, "send", "--foreground", "-c", "child", "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ status: "completed", tokens: 3, blocks: [{ type: "text", text: "first" }, { type: "text", text: "ok 🐋" }] });
    });
    for (const reason of [undefined, "daemon-restart", "unwind", "suspended"] as const) {
      await withDaemon((command, socket) => {
        if (command.type === "send_message") {
          emit(socket, { type: "streaming_started", convId: command.convId, model: "test", startedAt: command.startedAt });
          emit(socket, {
            type: "streaming_stopped", convId: command.convId, reason,
            persistedBlocks: [{ type: "text", text: "partial" }],
          });
        }
      }, async ({ args }) => {
        const result = await runCli([...args, "send", "--foreground", "-c", "child", "--json"]);
        expect(result.code).toBe(reason === "suspended" ? 3 : 1);
        expect(JSON.parse(result.output)).toMatchObject({
          status: reason === "suspended" ? "suspended" : "interrupted",
          stopReason: reason ?? "aborted", blocks: [{ type: "text", text: "partial" }],
        });
      });
    }
  });

  test("reads model capabilities from the daemon rather than a hardcoded generation", async () => {
    const providers = [{
      id: "openrouter" as const, label: "OpenRouter", defaultModel: "future/model",
      allowsCustomModels: true, supportsFastMode: false,
      models: [{ id: "future/model", label: "Future", maxContext: 123, defaultEffort: "none" as const, supportedEfforts: [], supportsUltrafastMode: true }],
    }];
    await withDaemon((_command, socket) => emit(socket, { type: "tools_available", tools: [], providers }), async ({ args }) => {
      const result = await runCli([...args, "models", "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toEqual(providers);
    });
  });

  test("large structured responses drain completely without truncation", async () => {
    const text = "🐋".repeat(262_144);
    await withDaemon((command, socket) => {
      if (command.type !== "send_message") return;
      emit(socket, { type: "streaming_started", convId: command.convId, model: "test", startedAt: command.startedAt });
      emit(socket, { type: "message_complete", convId: command.convId, blocks: [{ type: "text", text }], tokens: 1, endedAt: 1 });
      emit(socket, { type: "streaming_stopped", convId: command.convId });
    }, async ({ args }) => {
      const result = await runCli([...args, "send", "--foreground", "-c", "child", "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output).blocks[0].text).toBe(text);
    });
  });

  test("streams a correlated global dispatch error as JSON, not a timeout", async () => {
    await withDaemon((command, socket) => {
      if (command.type === "send_message") emit(socket, { type: "error", reqId: command.reqId, message: "dispatch rejected" });
    }, async ({ args }) => {
      const result = await runCli([...args, "send", "--foreground", "-c", "child", "--stream"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.output)).toMatchObject({ type: "error", message: "dispatch rejected" });
      expect(result.errors).not.toContain("Timeout");
    });
  });
});
