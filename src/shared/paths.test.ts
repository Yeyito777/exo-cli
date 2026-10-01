import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import {
  dataDir,
  configDir,
  detectSourceRepoRoot,
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

  test("resolves both source and generated bundle locations without fixed depth", () => {
    const root = mkdtempSync(join(tmpdir(), "exo-layout-"));
    try {
      for (const path of ["daemon/src", "shared/src", "external-tools/exo-cli/src/shared", "external-tools/exo-cli/dist"]) {
        mkdirSync(join(root, path), { recursive: true });
      }
      writeFileSync(join(root, "daemon/src/main.ts"), "");
      writeFileSync(join(root, "shared/src/protocol.ts"), "");
      writeFileSync(join(root, "external-tools/exo-cli/package.json"), '{"name":"exo-cli"}');
      expect(detectSourceRepoRoot(join(root, "external-tools/exo-cli/src/shared"))).toBe(root);
      expect(detectSourceRepoRoot(join(root, "external-tools/exo-cli/dist"))).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("honors the same isolated config override as the daemon", () => {
    const previous = process.env.EXOCORTEX_CONFIG_DIR;
    try {
      process.env.EXOCORTEX_CONFIG_DIR = join(tmpdir(), "custom-exo-config");
      expect(configDir()).toBe(process.env.EXOCORTEX_CONFIG_DIR);
    } finally {
      if (previous === undefined) delete process.env.EXOCORTEX_CONFIG_DIR;
      else process.env.EXOCORTEX_CONFIG_DIR = previous;
    }
  });
});
