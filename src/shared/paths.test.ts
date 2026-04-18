import { beforeEach, describe, expect, test } from "bun:test";
import { dataDir, repoRoot, runtimeDir, setRepoRootOverride, setWorktreeOverride, sourceRepoRoot, worktreeName } from "./paths";

describe("path targeting", () => {
  beforeEach(() => {
    setWorktreeOverride(null);
    setRepoRootOverride(null);
  });

  test("defaults to the main source checkout with no worktree instance", () => {
    expect(worktreeName()).toBe(null);
    expect(repoRoot()).toBe(sourceRepoRoot());
    expect(dataDir()).toBe(`${sourceRepoRoot()}/config/data`);
    expect(runtimeDir()).toBe(`${sourceRepoRoot()}/config/runtime`);
  });

  test("uses explicit override for namespaced paths", () => {
    setWorktreeOverride("browse-links");
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/browse-links`);

    expect(worktreeName()).toBe("browse-links");
    expect(repoRoot()).toContain("/.worktrees/browse-links");
    expect(dataDir()).toContain("/.worktrees/browse-links/config/data/instances/browse-links");
    expect(runtimeDir()).toContain("/.worktrees/browse-links/config/runtime/browse-links");
  });

  test("clearing override restores the main source checkout", () => {
    setWorktreeOverride("browse-links");
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/browse-links`);
    setWorktreeOverride(null);
    setRepoRootOverride(null);

    expect(worktreeName()).toBe(null);
    expect(repoRoot()).toBe(sourceRepoRoot());
  });
});
