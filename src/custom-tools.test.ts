import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { configureDraftToolPolicy, ensureFolderPath } from "./commands";
import type { Connection } from "./conn";
import type { Command, Event, FolderSummary, ToolPolicySnapshot } from "./shared/protocol";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function snapshot(overrides: Partial<ToolPolicySnapshot> = {}): ToolPolicySnapshot {
  return {
    convId: "1-abcdef",
    scoped: true,
    source: "explicit",
    internal: [
      { name: "read", label: "Read", enabled: true },
      { name: "glob", label: "Glob", enabled: true },
      { name: "minecraft_glob", label: "Minecraft Glob", enabled: true, modulePath: "/tool.ts" },
      { name: "minecraft_grep", label: "Minecraft Grep", enabled: true, modulePath: "/tool.ts" },
    ],
    external: [{ name: "google", label: "Google", enabled: true }],
    modules: [{ path: "/tool.ts", digest: "sha256:test", tools: ["minecraft_glob", "minecraft_grep"] }],
    shellWarning: false,
    ...overrides,
  };
}

function mutationConnection(commands: Command[]): Connection {
  let current = snapshot();
  return {
    request: async (command: Command, match: (event: Event) => boolean) => {
      commands.push(command);
      if (command.type === "set_draft_tool_policy") {
        if (command.mutation.action === "disable") {
          const disabledInternal = new Set(command.mutation.tools.filter((tool) => tool.kind === "internal").map((tool) => tool.name));
          const disabledExternal = new Set(command.mutation.tools.filter((tool) => tool.kind === "external").map((tool) => tool.name));
          current = {
            ...current,
            internal: current.internal.map((tool) => disabledInternal.has(tool.name) ? { ...tool, enabled: false } : tool),
            external: current.external.map((tool) => disabledExternal.has(tool.name) ? { ...tool, enabled: false } : tool),
          };
        }
        const event = { type: "tool_policy" as const, reqId: command.reqId, convId: command.draftId, snapshot: current, changed: true };
        expect(match(event)).toBe(true);
        return event;
      }
      if (command.type === "get_draft_tool_policy") {
        const event = { type: "tool_policy" as const, reqId: command.reqId, convId: command.draftId, snapshot: current, changed: false };
        expect(match(event)).toBe(true);
        return event;
      }
      throw new Error(`Unexpected command ${command.type}`);
    },
  } as unknown as Connection;
}

describe("new-conversation custom tool policy", () => {
  test("loads multiple modules before applying an exact internal allowlist", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "exo-cli-tools-"));
    temporary.push(root);
    const first = resolve(root, "first.ts");
    const second = resolve(root, "second.ts");
    await writeFile(first, "export default [];\n");
    await writeFile(second, "export default [];\n");
    const commands: Command[] = [];

    const result = await configureDraftToolPolicy(mutationConnection(commands), "1-abcdef", {
      customToolModules: [first, second],
      internalTools: ["read", "minecraft_glob", "minecraft_grep"],
      externalTools: [],
    });

    expect(commands[0]).toMatchObject({
      type: "set_draft_tool_policy",
      draftId: "1-abcdef",
      mutation: { action: "enable", tools: [], modulePaths: [first, second] },
    });
    expect(commands[1]).toMatchObject({
      type: "set_draft_tool_policy",
      mutation: { action: "disable", tools: [{ kind: "external", name: "google" }] },
    });
    expect(commands[2]).toMatchObject({
      type: "set_draft_tool_policy",
      mutation: { action: "disable", tools: [{ kind: "internal", name: "glob" }] },
    });
    expect(result?.external.find((tool) => tool.name === "google")?.enabled).toBe(false);
    expect(result?.internal.find((tool) => tool.name === "glob")?.enabled).toBe(false);
  });

  test("rejects invalid module paths before touching the daemon", async () => {
    const commands: Command[] = [];
    await expect(configureDraftToolPolicy(mutationConnection(commands), "1-abcdef", {
      customToolModules: ["/does/not/exist.ts"],
    })).rejects.toThrow("Custom tool module not found");
    expect(commands).toHaveLength(0);
  });

  test("rejects unknown exact tool names", async () => {
    const commands: Command[] = [];
    await expect(configureDraftToolPolicy(mutationConnection(commands), "1-abcdef", {
      internalTools: ["not_a_tool"],
    })).rejects.toThrow("Unknown or unavailable internal tool: not_a_tool");
    expect(commands[0]).toMatchObject({ type: "get_draft_tool_policy" });
  });
});

describe("nested send folder creation", () => {
  test("creates missing path components and returns the final folder id", async () => {
    const folders: FolderSummary[] = [];
    let nextId = 1;
    const commands: Command[] = [];
    const connection = {
      request: async (command: Command, match: (event: Event) => boolean) => {
        commands.push(command);
        if (command.type === "list_conversations") {
          const event = { type: "conversations_list" as const, reqId: command.reqId, conversations: [], folders: [...folders] };
          expect(match(event)).toBe(true);
          return event;
        }
        if (command.type === "create_folder") {
          folders.push({ id: `folder-${nextId++}`, name: command.name, parentId: command.parentId ?? null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: folders.length });
          const event = { type: "ack" as const, reqId: command.reqId };
          expect(match(event)).toBe(true);
          return event;
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
    } as unknown as Connection;

    const result = await ensureFolderPath(connection, "allcraft/logs");
    expect(result.path).toBe("allcraft/logs");
    expect(result.folderId).toBe("folder-2");
    expect(result.created.map((entry) => entry.path)).toEqual(["allcraft", "allcraft/logs"]);
    expect(commands.filter((command) => command.type === "create_folder")).toHaveLength(2);
  });
});
