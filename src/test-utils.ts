import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection } from "./conn";
import { setRepoRootOverride, setWorktreeOverride, socketPath } from "./shared/paths";
import type { Command, Event } from "./shared/protocol";

export const cliEntry = resolve(import.meta.dir, "main.ts");
export const options = { json: true, full: false, stream: false, idOnly: false, timeout: 2000 };

export async function capture(run: () => Promise<unknown>) {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let output = "", errors = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof stdout;
  process.stderr.write = ((chunk: unknown) => { errors += String(chunk); return true; }) as typeof stderr;
  try { return { value: await run(), output, errors }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

/** Unique temporary socket/pipe and config. Never uses the live daemon endpoint. */
export async function withDaemon(
  handler: (command: Command, socket: Socket) => void,
  run: (fixture: { conn: Connection; args: string[]; commands: Command[] }) => Promise<void>,
) {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ecli-"));
  const instance = `t${Math.random().toString(36).slice(2, 8)}`;
  const previousConfig = process.env.EXOCORTEX_CONFIG_DIR;
  process.env.EXOCORTEX_CONFIG_DIR = join(root, "c");
  setRepoRootOverride(root);
  setWorktreeOverride(instance);
  const endpoint = socketPath();
  await mkdir(join(root, "c/runtime", instance), { recursive: true });
  const sockets = new Set<Socket>();
  const commands: Command[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", data => {
      buffer += data;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const command = JSON.parse(buffer.slice(0, index)) as Command;
        buffer = buffer.slice(index + 1);
        commands.push(command);
        handler(command, socket);
      }
    });
  });
  const conn = new Connection();
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(endpoint, done);
    });
    await conn.connect();
    await run({ conn, commands, args: ["--repo-root", root, "--instance", instance] });
  } finally {
    conn.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
    setRepoRootOverride(null);
    setWorktreeOverride(null);
    if (previousConfig === undefined) delete process.env.EXOCORTEX_CONFIG_DIR;
    else process.env.EXOCORTEX_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
}

export function emit(socket: Socket, event: Event) {
  socket.write(JSON.stringify(event) + "\n");
}

export async function runCli(args: string[], input = "audit 🐋 café", entry = cliEntry) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, EXOCORTEX_PARENT_CONV_ID: "" },
  });
  child.stdin.write(input);
  child.stdin.end();
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { output, errors, code };
}
