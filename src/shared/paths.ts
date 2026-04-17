/**
 * @exocortex/shared — Path resolution with git worktree isolation.
 *
 * All paths are resolved relative to the active repo root. By default we try
 * the caller's current git checkout first (so a worktree invocation targets
 * that worktree's daemon/data), and fall back to the source tree's repo root.
 *
 * Directory layout under <repo>/config/:
 *
 *   config root/        system.md, theme.json (tracked config)
 *   secrets/            env, credentials.json (never tracked)
 *   data/               conversations/, trash/ (bulk data, never tracked)
 *   runtime/            PID, socket, logs, usage.json (ephemeral)
 *   storage/            cron/, fix-auth.md (persistent user-local, not tracked)
 *
 * When running from a linked git worktree, runtime paths (socket, PID, logs)
 * and data paths (conversations) are namespaced by worktree name.
 * This lets multiple daemons coexist — one per worktree — without
 * conflicting. Secrets are always shared (same user, same API key).
 */

import { execSync } from "child_process";
import { join, basename, resolve } from "path";

// ── Repo root ───────────────────────────────────────────────────────
// This file lives at <repo>/external-tools/exo-cli/src/shared/paths.ts
// — four levels up is the source repo root.

const SOURCE_REPO_ROOT = resolve(import.meta.dir, "../../../..");

// ── Overrides / detection ────────────────────────────────────────────

let _worktreeName: string | null | undefined; // undefined = not yet detected
let _cwdRepoRoot: string | null | undefined;
let _worktreeOverride: string | null = null;
let _repoRootOverride: string | null = null;

function execGit(args: string[]): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: process.cwd(),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Detect the active repo root from the caller's current working directory.
 * Returns null if the cwd is not inside a git checkout.
 */
function detectCwdRepoRoot(): string | null {
  if (_cwdRepoRoot !== undefined) return _cwdRepoRoot;
  try {
    _cwdRepoRoot = resolve(execGit(["rev-parse", "--show-toplevel"]));
  } catch {
    _cwdRepoRoot = null;
  }
  return _cwdRepoRoot;
}

/**
 * Detect if the current working directory is a linked git worktree.
 * Returns the worktree name if so, null otherwise.
 * Result is cached after first call.
 */
function detectWorktree(): string | null {
  if (_worktreeName !== undefined) return _worktreeName;

  try {
    const gitDir = execGit(["rev-parse", "--git-dir"]);
    const gitCommonDir = execGit(["rev-parse", "--git-common-dir"]);

    // In a linked worktree, --git-dir is something like
    //   /path/to/main/.git/worktrees/<name>
    // while --git-common-dir is
    //   /path/to/main/.git
    // Resolve both to absolute paths to avoid relative/absolute mismatches.
    if (resolve(gitDir) !== resolve(gitCommonDir)) {
      _worktreeName = basename(gitDir);
    } else {
      _worktreeName = null;
    }
  } catch {
    // Not in a git repo, or git not available
    _worktreeName = null;
  }

  return _worktreeName;
}

function effectiveRepoRoot(): string {
  return _repoRootOverride ?? detectCwdRepoRoot() ?? SOURCE_REPO_ROOT;
}

function effectiveWorktreeName(): string | null {
  return _worktreeOverride ?? detectWorktree();
}

function configDirForRoot(root: string): string {
  return join(root, "config");
}

// ── Public API ──────────────────────────────────────────────────────

/** Repository root for the targeted daemon instance. */
export function repoRoot(): string {
  return effectiveRepoRoot();
}

/** Base config directory (<repo>/config). */
export function configDir(): string {
  return configDirForRoot(repoRoot());
}

/** External tools directory (<repo>/external-tools). */
export function externalToolsDir(): string {
  return join(repoRoot(), "external-tools");
}

/** Secrets directory — API keys, OAuth tokens. Shared across worktrees. */
export function secretsDir(): string {
  return join(configDir(), "secrets");
}

/** Data directory — conversations, trash. Namespaced by worktree. */
export function dataDir(): string {
  const wt = effectiveWorktreeName();
  return wt
    ? join(configDir(), "data", "instances", wt)
    : join(configDir(), "data");
}

/** Storage directory — cron scripts, docs. Persistent user-local files. */
export function storageDir(): string {
  return join(configDir(), "storage");
}

/** Runtime dir for socket, PID, logs, usage. Namespaced by worktree. */
export function runtimeDir(): string {
  const wt = effectiveWorktreeName();
  return wt
    ? join(configDir(), "runtime", wt)
    : join(configDir(), "runtime");
}

/** Full path to the daemon socket. */
export function socketPath(): string {
  return join(runtimeDir(), "exocortexd.sock");
}

/** Full path to the daemon PID file. */
export function pidPath(): string {
  return join(runtimeDir(), "exocortexd.pid");
}

/** Conversations directory. Isolated per worktree to prevent data conflicts. */
export function conversationsDir(): string {
  return join(dataDir(), "conversations");
}

/** Trash directory for soft-deleted conversations. Isolated per worktree. */
export function trashDir(): string {
  return join(dataDir(), "trash");
}

/** The effective worktree name, including any CLI override. */
export function worktreeName(): string | null {
  return effectiveWorktreeName();
}

/** Override the detected worktree instance for this process. */
export function setWorktreeOverride(name: string | null): void {
  _worktreeOverride = name && name.trim() ? name.trim() : null;
}

/** Override the targeted repo root for this process. */
export function setRepoRootOverride(path: string | null): void {
  _repoRootOverride = path && path.trim() ? resolve(path.trim()) : null;
}

/** Return the explicit worktree override, if any. */
export function worktreeOverride(): string | null {
  return _worktreeOverride;
}

/** Return the explicit repo root override, if any. */
export function repoRootOverride(): string | null {
  return _repoRootOverride;
}

/** Source checkout root containing the shared exo-cli code. */
export function sourceRepoRoot(): string {
  return SOURCE_REPO_ROOT;
}
