import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { version } from "../package.json";
import { cliEntry, runCli } from "./test-utils";

describe("CLI release entrypoints", () => {
  test("source and platform launcher print version without connecting", async () => {
    expect(await runCli(["--version"])).toMatchObject({ code: 0, output: `exo ${version}\n` });
    const launcher = resolve(import.meta.dir, process.platform === "win32" ? "../bin/exo.cmd" : "../bin/exo");
    const result = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", `""${launcher}" --version"`], { encoding: "utf8", windowsVerbatimArguments: true, timeout: 10_000 })
      : spawnSync(launcher, ["--version"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`exo ${version}`);
  });

  test("freshly generated bundle prints the same version", async () => {
    const root = await mkdtemp(join(tmpdir(), "exo-bundle-"));
    try {
      const result = await Bun.build({ entrypoints: [cliEntry], target: "bun", outdir: root });
      expect(result.success).toBe(true);
      expect(await runCli(["--version"], "", result.outputs[0].path)).toMatchObject({
        code: 0, output: `exo ${version}\n`,
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
