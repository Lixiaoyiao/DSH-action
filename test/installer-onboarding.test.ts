import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInstaller } from "../packages/create-deepseek-harness-action/src/installer.mjs";
import {
  runProcess,
  type ProcessResult,
} from "../packages/create-deepseek-harness-action/src/process.mjs";

const exec = promisify(execFile);
const releaseSha = "0123456789abcdef0123456789abcdef01234567";
let suite = "";
let templates = "";
class Capture extends Writable {
  text = "";
  onChunk?: (text: string) => void;
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.text += chunk.toString();
    this.onChunk?.(chunk.toString());
    done();
  }
}
class TerminalInput extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(raw: boolean) {
    this.raw = raw;
    return this;
  }
}
interface Call {
  command: string;
  gitOperation?: string;
  args: readonly string[];
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}
async function project() {
  const root = await mkdtemp(join(suite, "repo-"));
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["config", "user.name", "Installer Test"], { cwd: root });
  await exec("git", ["config", "user.email", "installer@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "Fixture"], { cwd: root });
  await exec("git", ["remote", "add", "origin", "https://github.com/example/sample.git"], {
    cwd: root,
  });
  return root;
}
async function markerProgram(root: string, name: string, stdout = "") {
  const marker = join(root, `${name}.marker`);
  const program = join(root, `${name}.mjs`);
  await writeFile(
    program,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(process.argv[2], ${JSON.stringify(`${name}\n`)});`,
      `process.stdout.write(${JSON.stringify(stdout)});`,
    ].join("\n"),
  );
  const quote = (path: string) => `"${path.replaceAll("\\", "/")}"`;
  return { marker, command: `${quote(process.execPath)} ${quote(program)} ${quote(marker)}` };
}
function adapters(
  answers: string[],
  settings: {
    login?: boolean;
    secret?: string;
    ghDefaultHost?: string;
    failSecret?: boolean;
    remoteAhead?: boolean;
    remotePublished?: boolean;
    localRemote?: string;
    uncertainCleanup?: boolean;
    gitEnvironment?: NodeJS.ProcessEnv;
    requireGitCredentials?: boolean;
    afterRemoteRead?: (root: string) => Promise<void>;
    afterIndexRead?: (root: string) => Promise<void>;
  } = {},
) {
  const output = new Capture();
  const calls: Call[] = [];
  const ghRepositoryRequests: { operation: string; host: string }[] = [];
  const questions: string[] = [];
  let indexRead = false;
  const processRunner = async (
    command: string,
    args: readonly string[],
    options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<ProcessResult> => {
    let gitOperationIndex = 0;
    while (args[gitOperationIndex] === "-c" || args[gitOperationIndex] === "--no-lazy-fetch") {
      gitOperationIndex += args[gitOperationIndex] === "-c" ? 2 : 1;
    }
    const gitOperation = args[gitOperationIndex];
    calls.push({
      command,
      args,
      ...(command !== "git" || gitOperation === undefined ? {} : { gitOperation }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (command === "gh") {
      if (args[0] === "--version") return { exitCode: 0, stdout: "gh version fixture", stderr: "" };
      if (args[0] === "auth")
        return {
          exitCode: settings.login === false ? 1 : 0,
          stdout: "",
          stderr: "",
          ...(settings.uncertainCleanup ? { termination: "unconfirmed" } : {}),
        };
      const repositoryReference = args[0] === "repo" ? args[2] : args[args.indexOf("--repo") + 1];
      const namespace = args[0];
      const operation = args[1];
      if (namespace === undefined || operation === undefined)
        throw new Error("Unexpected empty gh operation");
      ghRepositoryRequests.push({
        operation: `${namespace}.${operation}`,
        host:
          repositoryReference === "github.com/example/sample"
            ? "github.com"
            : (settings.ghDefaultHost ?? "github.com"),
      });
      if (args[0] === "repo")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            nameWithOwner: "example/sample",
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      if (args[0] === "secret" && args[1] === "list")
        return { exitCode: 0, stdout: "[]", stderr: "" };
      if (args[0] === "secret" && args[1] === "set")
        return {
          exitCode: settings.failSecret ? 1 : 0,
          stdout: settings.secret ?? "",
          stderr: settings.secret ?? "",
        };
      throw new Error("Unexpected gh operation");
    }
    const gitEnvironment = { ...options.env, ...settings.gitEnvironment };
    if (
      settings.requireGitCredentials &&
      (gitOperation === "ls-remote" || gitOperation === "push")
    ) {
      const authentication = await runProcess(
        "git",
        [...args.slice(0, gitOperationIndex), "credential", "fill"],
        {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: gitEnvironment,
          input: "protocol=https\nhost=github.com\n\n",
          timeoutMs: 3000,
        },
      );
      if (authentication.exitCode !== 0) return { exitCode: 1, stdout: "", stderr: "" };
    }
    if (gitOperation === "push" && settings.localRemote === undefined)
      return { exitCode: 0, stdout: "", stderr: "" };
    if (gitOperation === "ls-remote") {
      const advertised = await exec(
        "git",
        ["rev-parse", settings.remotePublished ? "HEAD" : "HEAD^"],
        { cwd: options.cwd },
      );
      if (options.cwd !== undefined) await settings.afterRemoteRead?.(options.cwd);
      return {
        exitCode: 0,
        stdout: `${settings.remoteAhead ? "f".repeat(40) : advertised.stdout.trim()}\trefs/heads/main\n`,
        stderr: "",
      };
    }
    const localRemote = settings.localRemote;
    const transportArgs =
      gitOperation === "push" && localRemote !== undefined
        ? args.map((argument) => (argument === "origin" ? localRemote : argument))
        : args;
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, [...transportArgs], {
        cwd: options.cwd,
        env:
          settings.localRemote === undefined
            ? gitEnvironment
            : { ...gitEnvironment, GIT_ALLOW_PROTOCOL: "file:https:ssh" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const result = { exitCode: code ?? 1, stdout, stderr };
        if (
          gitOperation === "diff" &&
          code === 0 &&
          !indexRead &&
          options.cwd !== undefined &&
          settings.afterIndexRead !== undefined
        ) {
          indexRead = true;
          void settings.afterIndexRead(options.cwd).then(() => resolve(result), reject);
        } else resolve(result);
      });
      child.stdin.end(options.input);
    });
  };
  const prompter = {
    question(message: string) {
      questions.push(message);
      return Promise.resolve(answers.shift() ?? "n");
    },
    secret() {
      return Promise.resolve(settings.secret ?? "secret-fixture-value");
    },
    close() {
      /* Input adapter has no terminal handles. */
    },
  };
  return { output, calls, ghRepositoryRequests, questions, processRunner, prompter };
}
beforeAll(async () => {
  suite = await mkdtemp(join(tmpdir(), "dsh-guided-test-"));
  const built = join(suite, "dist");
  await exec(
    process.execPath,
    ["packages/create-deepseek-harness-action/scripts/build.mjs", "--output", built],
    { env: { ...process.env, DSH_ACTION_RELEASE_SHA: releaseSha }, windowsHide: true },
  );
  templates = join(built, "templates");
});
afterAll(async () => {
  if (suite) await rm(suite, { recursive: true, force: true });
});
describe("installer guided first run", () => {
  it("binds repository access and Secret setup to github.com despite a different CLI default host", async () => {
    const root = await project();
    // Both hosts expose the same owner/name; nameWithOwner alone cannot bind the host.
    const key = "host-binding-fixture-key";
    const io = adapters(["y", "y", "n"], {
      secret: key,
      ghDefaultHost: "enterprise.example.invalid",
    });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({
      repository: "example/sample",
      secret: "configured",
      committed: false,
      pushed: false,
    });
    expect(io.ghRepositoryRequests).toEqual([
      { operation: "repo.view", host: "github.com" },
      { operation: "secret.list", host: "github.com" },
      { operation: "secret.set", host: "github.com" },
    ]);
    expect(io.output.text).not.toContain(key);
  });
  it("makes actual transport cleanup uncertainty recoverable without printing process output", async () => {
    const root = await project();
    const io = adapters(["y", "n"], { login: false, uncertainCleanup: true });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({
      secret: "login_required",
      committed: false,
      pushed: false,
    });
    expect(io.output.text).toContain("remaining Git/gh processes");
  });
  it("rejects multiple real Git push destinations before any remote publication", async () => {
    const root = await project();
    await exec(
      "git",
      ["config", "--add", "remote.origin.pushurl", "https://github.com/example/sample.git"],
      { cwd: root },
    );
    await exec(
      "git",
      ["config", "--add", "remote.origin.pushurl", "https://github.com/other/unconfirmed.git"],
      { cwd: root },
    );
    const io = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
    expect(io.output.text).toContain("single verified");
  });

  it("preserves its local commit and refuses repository SSH commands before remote transport", async () => {
    const root = await project();
    const privateCommand = "repo-only-helper-private-marker";
    await exec("git", ["config", "core.sshCommand", privateCommand], { cwd: root });
    const io = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(io.calls.some((call) => call.gitOperation === "ls-remote")).toBe(false);
    expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
    expect(io.output.text).toContain("repository-scoped transport");
    expect(io.output.text).not.toContain(privateCommand);
    expect((await exec("git", ["config", "core.sshCommand"], { cwd: root })).stdout.trim()).toBe(
      privateCommand,
    );
  });

  it("refuses repository askpass execution even when terminal prompting is disabled", async () => {
    const root = await project();
    const marker = join(root, "askpass.marker");
    const program = join(root, "askpass.sh");
    const shellMarker = marker.replaceAll("\\", "/").replaceAll("'", "'\\''");
    await writeFile(
      program,
      `#!/bin/sh\nprintf 'askpass\\n' >> '${shellMarker}'\nprintf 'fixture-only-answer\\n'\n`,
      { mode: 0o755 },
    );
    const globalConfig = join(suite, "askpass-empty-global");
    await writeFile(globalConfig, "");
    await exec("git", ["config", "core.askPass", program], { cwd: root });
    const io = adapters(["y", "n", "y", "y"], {
      gitEnvironment: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
      requireGitCredentials: true,
    });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    await expect(readFile(marker)).rejects.toThrow();
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(
      io.calls.some((call) => call.gitOperation === "ls-remote" || call.gitOperation === "push"),
    ).toBe(false);
    expect(io.output.text).not.toContain(program);
  });

  it("fails when promised objects disappear after index inspection without implicit SSH transport", async () => {
    const source = await project();
    await exec("git", ["config", "uploadpack.allowFilter", "true"], { cwd: source });
    await exec("git", ["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: source });
    const root = await mkdtemp(join(suite, "partial-"));
    await exec("git", [
      "-c",
      "protocol.file.allow=always",
      "clone",
      "--filter=tree:0",
      "--no-checkout",
      "--no-local",
      pathToFileURL(source).href,
      root,
    ]);
    await exec("git", ["read-tree", "HEAD"], { cwd: root });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const tree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
    const packDirectory = join(root, ".git", "objects", "pack");
    const treePacks: string[] = [];
    for (const index of (await readdir(packDirectory)).filter((name) => name.endsWith(".idx"))) {
      const verified = await exec("git", ["verify-pack", "-v", join(packDirectory, index)], {
        cwd: root,
      });
      if (verified.stdout.includes(`${tree} tree`)) treePacks.push(index.slice(0, -4));
    }
    expect(treePacks).toHaveLength(1);
    const emptyGlobal = join(suite, "partial-empty-global");
    await writeFile(emptyGlobal, "");
    const program = await markerProgram(root, "lazy-fetch");
    await exec("git", ["remote", "set-url", "origin", "git@github.com:example/sample.git"], {
      cwd: root,
    });
    for (const [key, value] of [
      ["user.name", "Installer Test"],
      ["user.email", "installer@example.invalid"],
      ["core.sshCommand", program.command],
      ["ssh.variant", "simple"],
    ])
      await exec("git", ["config", key ?? "", value ?? ""], { cwd: root });
    let objectsDisappeared = false;
    const io = adapters(["y", "n", "y", "n"], {
      gitEnvironment: { GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_NOSYSTEM: "1" },
      afterIndexRead: async () => {
        for (const pack of treePacks) {
          for (const suffix of [".idx", ".pack", ".promisor"])
            await rm(join(packDirectory, pack + suffix));
        }
        objectsDisappeared = true;
      },
    });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(objectsDisappeared).toBe(true);
    expect(io.calls.some((call) => call.gitOperation === "read-tree")).toBe(true);
    await expect(readFile(program.marker)).rejects.toThrow();
    expect(result.onboarding).toMatchObject({ committed: false, pushed: false });
    expect(
      (await exec("git", ["--no-lazy-fetch", "rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
    ).toBe(head);
    expect(
      io.calls.some((call) => call.gitOperation === "ls-remote" || call.gitOperation === "push"),
    ).toBe(false);
  });

  it("refuses repository alternate-reference programs before reading objects even when push is declined", async () => {
    const root = await project();
    await exec("git", ["config", "core.alternateRefsCommand", "private-object-program"], {
      cwd: root,
    });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const io = adapters(["y", "n", "y", "n"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: false, pushed: false });
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(head);
    expect(
      io.calls.some((call) => call.gitOperation === "diff" || call.gitOperation === "read-tree"),
    ).toBe(false);
    expect(io.output.text).not.toContain("private-object-program");
    expect(await readFile(join(root, ".github", "workflows", "dsh-review.yml"), "utf8")).toContain(
      releaseSha,
    );
    expect(io.output.text).toContain(
      "Generated files and any completed local commit are preserved",
    );
    expect(io.output.text).not.toContain("Committed only");
  });

  it.each(["push", "ls-remote"])(
    "keeps the local commit on branch %s independent of transport admission",
    async (branch) => {
      const root = await project();
      await exec("git", ["branch", "-m", branch], { cwd: root });
      await exec("git", ["config", "core.sshCommand", "private-repository-helper"], { cwd: root });
      const io = adapters(["y", "n", "y", "n"]);
      const result = await runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        isTTY: true,
        env: {},
        templateDirectory: templates,
        ...io,
      });
      expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
      expect(
        (await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root })).stdout.trim(),
      ).toBe(branch);
      expect(
        io.calls.some((call) => call.gitOperation === "ls-remote" || call.gitOperation === "push"),
      ).toBe(false);
      expect(io.output.text).not.toContain("repository-scoped transport");
    },
  );

  it.each([
    "credential.helper",
    "credential.https://github.com.helper",
    "remote.origin.vcs",
    "remote.origin.uploadpack",
    "remote.origin.receivepack",
    "core.gitProxy",
  ])(
    "refuses the repository-scoped external transport setting %s without revealing its value",
    async (key) => {
      const root = await project();
      const privateValue = "private-transport-value";
      await exec("git", ["config", key, privateValue], { cwd: root });
      const io = adapters(["y", "n", "y", "y"]);
      const result = await runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        isTTY: true,
        env: {},
        templateDirectory: templates,
        ...io,
      });
      expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
      expect(
        io.calls.some((call) => call.gitOperation === "ls-remote" || call.gitOperation === "push"),
      ).toBe(false);
      expect(io.output.text).toContain("repository-scoped transport");
      expect(io.output.text).not.toContain(privateValue);
    },
  );

  it("includes repository transport configuration when deciding whether publication is supported", async () => {
    const root = await project();
    const included = join(root, "transport.config");
    await writeFile(
      included,
      '[credential "https://github.com"]\n\thelper = included-private-helper\n',
    );
    await exec("git", ["config", "include.path", included], { cwd: root });
    const io = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(
      io.calls.some((call) => call.gitOperation === "ls-remote" || call.gitOperation === "push"),
    ).toBe(false);
    expect(io.output.text).not.toContain("included-private-helper");
  });

  it("refuses a per-worktree credential helper before reading the remote branch", async () => {
    const root = await project();
    await exec("git", ["config", "extensions.worktreeConfig", "true"], { cwd: root });
    await exec("git", ["config", "--worktree", "credential.helper", "worktree-private-helper"], {
      cwd: root,
    });
    const io = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(
      io.calls.some((call) => call.gitOperation === "ls-remote" || call.gitOperation === "push"),
    ).toBe(false);
    expect(io.output.text).not.toContain("worktree-private-helper");
  });

  it("rechecks transport configuration after the remote read and stops before pushing a late helper", async () => {
    const root = await project();
    const io = adapters(["y", "n", "y", "y"], {
      afterRemoteRead: async (repository) => {
        await exec("git", ["config", "credential.helper", "late-private-helper"], {
          cwd: repository,
        });
      },
    });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(io.calls.filter((call) => call.gitOperation === "ls-remote")).toHaveLength(1);
    expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
    expect(io.output.text).not.toContain("late-private-helper");
  });

  it("keeps host global authentication available without reading or copying helper configuration values", async () => {
    const root = await project();
    const host = await mkdtemp(join(suite, "host-auth-"));
    const globalConfig = join(host, "gitconfig");
    const helper = join(host, "credential.mjs");
    const marker = join(host, "called.txt");
    await writeFile(
      helper,
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.argv[2], "get\\n");',
        'process.stdout.write("username=fixture\\npassword=fixture-only-password\\n");',
      ].join("\n"),
    );
    const shellPath = (path: string) => `"${path.replaceAll("\\", "/")}"`;
    await exec("git", [
      "config",
      "--file",
      globalConfig,
      "credential.helper",
      `!${shellPath(process.execPath)} ${shellPath(helper)} ${shellPath(marker)}`,
    ]);
    const before = await readFile(globalConfig, "utf8");
    const io = adapters(["y", "n", "y", "y"], {
      gitEnvironment: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
      requireGitCredentials: true,
    });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    expect(await readFile(marker, "utf8")).toBe("get\nget\n");
    expect(await readFile(globalConfig, "utf8")).toBe(before);
    for (const call of io.calls.filter(
      (entry) => entry.gitOperation === "ls-remote" || entry.gitOperation === "push",
    )) {
      expect(call.env?.GIT_CONFIG_GLOBAL).toBe(process.env.GIT_CONFIG_GLOBAL);
      expect(call.env?.GIT_CONFIG_NOSYSTEM).toBe(process.env.GIT_CONFIG_NOSYSTEM);
    }
    expect(io.output.text).not.toContain("fixture-only-password");
  });

  it("publishes only its reviewed workflow commit unsigned even with push signing and tags enabled", async () => {
    const root = await project();
    const remote = join(suite, "follow-tags.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["push", remote, "HEAD:refs/heads/main"], { cwd: root });
    await exec("git", ["tag", "-a", "private-fixture-tag", "-m", "Must remain local"], {
      cwd: root,
    });
    await exec("git", ["config", "push.followTags", "true"], { cwd: root });
    await exec("git", ["config", "push.gpgSign", "true"], { cwd: root });
    await exec("git", ["config", "push.negotiate", "true"], { cwd: root });
    await exec("git", ["config", "submodule.recurse", "true"], { cwd: root });
    const io = adapters(["y", "n", "y", "y"], { localRemote: remote });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    expect((await exec("git", ["ls-remote", "--tags", remote])).stdout).toBe("");
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    expect((await exec("git", ["ls-remote", "--heads", remote, "main"])).stdout).toContain(head);
  });

  it("keeps explicit manual flags offline in a terminal without prompting for composition", async () => {
    const root = await mkdtemp(join(suite, "manual-project-"));
    const io = adapters([]);
    const result = await runInstaller({
      argv: ["--mode", "review"],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result).toEqual({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    expect(io.calls).toEqual([]);
    expect(io.questions).toEqual([]);
  });
  it("hides Secret echo using the real terminal prompt adapter and restores terminal mode", async () => {
    const root = await project();
    const key = "terminal-mask-fixture-key";
    const io = adapters([], { secret: key });
    const input = new TerminalInput();
    Object.defineProperty(io.output, "isTTY", { value: true });
    io.output.onChunk = (text) => {
      if (text.startsWith("Create read-only @dsh") || text.startsWith("Set DEEPSEEK_API_KEY"))
        setImmediate(() => input.write("y\r"));
      if (text.startsWith("DeepSeek API key")) setImmediate(() => input.write(`${key}\r`));
      if (text.startsWith("Commit only")) setImmediate(() => input.write("n\r"));
    };
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input,
      output: io.output,
      processRunner: io.processRunner,
      isTTY: true,
      env: {},
      templateDirectory: templates,
    });
    expect(result.onboarding?.secret).toBe("configured");
    expect(io.output.text).not.toContain(key);
    expect(
      io.calls.find((call) => call.args[0] === "secret" && call.args[1] === "set")?.input,
    ).toBe(`${key}\n`);
    expect(input.raw).toBe(false);
    input.destroy();
  });
  it("retains a confirmed local commit when remote history differs and never force-pushes", async () => {
    const root = await project();
    const io = adapters(["y", "n", "y", "y"], { remoteAhead: true });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
    expect(io.output.text).toContain("local commit is preserved");
  });
  it("preserves pre-existing staged changes and does not create an installer commit", async () => {
    const root = await project();
    await writeFile(join(root, "README.md"), "staged user change\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    const staged = (await exec("git", ["diff", "--cached"], { cwd: root })).stdout;
    const io = adapters(["y", "n", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding?.committed).toBe(false);
    expect((await exec("git", ["diff", "--cached"], { cwd: root })).stdout).toBe(staged);
    expect(
      io.calls.some((call) => call.args.includes("commit-tree") || call.gitOperation === "push"),
    ).toBe(false);
    expect(io.output.text).toContain("Existing staged changes were preserved");
  });
  it("keeps failed Secret setup recoverable without exposing even secret-bearing process errors", async () => {
    const root = await project();
    const key = "failed-transport-secret-fixture";
    const io = adapters(["y", "y", "n"], { secret: key, failSecret: true });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding?.secret).toBe("setup_failed");
    expect(io.output.text).toContain("failed or is uncertain");
    expect(io.output.text).not.toContain(key);
    expect(await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8")).toContain(
      releaseSha,
    );
  });
  it.each(["allow-write", "natural-language-write"])(
    "rejects a starter enabling %s before creating a workflow or sending a Secret",
    async (input) => {
      const root = await project();
      const invalid = await mkdtemp(join(suite, "invalid-templates-"));
      const source = await readFile(join(templates, "dsh-review.yml"), "utf8");
      await writeFile(
        join(invalid, "dsh-review.yml"),
        source.replace(`${input}: "false"`, `${input}: "true"`),
      );
      const io = adapters(["y", "y"]);
      await expect(
        runInstaller({
          argv: [],
          cwd: root,
          input: Readable.from([]),
          isTTY: true,
          env: {},
          templateDirectory: invalid,
          ...io,
        }),
      ).rejects.toThrow(/read-only PR Review configuration/u);
      await expect(readFile(join(root, ".github/workflows/dsh-review.yml"))).rejects.toThrow();
      expect(io.calls.some((call) => call.args[0] === "secret")).toBe(false);
    },
  );
  it("resumes its existing workflow commit and offers push separately without creating a duplicate commit", async () => {
    const root = await project();
    const first = adapters(["y", "y", "y", "n"]);
    await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...first,
    });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const resumed = adapters(["y", "n", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...resumed,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(head);
    expect(resumed.calls.some((call) => call.args.includes("commit-tree"))).toBe(false);
  });
  it("recovers a cloned LF workflow commit with real CRLF checkout without rewriting or duplicating it", async () => {
    const source = await project();
    const workflow = ".github/workflows/dsh-review.yml";
    const starter = (await readFile(join(templates, "dsh-review.yml"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    await mkdir(join(source, ".github", "workflows"), { recursive: true });
    await writeFile(join(source, workflow), starter);
    await exec("git", ["add", workflow], { cwd: source });
    await exec("git", ["commit", "-m", "Configure the pinned Review workflow"], { cwd: source });
    expect((await exec("git", ["show", `HEAD:${workflow}`], { cwd: source })).stdout).toBe(starter);
    const root = await mkdtemp(join(suite, "crlf-clone-"));
    await exec("git", [
      "-c",
      "protocol.file.allow=always",
      "clone",
      "--config",
      "core.autocrlf=true",
      "--no-local",
      pathToFileURL(source).href,
      root,
    ]);
    await exec("git", ["remote", "set-url", "origin", "https://github.com/example/sample.git"], {
      cwd: root,
    });
    await exec("git", ["config", "user.name", "Installer Test"], { cwd: root });
    await exec("git", ["config", "user.email", "installer@example.invalid"], { cwd: root });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const checkedOut = await readFile(join(root, workflow), "utf8");
    expect(checkedOut).toContain("\r\n");
    expect(checkedOut.replaceAll("\r\n", "\n")).toBe(starter);
    expect((await exec("git", ["config", "core.autocrlf"], { cwd: root })).stdout.trim()).toBe(
      "true",
    );
    await writeFile(join(root, "README.md"), "unrelated user edit\r\n");
    await writeFile(join(root, "notes.txt"), "untracked user file\r\n");
    const status = (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Remote transport is the external seam; local Git uses the real CRLF clone.
      const io = adapters(["y", "n", "y", "y"], { remotePublished: true });
      const result = await runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        isTTY: true,
        env: {},
        templateDirectory: templates,
        ...io,
      });
      expect(result.createdFiles).toEqual([]);
      expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
      expect(io.calls.some((call) => call.gitOperation === "ls-remote")).toBe(true);
      expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
      expect(io.calls.some((call) => call.gitOperation === "commit-tree")).toBe(false);
      expect(io.output.text).toContain("already published; no push was repeated");
    }
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(head);
    expect((await exec("git", ["show", `HEAD:${workflow}`], { cwd: root })).stdout).toBe(starter);
    expect(await readFile(join(root, workflow), "utf8")).toBe(checkedOut);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("unrelated user edit\r\n");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("untracked user file\r\n");
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe(status);
    expect((await exec("git", ["config", "core.autocrlf"], { cwd: root })).stdout.trim()).toBe(
      "true",
    );
  });
  it("generates an LF workflow and Git blob from a CRLF starter template", async () => {
    const root = await project();
    const starter = (await readFile(join(templates, "dsh-review.yml"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    const crlfTemplates = await mkdtemp(join(suite, "crlf-templates-"));
    await writeFile(join(crlfTemplates, "dsh-review.yml"), starter.replaceAll("\n", "\r\n"));
    const io = adapters(["y", "n", "y", "n"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: crlfTemplates,
      ...io,
    });
    const workflow = ".github/workflows/dsh-review.yml";
    expect(result.createdFiles).toEqual([workflow]);
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    expect(await readFile(join(root, workflow), "utf8")).toBe(starter);
    expect((await exec("git", ["show", `HEAD:${workflow}`], { cwd: root })).stdout).toBe(starter);
  });
  it("preserves and refuses a CRLF starter with an additional whitespace edit", async () => {
    const root = await project();
    const workflow = join(root, ".github/workflows/dsh-review.yml");
    const starter = (await readFile(join(templates, "dsh-review.yml"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    const edited = starter.replaceAll("\n", "\r\n").replace("\r\n", " \r\n");
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(workflow, edited);
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const io = adapters(["y"]);
    await expect(
      runInstaller({
        argv: [],
        cwd: root,
        input: Readable.from([]),
        isTTY: true,
        env: {},
        templateDirectory: templates,
        ...io,
      }),
    ).rejects.toThrow(/Refusing to overwrite existing workflow/u);
    expect(await readFile(workflow, "utf8")).toBe(edited);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()).toBe(head);
    expect(io.calls.some((call) => call.gitOperation === "commit-tree")).toBe(false);
    expect(io.calls.some((call) => call.args[0] === "secret")).toBe(false);
  });
  it("pushes only the new workflow commit after a separate confirmation and parent binding", async () => {
    const root = await project();
    const io = adapters(["y", "y", "y", "y"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: true });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const push = io.calls.find((call) => call.gitOperation === "push");
    expect(push?.args.slice(-2)).toEqual(["origin", `${head}:refs/heads/main`]);
    expect(push?.args.some((argument) => argument.startsWith("--force"))).toBe(false);
  });
  it("commits only its workflow after consent while preserving user edits and bypassing repository hooks", async () => {
    const root = await project();
    await writeFile(join(root, "README.md"), "user edit\n");
    await writeFile(join(root, "notes.txt"), "user file\n");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho unsafe > hook-ran.txt\n", { mode: 0o755 });
    const io = adapters(["y", "y", "y", "n"]);
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding).toMatchObject({ committed: true, pushed: false });
    const changed = await exec(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { cwd: root },
    );
    expect(changed.stdout.trim()).toBe(".github/workflows/dsh-review.yml");
    expect((await exec("git", ["diff", "--cached", "--name-only"], { cwd: root })).stdout).toBe("");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("user edit\n");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("user file\n");
    await expect(readFile(join(root, "hook-ran.txt"))).rejects.toThrow();
    expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
    expect(io.questions.filter((question) => question.startsWith("Commit"))).toHaveLength(1);
    expect(io.questions.filter((question) => question.startsWith("Push"))).toHaveLength(1);
  });
  it("resumes after manual login by preserving its exact generated workflow", async () => {
    const root = await project();
    const first = adapters(["y"], { login: false });
    await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...first,
    });
    const before = await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8");
    const resumed = adapters(["y", "y", "n"], { secret: "resume-fixture-key" });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...resumed,
    });
    expect(result.createdFiles).toEqual([]);
    expect(result.onboarding?.secret).toBe("configured");
    expect(await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8")).toBe(before);
    expect(resumed.output.text).toContain("Preserved");
  });
  it("sets a confirmed Secret through gh stdin without putting the value in args or output", async () => {
    const root = await project();
    const key = "masked-fixture-api-key";
    const io = adapters(["y", "y", "n"], { secret: key });
    const result = await runInstaller({
      argv: [],
      cwd: root,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result.onboarding?.secret).toBe("configured");
    const set = io.calls.find(
      (call) => call.command === "gh" && call.args[0] === "secret" && call.args[1] === "set",
    );
    expect(set?.args).toEqual([
      "secret",
      "set",
      "DEEPSEEK_API_KEY",
      "--repo",
      "github.com/example/sample",
    ]);
    expect(set?.input).toBe(`${key}\n`);
    expect(io.calls.every((call) => !call.args.join(" ").includes(key))).toBe(true);
    expect(io.output.text).not.toContain(key);
  });
  it("defaults to read-only review at the Git root without exposing composition choices", async () => {
    const root = await project();
    const nested = join(root, "nested");
    await mkdir(nested);
    const io = adapters(["y", "n"], { login: false });
    const result = await runInstaller({
      argv: [],
      cwd: nested,
      input: Readable.from([]),
      isTTY: true,
      env: {},
      templateDirectory: templates,
      ...io,
    });
    expect(result).toMatchObject({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    const workflow = await readFile(join(root, ".github/workflows/dsh-review.yml"), "utf8");
    expect(workflow).toContain(`deepseek-harness-action@${releaseSha}`);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain('allow-write: "false"');
    expect(workflow).toContain('natural-language-write: "false"');
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("pull_request_review:");
    expect(io.output.text).toContain("comment @dsh Explain this issue");
    expect(io.questions.join("\n")).not.toMatch(/Controlled|Native|DSH mode/u);
    expect(io.output.text).toContain("gh auth login");
    expect(io.calls.some((call) => call.gitOperation === "push")).toBe(false);
  });
});
