/**
 * @exocortex/shared — Path resolution for the default Exocortex daemon.
 *
 * By default, all paths resolve to the main source checkout. The only way to
 * target a different daemon instance is an explicit CLI override (for example
 * `--instance <name>` wired up by the caller).
 *
 * Directory layout under <repo>/config/:
 *
 *   config root/        system.md, theme.json (tracked config)
 *   secrets/            env, credentials.json (never tracked)
 *   data/               conversations/, trash/ (bulk data, never tracked)
 *   runtime/            PID, socket, logs, usage.json (ephemeral)
 *   storage/            cron/, fix-auth.md (persistent user-local, not tracked)
 *
 * When an explicit worktree override is set, runtime paths (socket, PID, logs)
 * and data paths (conversations) are namespaced by worktree name. Secrets are
 * still shared across instances.
 */

import { join, resolve } from "path";

// ── Repo root ───────────────────────────────────────────────────────
// This file lives at <repo>/external-tools/exo-cli/src/shared/paths.ts
// — four levels up is the source repo root.

const SOURCE_REPO_ROOT = resolve(import.meta.dir, "../../../..");

// ── Explicit overrides ───────────────────────────────────────────────

let _worktreeOverride: string | null = null;
let _repoRootOverride: string | null = null;

function effectiveRepoRoot(): string {
  return _repoRootOverride ?? SOURCE_REPO_ROOT;
}

function effectiveWorktreeName(): string | null {
  return _worktreeOverride;
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

/** Override the targeted worktree instance for this process. */
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
