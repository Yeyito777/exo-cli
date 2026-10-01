import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("argument validation before connecting", () => {
  test("supports all providers and nested model namespaces in either flag order", () => {
    for (const provider of ["openai", "deepseek", "opencode", "openrouter"]) {
      expect(parseArgs(["send", "--provider", provider]).parseError).toBeNull();
    }
    for (const flags of [
      ["--provider", "openrouter", "--model", "nousresearch/hermes-4-405b"],
      ["--model", "nousresearch/hermes-4-405b", "--provider", "openrouter"],
      ["--model", "openrouter/nousresearch/hermes-4-405b"],
    ]) expect(parseArgs(["send", ...flags])).toMatchObject({
      parseError: null, provider: "openrouter", model: "nousresearch/hermes-4-405b",
    });
    expect(parseArgs(["send", "--provider", "openai", "--model", "deepseek/pro"]).parseError).toContain("conflicts");
    expect(parseArgs(["send", "--model", ""]).parseError).toContain("non-empty");
  });

  test("accepts ultrafast and rejects conflicting tier/output flags", () => {
    expect(parseArgs(["send", "--ultrafast"]).fastMode).toBe("ultrafast");
    expect(parseArgs(["send", "--fast", "--ultrafast"]).parseError).toContain("Choose only one");
    expect(parseArgs(["send", "--json", "--stream"]).parseError).toContain("output mode");
    expect(parseArgs(["send", "--foreground", "--detach"]).parseError).toContain("cannot be combined");
  });

  test("validates finite positive timeouts and missing/unknown flags", () => {
    for (const value of ["abc", "0", "-1", "Infinity", "1s", "2147484", "0.0001"]) {
      expect(parseArgs(["send", `--timeout=${value}`]).parseError).not.toBeNull();
    }
    expect(parseArgs(["send", "--timeout", "1.5"]).timeout).toBe(1500);
    expect(parseArgs(["send", "--timeout", "1.001"]).timeout).toBe(1001);
    for (const flag of ["--conv", "--timeout", "--mime-type", "--instance"]) {
      expect(parseArgs(["send", flag, "--json"]).parseError).toContain("requires a value");
    }
    expect(parseArgs(["status", "--instnace", "other"]).parseError).toContain("Unknown flag");
    expect(parseArgs(["status", "--instance", "../main"]).parseError).toContain("not a path");
    expect(parseArgs(["send", "--conv", "child", "--provider", "deepseek"]).parseError).toContain("requires --model");
  });

  test("prototype names are not aliases, flags, or shorthand models", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(parseArgs([name]).subcommand).toBeNull();
      expect(parseArgs(["send", "--model", name])).toMatchObject({ model: name, provider: null, parseError: null });
    }
  });

  test("retired flags fail locally including equals syntax", () => {
    for (const flag of ["--custom-tool", "--internal-tool", "--external-tool"]) {
      expect(parseArgs(["send", `${flag}=anything`]).parseError).toContain("is retired");
    }
  });
});
