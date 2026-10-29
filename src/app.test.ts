import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { parseArgs } from "./args";
import { emit, runCli, withDaemon } from "./test-utils";
import type { Command } from "./shared/protocol";

function appDaemon(opts: { welcome?: boolean; version?: number; stopReason?: "end_turn" | "error" | "aborted"; sessions?: boolean; dropFirstRun?: boolean } = {}) {
  let runs = 0;
  return (command: Command, socket: Socket) => {
    if (command.type === "client_capabilities") {
      if (opts.welcome === false) return;
      emit(socket, {
        type: "app_welcome", reqId: command.reqId, appApiVersion: opts.version ?? 1, app: command.app!.name, instance: "t", pid: 1,
        ...(opts.sessions ? { session: command.app!.session ?? "test-session-token-1234", resumed: Boolean(command.app!.session) } : {}),
      });
    }
    // A daemon restart while the first run is in flight: the connection drops.
    if (command.type === "app_run" && opts.dropFirstRun && ++runs === 1) {
      socket.destroy();
      return;
    }
    if (command.type === "app_run") {
      emit(socket, { type: "conversation_created", reqId: command.reqId, convId: "1793160000000-ab12cd", model: "m" });
      emit(socket, { type: "text_chunk", convId: "1793160000000-ab12cd", text: "three " });
      const stopReason = opts.stopReason ?? "end_turn";
      emit(socket, {
        type: "turn_result", reqId: command.reqId, convId: "1793160000000-ab12cd", turnId: String(command.startedAt ?? ""), stopReason,
        text: stopReason === "end_turn" ? "2, 3, 5" : "", ...(stopReason === "error" ? { error: "provider down" } : {}),
        usage: { outputTokens: 5, durationMs: 10 },
      });
    }
    if (command.type === "list_app_conversations") {
      emit(socket, {
        type: "app_conversations_list", reqId: command.reqId, conversations: [{
          convId: "1793160000000-ab12cd", app: "nvim", lifetime: "temporary", title: "Buffer helper", provider: "anthropic",
          model: "claude-haiku-4-5", createdAt: 1, lastActivityAt: 2, expiresAt: 3_600_002, ownerConnected: true, streaming: false,
          systemBase: "none", builtinTools: [], appTools: ["get_buffer"],
        }],
      });
    }
  };
}

