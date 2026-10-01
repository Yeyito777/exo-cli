import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve(import.meta.dir, "./main.ts");

function run(args: string[], input: string | Buffer = "") {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", timeout: 5000 });
}

describe("opaque payload CLI contract", () => {
  test("parses legacy opt-in and current effort levels without connecting", () => {
    for (const command of ["send", "llm"]) {
      const result = run([command, "--legacy", "--model", "openai/astra", "--effort", "xhigh"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("required on stdin");
      expect(result.stderr).not.toContain("Unknown");
    }
    expect(run(["list", "--legacy"]).stderr).toContain("--legacy is only valid");
  });

  test("rejects inline and legacy sentinel payloads before connecting", () => {
    for (const [args, message] of [
      [["send", "inline"], "send message must be provided via stdin"],
      [["send", "-"], "send message must be provided via stdin"],
      [["llm", "inline"], "llm prompt must be provided via stdin"],
      [["queue", "conv-1", "inline"], "queue message must be provided via stdin"],
    ] as const) {
      const result = run([...args]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("socket");
    }
  });

  test("rejects missing stdin before connecting", () => {
    for (const [args, message] of [
      [["send"], "send message is required on stdin"],
      [["llm"], "llm prompt is required on stdin"],
      [["queue", "conv-1"], "queue message is required on stdin"],
    ] as const) {
      const result = run([...args]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("socket");
    }
  });

  test("rejects invalid UTF-8 before connecting", () => {
    const result = run(["send"], Buffer.from([0xff]));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("send message on stdin must be valid UTF-8");
    expect(result.stderr).not.toContain("socket");
  });

  test("replaces inline --system with a file source", () => {
    const inline = run(["llm", "--system", "system"], "prompt");
    expect(inline.status).toBe(2);
    expect(inline.stderr).toContain("--system is not accepted; use --system-file <path>");
    expect(inline.stdout).toBe("");

    const stdinCollision = run(["llm", "--system-file", "-"], "prompt");
    expect(stdinCollision.status).toBe(2);
    expect(stdinCollision.stderr).toContain("stdin is reserved for the primary llm prompt");
  });

  test("documents stdin-only payloads in top-level and command help", () => {
    const top = run(["-h"]);
    const send = run(["send", "-h"]);
    const queue = run(["queue", "-h"]);
    const llm = run(["llm", "-h"]);
    expect(top.stdout).toContain("read their exact UTF-8 message/prompt from stdin");
    expect(send.stdout).toContain("Inline message arguments are not accepted");
    expect(send.stdout).not.toContain("--custom-tool");
    expect(send.stdout).not.toContain("--internal-tool");
    expect(send.stdout).toContain("--folder");
    expect(send.stdout).toContain("--auto-title");
    expect(send.stdout).toContain("--fast / --no-fast");
    expect(send.stdout).toContain("--new-conversation-id");
    expect(send.stdout).toContain("--effort <level>");
    expect(send.stdout).toContain("--legacy");
    expect(top.stdout).toContain("Almost never use subagents");
    expect(top.stdout).not.toContain("currently gpt-5.6");
    expect(queue.stdout).toContain("exact UTF-8 message from stdin");
    expect(llm.stdout).toContain("--system-file");
  });

  test("rejects retired selections and validates creation flags before connecting", () => {
    for (const [args, message] of [
      [["send", "--custom-tool"], "--custom-tool is retired"],
      [["send", "--internal-tool"], "--internal-tool is retired"],
      [["send", "--external-tool"], "--external-tool is retired"],
      [["send", "--folder"], "--folder requires a value"],
      [["send", "--new-conversation-id", "invalid"], "must match <13-digit timestamp>"],
      [["send", "--effort", "extreme"], "Unknown effort"],
      [["send", "-c", "123-aabbcc", "--auto-title"], "only valid when creating a new conversation"],
      [["send", "-c", "123-aabbcc", "--new-conversation-id", "1785000000000-aabbcc"], "only valid when creating a new conversation"],
      [["info", "123-aabbcc", "--fast"], "only valid with exo send"],
    ] as const) {
      const result = run([...args], "request");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("socket");
    }
  });
});
