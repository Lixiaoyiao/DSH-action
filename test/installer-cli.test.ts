import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArguments,
  runInstaller,
} from "../packages/create-deepseek-harness-action/src/installer.mjs";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-cli-"));
  roots.push(root);
  await writeFile(join(root, "README.md"), "user owned\n");
  const templates = join(root, "templates");
  await mkdir(templates);
  const source = await readFile(
    new URL(
      "../packages/create-deepseek-harness-action/src/templates/dsh-review.yml",
      import.meta.url,
    ),
    "utf8",
  );
  await writeFile(
    join(templates, "dsh-review.yml"),
    source
      .replace("__DSH_ACTION_RELEASE_SHA__", "0123456789abcdef0123456789abcdef01234567")
      .replace("# __DSH_MODE_INPUT__", ""),
  );
  return { root, templates };
}
function io() {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  const input = new Readable({
    read() {
      this.destroy(new Error("Installer must not read stdin"));
    },
  });
  return { input, output, text: () => text };
}
describe("CLI-only onboarding", () => {
  it("generates safe Review without flags on a TTY; does not read stdin", async () => {
    const { root, templates } = await fixture();
    const streams = io();
    const result = await runInstaller({
      argv: [],
      cwd: root,
      templateDirectory: templates,
      isTTY: true,
      env: {},
      ...streams,
    });
    expect(result).toMatchObject({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    const workflow = await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8");
    expect(workflow).toContain('allow-write: "false"');
    expect(workflow).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(streams.text()).toContain("Add DEEPSEEK_API_KEY");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("user owned\n");
  });
  it.each(["--gui", "--no-open", "--advanced", "--import-plugins"])(
    "rejects removed browser flag %s",
    (flag) => {
      expect(() => parseArguments([flag])).toThrow("Unknown argument");
    },
  );
  it("never overwrites an existing YAML and leaves unrelated files intact", async () => {
    const { root, templates } = await fixture();
    await runInstaller({
      argv: ["--mode", "review"],
      cwd: root,
      templateDirectory: templates,
      isTTY: false,
      env: {},
      ...io(),
    });
    await expect(
      runInstaller({
        argv: [],
        cwd: root,
        templateDirectory: templates,
        isTTY: true,
        env: {},
        ...io(),
      }),
    ).rejects.toThrow("Refusing to overwrite");
    expect(await readdir(root)).toEqual([".github", "README.md", "templates"]);
  });
});
