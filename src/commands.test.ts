import { describe, expect, test } from "bun:test";
import { history, type OutputOptions } from "./commands";
import type { Connection } from "./conn";
import type { Command, ConversationLoadedEvent, Event } from "./shared/protocol";

const baseOptions: OutputOptions = {
  json: false,
  full: false,
  stream: false,
  idOnly: false,
  timeout: 1_000,
};

const pendingAI: NonNullable<ConversationLoadedEvent["pendingAI"]> = {
  blocks: [
    { type: "thinking", text: "private reasoning" },
    {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "pwd" },
      summary: "Checked the directory",
    },
    {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      output: "/workspace",
      isError: false,
    },
    { type: "text", text: "Live answer" },
  ],
  metadata: {
    startedAt: 20,
    endedAt: null,
    model: "gpt-5.6-sol",
    tokens: 12,
  },
};

function loadedEvent(overrides: Partial<ConversationLoadedEvent> = {}): ConversationLoadedEvent {
  return {
    type: "conversation_loaded",
    convId: "conv-1",
    model: "gpt-5.6-sol",
    effort: "high",
    entries: [{ type: "user", text: "Question" }],
    pendingAI,
    contextTokens: 42,
    ...overrides,
  };
}

function connectionReturning(event: ConversationLoadedEvent): Connection {
  return {
    request: async (command: Command, match: (event: Event) => boolean) => {
      expect(command).toMatchObject({ type: "load_conversation", convId: event.convId });
      const response = { ...event, reqId: command.reqId };
      expect(match(response)).toBe(true);
      return response;
    },
  } as unknown as Connection;
}

async function captureHistory(
  event: ConversationLoadedEvent,
  overrides: Partial<OutputOptions> = {},
): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    expect(await history(connectionReturning(event), event.convId, { ...baseOptions, ...overrides })).toBe(0);
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

describe("history", () => {
  test("includes the pending assistant snapshot in filtered text output", async () => {
    const output = await captureHistory(loadedEvent());

    expect(output).toContain("▶ Assistant");
    expect(output).toContain("  ╸ Checked the directory");
    expect(output).toContain("Live answer");
    expect(output).not.toContain("private reasoning");
    expect(output).not.toContain("/workspace");
  });

  test("applies --full formatting to the pending assistant snapshot", async () => {
    const output = await captureHistory(loadedEvent(), { full: true });

    expect(output).toContain("  💭 private reasoning");
    expect(output).toContain("  ┃ /workspace");
    expect(output).toContain("Live answer");
  });

  test("includes the unfiltered pending assistant snapshot in JSON output", async () => {
    const event = loadedEvent();
    const output = await captureHistory(event, { json: true });

    expect(JSON.parse(output)).toEqual([
      ...event.entries,
      { type: "ai", ...pendingAI },
    ]);
  });

  test("does not duplicate a pending turn that is already a completed assistant entry", async () => {
    const completed = {
      type: "ai" as const,
      blocks: pendingAI.blocks,
      metadata: { ...pendingAI.metadata!, endedAt: 30 },
    };
    const event = loadedEvent({ entries: [{ type: "user", text: "Question" }, completed] });
    const output = await captureHistory(event, { json: true });

    expect(JSON.parse(output)).toEqual(event.entries);
  });
});
