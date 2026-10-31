import { z } from "zod";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runInstaller } from "../packages/create-dsh-action/src/installer.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-import-"));
  roots.push(root);
  const home = join(root, "home");
  const profile = join(home, "profiles", "default");
  const installed = join(profile, "node_modules", "example-bundle");
  await mkdir(installed, { recursive: true });
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: { "example-bundle": "^1.2.0" },
      dsh: { profile: { bundles: ["example-bundle"] } },
    }),
  );
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({
      name: "example-bundle",
      version: "1.2.3",
      engines: { dsh: ">=0.2.1-rc.1 <0.3.0" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  await writeFile(join(home, ".credentials.yaml"), "PRIVATE_LOCAL_KEY_MUST_STAY_LOCAL");
  await writeFile(
    join(profile, "cordis.patch.yml"),
    "- id: system-prompt\n  config: {personaPrefix: IMPORTED_PROFILE_PROMPT}\n",
  );
  const templates = join(root, "templates");
  await mkdir(templates);
  const source = await readFile(
    new URL("../packages/create-dsh-action/src/templates/dsh-review.yml", import.meta.url),
    "utf8",
  );
  const pinned = source.replace(
    "__DSH_ACTION_RELEASE_SHA__",
    "0123456789abcdef0123456789abcdef01234567",
  );
  await writeFile(
    join(templates, "dsh-review-native.yml"),
    pinned.replace("# __DSH_MODE_INPUT__", "dsh-mode: native"),
  );
  await writeFile(
    join(templates, "dsh-review.yml"),
    pinned.replace("# __DSH_MODE_INPUT__", "# controlled"),
  );
  const commands = await readFile(
    new URL("../packages/create-dsh-action/src/templates/dsh-commands.yml", import.meta.url),
    "utf8",
  );
  await writeFile(
    join(templates, "dsh-commands.yml"),
    commands
      .replace("__DSH_ACTION_RELEASE_SHA__", "0123456789abcdef0123456789abcdef01234567")
      .replace("# __DSH_MODE_INPUT__", "# controlled"),
  );
  let output = "";
  return {
    root,
    home,
    installed,
    templates,
    output: new Writable({
      write(chunk, _encoding, next) {
        output += String(chunk);
        next();
      },
    }),
    text: () => output,
  };
}

describe("native Profile import through the installer", () => {
  async function install(
    f: Awaited<ReturnType<typeof fixture>>,
    dshMode: "controlled" | "native",
    answer = "1\ny\n",
    mode = "review",
  ) {
    return runInstaller({
      argv: ["--mode", mode, "--dsh-mode", dshMode, "--import-plugins", "--dsh-home", f.home],
      cwd: f.root,
      isTTY: true,
      env: {},
      input: Readable.from([answer]),
      output: f.output,
      templateDirectory: f.templates,
    });
  }
  it("moves dependencies and native configuration together while preserving Controller write gates", async () => {
    const f = await fixture();
    await install(f, "controlled", "1\ny\n", "both");
    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()),
        dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }) }),
      })
      .parse(JSON.parse(await readFile(join(f.root, ".dsh/package.json"), "utf8")));
    expect(manifest.dependencies).toEqual({ "example-bundle": "1.2.3" });
    expect(manifest.dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-headless",
      "example-bundle",
    ]);
    expect(await readFile(join(f.root, ".dsh/cordis.patch.yml"), "utf8")).toContain(
      "IMPORTED_PROFILE_PROMPT",
    );
    const commands = await readFile(join(f.root, ".github/workflows/dsh-commands.yml"), "utf8");
    expect(commands).toContain('allow-write: "true"');
    expect(commands).toContain('run-tests: "true"');
    expect(commands).not.toContain("plugin-config");
  });
  it("creates a fresh Profile when local import is declined", async () => {
    const f = await fixture();
    await install(f, "native", "1\nn\n");
    expect(await readFile(join(f.root, ".dsh/package.json"), "utf8")).not.toContain(
      "example-bundle",
    );
  });
  it("retains Controlled policy in the native patch rather than workflow JSON", async () => {
    const f = await fixture();
    await writeFile(
      join(f.home, "profiles/default/cordis.patch.yml"),
      JSON.stringify([
        {
          id: "dsh-action-policy",
          config: {
            allowedTools: ["plugin.audit.scan"],
            rules: [
              {
                id: "plugin.audit.scan",
                runtimeName: "plugin__audit__scan",
                permissions: ["read"],
              },
            ],
          },
        },
      ]),
    );
    await install(f, "controlled");
    expect(await readFile(join(f.root, ".dsh/cordis.patch.yml"), "utf8")).toContain(
      "plugin.audit.scan",
    );
    expect(await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8")).not.toContain(
      "allowed-tools",
    );
  });
  it("reports incompatible dependencies without creating workflow or Profile", async () => {
    const f = await fixture();
    await writeFile(
      join(f.installed, "package.json"),
      JSON.stringify({ name: "example-bundle", version: "1.2.3", engines: { dsh: "<0.2.0" } }),
    );
    await expect(install(f, "controlled", "1\n")).rejects.toThrow("blocked fields");
    expect(f.text()).toContain("Incompatible");
    await expect(readFile(join(f.root, ".dsh/package.json"))).rejects.toThrow();
    await expect(readFile(join(f.root, ".github/workflows/dsh-review.yml"))).rejects.toThrow();
  });
  it("imports native configuration without copying local credentials or running plugins", async () => {
    const f = await fixture();
    await install(f, "native");
    const profile = await readFile(join(f.root, ".dsh/cordis.patch.yml"), "utf8");
    expect(profile).toContain("IMPORTED_PROFILE_PROMPT");
    expect(profile + f.text()).not.toContain("PRIVATE_LOCAL_KEY");
    expect(await readFile(join(f.home, ".credentials.yaml"), "utf8")).toBe(
      "PRIVATE_LOCAL_KEY_MUST_STAY_LOCAL",
    );
    expect(
      parse(await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8")),
    ).toBeDefined();
  });
});
