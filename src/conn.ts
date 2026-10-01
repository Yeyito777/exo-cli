/**
 * Promise-based daemon client for the CLI.
 *
 * Unlike the TUI's event-driven client, every operation here is
 * request/response: connect, send a command, wait for matching
 * event(s), return. Stateless — each CLI invocation creates a
 * fresh connection and tears it down when done.
 */

import { connect, type Socket } from "net";
import { existsSync } from "fs";
import { StringDecoder } from "node:string_decoder";
import { socketPath, worktreeName } from "./shared/paths";
import type { Command, Event } from "./shared/protocol";

export class Connection {
  private socket: Socket | null = null;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private listeners: Array<(event: Event) => void> = [];
  private disconnectListeners = new Set<(error: Error) => void>();

  /** Connect to the daemon. Throws if socket doesn't exist or connection fails. */
  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket) throw new Error("Already connected");
    const path = socketPath();
    const instance = worktreeName();
    // Windows named pipes are kernel objects and never appear in the filesystem.
    // Let connect() report an absent pipe instead of rejecting every valid pipe.
    if (process.platform !== "win32" && !existsSync(path)) {
      const target = instance ? ` for instance '${instance}'` : "";
      throw new Error(
        `exocortexd socket${target} not found. Is the daemon running?\n` +
        "Start it with: cd daemon && bun run start"
      );
    }

    return new Promise((resolve, reject) => {
      const socket = connect(path);
      let resolved = false;
      let failed = false;
      const timer = setTimeout(() => {
        reject(new Error("Timeout connecting to exocortexd"));
        socket.destroy();
      }, timeoutMs);

      socket.on("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.buffer = "";
        this.decoder = new StringDecoder("utf8");
        resolved = true;
        resolve();
      });
      socket.on("data", (data) => {
        if (this.socket === socket) this.onData(data);
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        failed = true;
        const error = new Error(`Connection failed: ${err.message}`);
        if (!resolved) reject(error);
        else this.connectionLost(socket, error);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!resolved) reject(new Error("Connection closed before connecting"));
        else if (!failed) this.connectionLost(socket, new Error("Connection to exocortexd closed"));
      });
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.connectionLost(socket, new Error("Disconnected from exocortexd"));
    socket.end();
    socket.unref();
  }

  /** Send a command to the daemon. */
  send(command: Command): void {
    if (!this.socket) throw new Error("Not connected");
    this.socket.write(JSON.stringify(command) + "\n");
  }

  /** Register a listener for all incoming events. */
  onEvent(listener: (event: Event) => void): void {
    this.listeners.push(listener);
  }

  /** Remove a previously registered listener. */
  offEvent(listener: (event: Event) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  onDisconnect(listener: (error: Error) => void): void {
    this.disconnectListeners.add(listener);
  }

  offDisconnect(listener: (error: Error) => void): void {
    this.disconnectListeners.delete(listener);
  }

  /**
   * Send a command and wait for a single event matching the predicate.
   * Returns the matched event. Rejects on timeout or error events.
   */
  request<T extends Event>(
    command: Command,
    match: (event: Event) => event is T,
    timeoutMs = 10_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for response to ${command.type}`));
      }, timeoutMs);

      const handler = (event: Event) => {
        // Match error events to this request by reqId
        if (event.type === "error" && event.reqId && event.reqId === command.reqId) {
          cleanup();
          reject(new Error(event.message));
          return;
        }
        try {
          if (match(event)) {
            cleanup();
            resolve(event);
          }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      const fail = (error: Error) => { cleanup(); reject(error); };

      const cleanup = () => {
        clearTimeout(timer);
        this.offEvent(handler);
        this.offDisconnect(fail);
      };

      this.onEvent(handler);
      this.onDisconnect(fail);
      try { this.send(command); } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // ── Internal ────────────────────────────────────────────────────

  private connectionLost(socket: Socket, error: Error): void {
    // A late close from an old connection must not tear down a reconnected one.
    if (this.socket !== socket) return;
    this.socket = null;
    for (const listener of [...this.disconnectListeners]) listener(error);
  }

  private onData(data: Buffer | string): void {
    this.buffer += typeof data === "string" ? data : this.decoder.write(data);

    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let event: Event;
      try { event = JSON.parse(line) as Event; } catch {
        // Malformed event — skip
        continue;
      }
      if (!event || typeof event.type !== "string") continue;
      // Listener exceptions are not malformed JSON. Operations handle their own
      // callback failures so they reject and clean up rather than timing out.
      for (const listener of [...this.listeners]) listener(event);
    }
  }
}
