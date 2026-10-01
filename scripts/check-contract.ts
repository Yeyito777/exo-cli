/** Compile-time compatibility against the actual daemon, without running it. */
import ts from "typescript";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "..");
const daemon = resolve(process.env.EXOCORTEX_SOURCE_DIR ?? join(cli, "../.."));
const authoritative = join(daemon, "shared/src/protocol.ts");
if (!existsSync(authoritative)) {
  throw new Error("Set EXOCORTEX_SOURCE_DIR to an Exocortex checkout to check the wire contract");
}
const temporary = mkdtempSync(join(tmpdir(), "exo-contract-"));
try {
  const file = join(temporary, "contract.ts");
  const modulePath = (path: string) => JSON.stringify(path.replace(/\\/g, "/").replace(/\.ts$/, ""));
  const kinds = [...new Set([...readFileSync(join(cli, "src/shared/protocol.ts"), "utf8").matchAll(/\btype:\s*"([^"]+)"/g)].map(match => match[1]))];
  writeFileSync(file, `
import type { Command as CLICommand, Event as CLIEvent } from ${modulePath(join(cli, "src/shared/protocol.ts"))};
import type { Command as DaemonCommand, Event as DaemonEvent } from ${modulePath(authoritative)};
type Assert<T extends true> = T;
type Outbound = Assert<CLICommand extends DaemonCommand ? true : false>;
type Inbound = Assert<Extract<DaemonEvent, { type: CLIEvent["type"] }> extends CLIEvent ? true : false>;
declare const incoming: Extract<DaemonEvent, { type: CLIEvent["type"] }>;
const receiveCheck: CLIEvent = incoming;
type AllEventNamesExist = Assert<CLIEvent["type"] extends DaemonEvent["type"] ? true : false>;
${kinds.map((kind, index) => `const event_${index}: Extract<CLIEvent, {type: ${JSON.stringify(kind)}}> = {} as Extract<DaemonEvent, {type: ${JSON.stringify(kind)}}>;`).join("\n")}
`);
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    skipLibCheck: true, noEmit: true, resolveJsonModule: true,
    types: ["bun"], typeRoots: [join(cli, "node_modules/@types")],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: path => path, getCurrentDirectory: () => cli,
      getNewLine: () => "\n",
    }));
    process.exitCode = 1;
  } else console.log("CLI commands/events are compatible with the current daemon wire contract.");
} finally { rmSync(temporary, { recursive: true, force: true }); }
