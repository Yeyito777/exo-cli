import { beforeEach, describe, expect, test } from "bun:test";
import { dataDir, repoRoot, runtimeDir, setRepoRootOverride, setWorktreeOverride, sourceRepoRoot, worktreeName } from "./paths";

describe("worktree override", () => {
  beforeEach(() => {
    setWorktreeOverride(null);
    setRepoRootOverride(null);
  });

  test("uses explicit override for namespaced paths", () => {
    setWorktreeOverride("browse-links");
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/browse-links`);

    expect(worktreeName()).toBe("browse-links");
    expect(repoRoot()).toContain("/.worktrees/browse-links");
    expect(dataDir()).toContain("/.worktrees/browse-links/config/data/instances/browse-links");
    expect(runtimeDir()).toContain("/.worktrees/browse-links/config/runtime/browse-links");
  });

  test("clearing override restores default detection result", () => {
    const detectedWorktree = worktreeName();
    const detectedRepoRoot = repoRoot();

    setWorktreeOverride("browse-links");
    setRepoRootOverride(`${sourceRepoRoot()}/.worktrees/browse-links`);
    setWorktreeOverride(null);
    setRepoRootOverride(null);

    expect(worktreeName()).toBe(detectedWorktree);
    expect(repoRoot()).toBe(detectedRepoRoot);
  });
});
