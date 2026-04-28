import { describe, expect, test } from "bun:test";
import {
  inferProviderForModel,
  isProviderId,
  normalizeModelForProvider,
  parseModelSpecifier,
} from "./model-spec";

describe("model-spec", () => {
  test("recognizes valid providers", () => {
    expect(isProviderId("anthropic")).toBe(true);
    expect(isProviderId("openai")).toBe(true);
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("nope")).toBe(false);
  });

  test("normalizes anthropic aliases", () => {
    expect(normalizeModelForProvider("anthropic", "opus-4.6")).toBe("claude-opus-4-6");
    expect(normalizeModelForProvider("anthropic", "sonnet")).toBe("claude-sonnet-4-6");
    expect(normalizeModelForProvider("anthropic", "haiku-4.5")).toBe("claude-haiku-4-5-20251001");
  });

  test("leaves provider-specific openai models alone", () => {
    expect(normalizeModelForProvider("openai", "gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  test("normalizes deepseek aliases", () => {
    expect(normalizeModelForProvider("deepseek", "pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelForProvider("deepseek", "v4-flash")).toBe("deepseek-v4-flash");
  });

  test("infers providers from canonical and shorthand models", () => {
    expect(inferProviderForModel("claude-opus-4-6")).toBe("anthropic");
    expect(inferProviderForModel("opus")).toBe("anthropic");
    expect(inferProviderForModel("deepseek-v4-pro")).toBe("deepseek");
    expect(inferProviderForModel("pro")).toBe("deepseek");
    expect(inferProviderForModel("gpt-5.4")).toBeUndefined();
  });

  test("parses provider-qualified specs", () => {
    expect(parseModelSpecifier("anthropic/opus-4.6")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(parseModelSpecifier("openai/gpt-5.4-mini")).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(parseModelSpecifier("deepseek/pro")).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });

  test("parses shorthand anthropic specs", () => {
    expect(parseModelSpecifier("opus-4.6")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  test("keeps unknown unqualified models provider-agnostic", () => {
    expect(parseModelSpecifier("gpt-5.4")).toEqual({
      provider: null,
      model: "gpt-5.4",
    });
  });

  test("throws for invalid provider-qualified specs", () => {
    expect(() => parseModelSpecifier("nope/thing")).toThrow("Unknown provider in model spec: nope");
    expect(() => parseModelSpecifier("anthropic/")).toThrow("Missing model name after provider");
  });
});
