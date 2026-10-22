import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInstaller } from "../packages/create-deepseek-harness-action/src/installer.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "dsh-gui-dispatch-"));
  roots.push(root);
  await writeFile(join(root, "README.md"), "existing repository content\n");
  return root;
}
function io() {
  let inputRead = false;
  let output = "";
  return {
    input: new Readable({
      read() {
        inputRead = true;
        this.destroy(new Error("No terminal questions"));
      },
    }),
    output: new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    }),
    wasRead: () => inputRead,
    text: () => output,
  };
}
function gui() {
  const session = {
    origin: "http://127.0.0.1:1",
    token: "fixture-token",
    url: "http://127.0.0.1:1/#token=fixture-token",
    close: vi.fn(() => Promise.resolve()),
  };
  return { session, launch: vi.fn(() => Promise.resolve(session)) };
}

describe("installer browser onboarding", () => {
  it("hands the repository to the GUI without reading Secrets or creating, committing or pushing files", async () => {
    const root = await project();
    const streams = io();
    const browser = gui();
    const result = await runInstaller({
      argv: [],
      cwd: root,
      isTTY: true,
      env: {},
      ...streams,
      guiLauncher: browser.launch,
    });
    expect(result.gui).toBe(browser.session);
    expect(result.createdFiles).toEqual([]);
    expect(browser.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: root, dshMode: "controlled", openBrowser: true }),
    );
    expect(browser.session.close).not.toHaveBeenCalled();
    expect(streams.wasRead()).toBe(false);
    expect(streams.text()).not.toMatch(/Secret value|commit|push|Selection/u);
    expect(await readdir(root)).toEqual(["README.md"]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("existing repository content\n");
  });

  it.each(["--gui", "--advanced", "--no-open"])(
    "supports explicit %s without a TTY",
    async (flag) => {
      const root = await project();
      const browser = gui();
      await runInstaller({
        argv: [flag],
        cwd: root,
        isTTY: false,
        env: {},
        ...io(),
        guiLauncher: browser.launch,
      });
      expect(browser.launch).toHaveBeenCalledWith(
        expect.objectContaining({ openBrowser: flag !== "--no-open" }),
      );
      expect(await readdir(root)).toEqual(["README.md"]);
    },
  );

  it("opens plugin selection without discovering or importing plugins before the page is used", async () => {
    const root = await project();
    const browser = gui();
    const home = join(root, "not-read-before-browser");
    await runInstaller({
      argv: ["--gui", "--import-plugins", "--dsh-home", home, "--dsh-mode", "native"],
      cwd: root,
      isTTY: false,
      env: {},
      ...io(),
      guiLauncher: browser.launch,
    });
    expect(browser.launch).toHaveBeenCalledWith(
      expect.objectContaining({ dshMode: "native", dshHome: home, importPlugins: true }),
    );
    expect(await readdir(root)).toEqual(["README.md"]);
  });

  it("reports a GUI startup failure without falling back to a terminal flow or writing files", async () => {
    const root = await project();
    const streams = io();
    await expect(
      runInstaller({
        argv: [],
        cwd: root,
        isTTY: true,
        env: {},
        ...streams,
        guiLauncher: () => Promise.reject(new Error("loopback unavailable")),
      }),
    ).rejects.toThrow("loopback unavailable");
    expect(streams.wasRead()).toBe(false);
    expect(await readdir(root)).toEqual(["README.md"]);
  });

  it("keeps CI generation explicit and never starts a GUI in CI", async () => {
    const root = await project();
    const browser = gui();
    await expect(
      runInstaller({
        argv: ["--gui"],
        cwd: root,
        isTTY: true,
        env: { CI: "true" },
        ...io(),
        guiLauncher: browser.launch,
      }),
    ).rejects.toThrow("Use --mode for CI");
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it("preserves noninteractive --mode generation without launching the GUI", async () => {
    const root = await project();
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
        .replace("# __DSH_MODE_INPUT__", "# controlled"),
    );
    const browser = gui();
    const streams = io();
    const result = await runInstaller({
      argv: ["--mode", "review"],
      cwd: root,
      isTTY: true,
      env: {},
      ...streams,
      templateDirectory: templates,
      guiLauncher: browser.launch,
    });
    expect(browser.launch).not.toHaveBeenCalled();
    expect(result.createdFiles).toEqual([".github/workflows/dsh-review.yml"]);
    expect(streams.wasRead()).toBe(false);
    expect(streams.text()).toContain("Add DEEPSEEK_API_KEY");
  });
});
