import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runInstaller } from "../packages/create-dsh-action/src/installer.mjs";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("previews a full native Profile without writes, then imports settings and Secret references", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-import-"));
  roots.push(root);
  const home = join(root, "home"),
    profile = join(home, "profiles", "chosen"),
    project = join(root, "repo"),
    templates = join(root, "templates");
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(project), mkdir(templates)]);
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
      dependencies: {},
    }),
  );
  await writeFile(
    join(profile, "cordis.patch.yml"),
    '- id: agent-default-model\n  config: {provider: deepseek-official, model: chosen-model}\n- insert:\n  - id: remote-mcp\n    name: "@deepseek-ai/dsh-mcp-client"\n    config:\n      serverName: remote\n      transport: streamable-http\n      url: https://example.test/mcp\n      headers: {Authorization: "Bearer local-secret-never-copy"}\n',
  );
  await writeFile(
    join(home, "cordis.patch.yml"),
    "- id: system-prompt\n  config: {personaPrefix: project prompt}\n",
  );
  await writeFile(
    join(templates, "dsh-review.yml"),
    "name: test\non: workflow_dispatch\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: Lixiaoyiao/DSH-action@" +
      "a".repeat(40) +
      "\n        with:\n          permission-profile: strict\n",
  );
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  const argv = ["--mode", "review", "--dsh-home", home, "--import-profile", "chosen", "--yes"];
  await runInstaller({
    cwd: project,
    templateDirectory: templates,
    argv: [...argv, "--dry-run"],
    output: sink,
    isTTY: false,
    env: {},
  });
  expect(await readdir(project)).toEqual([]);
  await runInstaller({
    cwd: project,
    templateDirectory: templates,
    argv,
    output: sink,
    isTTY: false,
    env: {},
  });
  const native = await readFile(join(project, ".dsh", "cordis.patch.yml"), "utf8");
  expect(native).toContain("chosen-model");
  expect(native).toContain("project prompt");
  expect(native).toContain("!!js");
  expect(native + output).not.toContain("local-secret-never-copy");
  expect(await readFile(join(project, ".github/workflows/dsh-review.yml"), "utf8")).toContain(
    "secrets.HARNESS_",
  );
  const blockedProject = join(root, "blocked-repo");
  await mkdir(blockedProject);
  await writeFile(
    join(profile, "prompt.txt"),
    "A referenced resource with local-secret-never-copy",
  );
  const original = await readFile(join(profile, "cordis.patch.yml"), "utf8");
  await writeFile(
    join(profile, "cordis.patch.yml"),
    original + "- id: custom-prompt\n  config: {promptFile: ./prompt.txt}\n",
  );
  await expect(
    runInstaller({
      cwd: blockedProject,
      templateDirectory: templates,
      argv,
      output: sink,
      isTTY: false,
      env: {},
    }),
  ).rejects.toThrow(/blocked fields/);
  expect(await readdir(blockedProject)).toEqual([]);
  expect(output).not.toContain("local-secret-never-copy");
});
