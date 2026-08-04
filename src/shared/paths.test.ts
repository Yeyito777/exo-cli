import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import {
  dataDir,
  repoRoot,
  runtimeDir,
  setRepoRootOverride,
  setWorktreeOverride,
  socketPath,
  sourceRepoRoot,
  worktreeName,
} from "./paths";

describe("path targeting", () => {
  beforeEach(() => {
    setWorktreeOverride(null);
    setRepoRootOverride(null);
  });

  test("defaults to the main source checkout with no worktree instance", () => {
    expect(worktreeName()).toBe(null);
    expect(repoRoot()).toBe(sourceRepoRoot());
    expect(dataDir()).toBe(join(sourceRepoRoot(), "config", "data"));
    expect(runtimeDir()).toBe(join(sourceRepoRoot(), "config", "runtime"));
    expect(socketPath("win32")).toBe("\\\\.\\pipe\\exocortexd");
  });

  test("uses explicit override for namespaced paths", () => {
    setWorktreeOverride("browse-links");
    setRepoRootOverride(join(sourceRepoRoot(), ".worktrees", "browse-links"));

    expect(worktreeName()).toBe("browse-links");
    expect(repoRoot()).toBe(join(sourceRepoRoot(), ".worktrees", "browse-links"));
    expect(dataDir()).toBe(join(repoRoot(), "config", "data", "instances", "browse-links"));
    expect(runtimeDir()).toBe(join(repoRoot(), "config", "runtime", "browse-links"));
    expect(socketPath("win32")).toBe("\\\\.\\pipe\\exocortexd-browse-links");
  });

  test("clearing override restores the main source checkout", () => {
    setWorktreeOverride("browse-links");
    setRepoRootOverride(join(sourceRepoRoot(), ".worktrees", "browse-links"));
    setWorktreeOverride(null);
    setRepoRootOverride(null);

    expect(worktreeName()).toBe(null);
    expect(repoRoot()).toBe(sourceRepoRoot());
  });
});
