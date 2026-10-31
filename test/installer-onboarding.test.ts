import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseArguments, runInstaller } from "../packages/create-dsh-action/src/installer.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-cli-onboarding-"));
  roots.push(root);
  await writeFile(join(root, "README.md"), "existing repository content\n");
  const templates = join(root, "templates");
  await mkdir(templates);
  for (const kind of ["review", "commands", "session"]) {
    const source = await readFile(
      new URL(`../packages/create-dsh-action/src/templates/dsh-${kind}.yml`, import.meta.url),
      "utf8",
    );
    const pinned = source.replace(
      "__DSH_ACTION_RELEASE_SHA__",
      "0123456789abcdef0123456789abcdef01234567",
    );
    await writeFile(
      join(templates, `dsh-${kind}.yml`),
      pinned.replace("# __DSH_MODE_INPUT__", "# controlled"),
    );
    await writeFile(
      join(templates, `dsh-${kind}-native.yml`),
      pinned.replace("# __DSH_MODE_INPUT__", "dsh-mode: native"),
    );
  }
  let output = "";
  return {
    root,
    templates,
    output: new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    }),
    text: () => output,
  };
}

describe("installer terminal onboarding", () => {
  it("defaults empty terminal choices to read-only Review and Controlled", async () => {
    const f = await fixture();
    const result = await runInstaller({
      argv: [],
      cwd: f.root,
      isTTY: true,
      env: { DSH_HOME: join(f.root, "empty-home") },
      input: Readable.from(["\n\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    expect(result).toEqual({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [
        ".github/workflows/dsh-review.yml",
        ".dsh/package.json",
        ".dsh/cordis.patch.yml",
      ],
    });
    expect(f.text()).toContain("Selection [1-4, default 1]");
    expect(f.text()).toContain("Selection [1-2, default 1]");
    expect(f.text()).toContain("Add DEEPSEEK_API_KEY");
    expect(await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8")).toContain(
      'allow-write: "false"',
    );
    expect(await readFile(join(f.root, "README.md"), "utf8")).toBe("existing repository content\n");
    expect((await readdir(f.root)).sort()).toEqual([".dsh", ".github", "README.md", "templates"]);
  });

  it("retries invalid terminal choices and installs the selected workflows", async () => {
    const f = await fixture();
    const result = await runInstaller({
      argv: [],
      cwd: f.root,
      isTTY: true,
      env: { DSH_HOME: join(f.root, "empty-home") },
      input: Readable.from(["unknown\n3\nunknown\n2\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    expect(result).toMatchObject({ mode: "both", dshMode: "native" });
    expect(result.createdFiles).toEqual([
      ".github/workflows/dsh-review.yml",
      ".github/workflows/dsh-commands.yml",
      ".dsh/package.json",
      ".dsh/cordis.patch.yml",
    ]);
    expect(f.text()).toContain("Please enter 1, 2, 3, or 4.");
    expect(f.text()).toContain("Please enter 1 or 2.");
  });

  it("preserves --advanced terminal composition selection with an explicit workflow mode", async () => {
    const f = await fixture();
    const result = await runInstaller({
      argv: ["--advanced", "--mode", "review"],
      cwd: f.root,
      isTTY: true,
      env: { DSH_HOME: join(f.root, "empty-home") },
      input: Readable.from(["2\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    expect(result).toMatchObject({ mode: "review", dshMode: "native" });
    expect(f.text()).not.toContain("Choose what to install");
    expect(f.text()).toContain("Choose the DSH mode");
  });

  it("does not read terminal input for explicit --mode generation", async () => {
    const f = await fixture();
    let read = false;
    await runInstaller({
      argv: ["--mode", "review"],
      cwd: f.root,
      isTTY: true,
      env: { DSH_HOME: join(f.root, "empty-home") },
      input: new Readable({
        read() {
          read = true;
          this.destroy(new Error("Unexpected prompt"));
        },
      }),
      output: f.output,
      templateDirectory: f.templates,
    });
    expect(read).toBe(false);
    expect(f.text()).not.toContain("Selection");
  });

  it("fails before writing files when terminal choices end early", async () => {
    const f = await fixture();
    await expect(
      runInstaller({
        argv: [],
        cwd: f.root,
        isTTY: true,
        env: { DSH_HOME: join(f.root, "empty-home") },
        input: Readable.from(["1\n"]),
        output: f.output,
        templateDirectory: f.templates,
      }),
    ).rejects.toThrow("Interactive input ended");
    expect((await readdir(f.root)).sort()).toEqual(["README.md", "templates"]);
  });

  it.each(["--gui", "--no-open"])("rejects removed browser option %s", (flag) => {
    expect(() => parseArguments([flag])).toThrow(`Unknown argument: ${flag}`);
  });
});