describe("exo run", () => {
  test("declares the app, sends app_run with the flags, prints the final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-run-"));
    try {
      writeFileSync(join(dir, "sys.txt"), "Answer tersely.");
      await withDaemon(appDaemon(), async ({ args, commands }) => {
        const result = await runCli([...args, "run", "--app", "myapp", "--system-file", join(dir, "sys.txt"), "--base", "agent",
          "--tools", "read,grep", "--cwd", dir, "--model", "claude-haiku-4-5", "--effort", "low", "--keep"], "Name three primes.");
        expect(result.errors).toContain("exo: conversation 1793160000000-ab12cd (temporary)\n");
        expect(result.output).toBe("2, 3, 5\n");
        expect(result.code).toBe(0);
        expect(commands[0]).toMatchObject({ type: "client_capabilities", app: { name: "myapp" } });
        expect(commands[1]).toMatchObject({
          type: "app_run", prompt: "Name three primes.", lifetime: "temporary",
          system: { text: "Answer tersely.", base: "agent" }, tools: { builtin: ["read", "grep"] }, cwd: dir,
          model: "claude-haiku-4-5", effort: "low",
        });
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("defaults: app exo-cli, ephemeral (no lifetime sent), no system, no tools; --json prints turn_result", async () => {
    await withDaemon(appDaemon(), async ({ args, commands }) => {
      const result = await runCli([...args, "run", "--json"], "hi");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ type: "turn_result", text: "2, 3, 5", stopReason: "end_turn" });
      expect(commands[0]).toMatchObject({ app: { name: "exo-cli" } });
      const run = commands[1] as any;
      expect(Object.keys(run).sort()).toEqual(["convId", "prompt", "reqId", "startedAt", "type"]);
      expect(run.convId).toMatch(/^\d+-[a-z0-9]{6}$/);
    });
  });

  test("an errored or aborted turn exits 1", async () => {
    await withDaemon(appDaemon({ stopReason: "error" }), async ({ args }) => {
      const result = await runCli([...args, "run"], "hi");
      expect(result.code).toBe(1);
      expect(result.errors).toContain("provider down");
    });
    await withDaemon(appDaemon({ stopReason: "aborted" }), async ({ args }) => {
      expect((await runCli([...args, "run"], "hi")).code).toBe(1);
    });
  });

  test("a dropped connection mid-run reconnects under its session and sends the same run again", async () => {
    await withDaemon(appDaemon({ sessions: true, dropFirstRun: true }), async ({ args, commands }) => {
      const result = await runCli([...args, "run"], "hi");
      expect(result.output).toBe("2, 3, 5\n");
      expect(result.code).toBe(0);
      const runs = commands.filter(c => c.type === "app_run") as any[];
      expect(runs).toHaveLength(2);
      expect(runs[1].convId).toBe(runs[0].convId);
      expect(runs[1].startedAt).toBe(runs[0].startedAt);
      expect(runs[1].reqId).not.toBe(runs[0].reqId);
      const caps = commands.filter(c => c.type === "client_capabilities") as any[];
      expect(caps[1].app.session).toBe("test-session-token-1234");
    });
  });

  test("a daemon without sessions is not sent a run twice", async () => {
    await withDaemon(appDaemon({ dropFirstRun: true }), async ({ args, commands }) => {
      const result = await runCli([...args, "run"], "hi");
      expect(result.code).toBe(1);
      expect(commands.filter(c => c.type === "app_run")).toHaveLength(1);
    });
  });

  test("an old daemon or another app API version is refused", async () => {
    await withDaemon(appDaemon({ welcome: false }), async ({ args }) => {
      const result = await runCli([...args, "run", "--timeout", "0.3"], "hi");
      expect(result.code).toBe(1);
      expect(result.errors).toContain("too old for the app API");
    });
    await withDaemon(appDaemon({ version: 2 }), async ({ args, commands }) => {
      const result = await runCli([...args, "run"], "hi");
      expect(result.code).toBe(1);
      expect(result.errors).toContain("app API v2");
      expect(commands.map(c => c.type)).toEqual(["client_capabilities"]);
    });
  });

  test("argument checks", () => {
    expect(parseArgs(["run", "--tools", "read,teleport"]).parseError).toContain("Unknown tool: teleport");
    expect(parseArgs(["run", "--tools", "all"]).tools).toBe("all");
    expect(parseArgs(["run", "--lifetime", "forever"]).parseError).toContain("Unknown lifetime");
    expect(parseArgs(["run", "--base", "max"]).parseError).toContain("Unknown system base");
    expect(parseArgs(["run", "--app", "My App"]).parseError).toContain("--app must be");
    expect(parseArgs(["run", "--keep", "--lifetime", "ephemeral"]).parseError).toContain("--keep");
    expect(parseArgs(["send", "--tools", "read"]).parseError).toContain("only valid with exo run");
    expect(parseArgs(["list", "--saved"]).parseError).toContain("--apps");
    expect(parseArgs(["run", "--stream"]).parseError).toContain("only valid with exo send");
    expect(parseArgs(["list", "--apps", "--app", "nvim", "--saved"]).parseError).toBeNull();
  });

  test("the prompt comes from stdin only", async () => {
    await withDaemon(appDaemon(), async ({ args }) => {
      expect((await runCli([...args, "run", "inline"], "")).code).toBe(2);
      expect((await runCli([...args, "run"], "")).errors).toContain("run prompt is required on stdin");
    });
  });
});

describe("exo list --apps", () => {
  test("lists app conversations", async () => {
    await withDaemon(appDaemon(), async ({ args, commands }) => {
      const result = await runCli([...args, "list", "--apps", "--app", "nvim", "--saved"]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("1793160000000-ab12cd  nvim  temporary  claude-haiku-4-5  idle, owned  Buffer helper  expires");
      expect(commands[1]).toMatchObject({ type: "list_app_conversations", app: "nvim", includeSaved: true });
      const json = await runCli([...args, "list", "--apps", "--json"]);
      expect(JSON.parse(json.output)[0].appTools).toEqual(["get_buffer"]);
    });
  });
});
