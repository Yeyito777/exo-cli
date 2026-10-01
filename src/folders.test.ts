import { describe, expect, test } from "bun:test";
import { ensureFolderPath } from "./commands";
import type { Connection } from "./conn";
import type { Command, Event, FolderSummary } from "./shared/protocol";

describe("nested send folder creation", () => {
  test("creates missing path components and returns the final folder id", async () => {
    const folders: FolderSummary[] = [];
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
          folders.push({ id: `folder-${folders.length + 1}`, name: command.name, parentId: command.parentId ?? null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: folders.length });
          const event = { type: "ack" as const, reqId: command.reqId };
          expect(match(event)).toBe(true);
          return event;
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
    } as unknown as Connection;
    const result = await ensureFolderPath(connection, "allcraft/logs");
    expect(result.folderId).toBe("folder-2");
    expect(result.created.map(entry => entry.path)).toEqual(["allcraft", "allcraft/logs"]);
    expect(commands.filter(command => command.type === "create_folder")).toHaveLength(2);
    expect((await ensureFolderPath(connection, "allcraft/logs")).created).toEqual([]);
  });
});
