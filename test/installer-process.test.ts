import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runProcess } from "../packages/create-deepseek-harness-action/src/process.mjs";

const fixture = fileURLToPath(new URL("fixtures/installer-process-tool.mjs", import.meta.url));
let suite = "";
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
beforeAll(async () => {
  suite = await mkdtemp(join(tmpdir(), "dsh-installer-process-"));
});
afterAll(async () => {
  if (suite) await rm(suite, { recursive: true, force: true });
});

describe("installer process transport", () => {
  it.each(["checkout", "worktree"])(
    "ignores repository and relative PATH shadows in a %s",
    async (kind) => {
      const root = await mkdtemp(join(suite, "trusted-tools-"));
      if (kind === "checkout") await mkdir(join(root, ".git"));
      else await writeFile(join(root, ".git"), "gitdir: ../fixture-worktree\n");
      const nested = join(root, "nested");
      await mkdir(nested);
      for (const name of ["node.exe", "node", "taskkill.exe"])
        await writeFile(join(root, name), "Not an executable.\n");
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
      );
      environment[process.platform === "win32" ? "Path" : "PATH"] = [
        root,
        "",
        "relative-bin",
        dirname(process.execPath),
        process.env[pathKey] ?? "",
      ].join(delimiter);
      const result = await runProcess(
        "node",
        [
          "-e",
          "process.stdout.write(JSON.stringify({executable:process.argv0,cwd:process.cwd()}))",
        ],
        { cwd: nested, env: environment },
      );
      expect(result.exitCode).toBe(0);
      const observed = z
        .object({ executable: z.string(), cwd: z.string() })
        .parse(JSON.parse(result.stdout));
      expect(isAbsolute(observed.executable)).toBe(true);
      expect(observed.executable.startsWith(root)).toBe(false);
      expect(observed.cwd).toBe(nested);
    },
  );
  it("rejects tools when PATH contains only repository or relative entries", async () => {
    const root = await mkdtemp(join(suite, "untrusted-path-"));
    await writeFile(join(root, "node.exe"), "Not executable\n");
    expect(
      await runProcess("node", ["-e", "process.exit(99)"], {
        cwd: root,
        env: { PATH: [root, "", "relative-bin"].join(delimiter) },
      }),
    ).toMatchObject({ exitCode: 1, failure: "tool_unavailable" });
  });
  it.each(process.platform === "win32" ? ["stall", "overflow"] : ["stall", "overflow", "orphan"])(
    "bounds a real %s process and its pipe-holding descendants",
    async (mode) => {
      const root = await mkdtemp(join(suite, `${mode}-`));
      await writeFile(
        join(root, "taskkill.exe"),
        "Not executable; cleanup must use the host tool.\n",
      );
      const pidFile = join(root, "fixture-pids.json");
      try {
        const started = Date.now();
        const result = await runProcess(process.execPath, [fixture, mode, pidFile], {
          cwd: root,
          timeoutMs: 500,
        });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result).toMatchObject({
          exitCode: 1,
          failure: mode === "overflow" ? "output_limit" : "timeout",
        });
        const pids = z
          .array(z.number().int().positive())
          .parse(JSON.parse(await readFile(pidFile, "utf8")));
        for (let attempt = 0; attempt < 20 && pids.some(running); attempt += 1) await delay(50);
        expect(pids.filter(running)).toEqual([]);
      } finally {
        const pids = z
          .array(z.number().int().positive())
          .parse(JSON.parse(await readFile(pidFile, "utf8").catch(() => "[]")));
        for (const pid of pids.reverse()) if (running(pid)) process.kill(pid, "SIGKILL");
      }
    },
  );
});
