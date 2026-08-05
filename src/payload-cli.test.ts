import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve(import.meta.dir, "../bin/exo");

function run(args: string[], input: string | Buffer = "") {
  return spawnSync(cli, args, { input, encoding: "utf8" });
}

describe("opaque payload CLI contract", () => {
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
    expect(send.stdout).toContain("--custom-tool");
    expect(send.stdout).toContain("--internal-tool");
    expect(send.stdout).toContain("--folder");
    expect(send.stdout).toContain("--auto-title");
    expect(queue.stdout).toContain("exact UTF-8 message from stdin");
    expect(llm.stdout).toContain("--system-file");
  });

  test("validates new-conversation tool flags before connecting", () => {
    for (const [args, message] of [
      [["send", "--custom-tool"], "--custom-tool requires a module path"],
      [["send", "--internal-tool"], "--internal-tool requires a tool name"],
      [["send", "--external-tool"], "--external-tool requires a tool name"],
      [["send", "--folder"], "--folder requires a sidebar folder path"],
      [["send", "-c", "123-aabbcc", "--auto-title"], "only valid when creating a new conversation"],
    ] as const) {
      const result = run([...args], "request");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("socket");
    }
  });
});
