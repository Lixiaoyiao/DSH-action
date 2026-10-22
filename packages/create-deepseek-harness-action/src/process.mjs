import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

const TERMINATION_GRACE_MS = 250;
const WINDOWS_TREE_KILL_MS = 1500;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

function inside(root, candidate) {
  const location = relative(root, candidate);
  return (
    location === "" ||
    (!isAbsolute(location) &&
      location !== ".." &&
      !location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

/** Find the nearest Git checkout/worktree without executing repository programs. */
export async function resolveRepositoryRoot(cwd) {
  const selected = await realpath(cwd ?? process.cwd());
  let directory = selected;
  while (true) {
    try {
      // A directory or worktree .git file establishes the same exclusion bound.
      await lstat(join(directory, ".git"));
      return directory;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return selected;
    directory = parent;
  }
}

async function trustedExecutable(command, cwd, environment = process.env) {
  const boundary = await resolveRepositoryRoot(cwd);
  const usable = async (candidate) => {
    if (inside(boundary, candidate)) return undefined;
    try {
      const executable = await realpath(candidate);
      if (inside(boundary, executable) || !(await stat(executable)).isFile()) return undefined;
      await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return executable;
    } catch {
      return undefined;
    }
  };
  if (isAbsolute(command)) {
    if (process.platform === "win32" && !/\.(?:exe|com)$/iu.test(command))
      throw new Error("Windows tools must be absolute exe/com files, without a shell.");
    const executable = await usable(command);
    if (executable !== undefined) return executable;
    throw new Error("Absolute tool is unavailable or inside the selected repository.");
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(command))
    throw new Error("Tool must be a bare name or trusted absolute executable.");
  // Match Node's Windows case-insensitive, lexicographically first env key.
  const pathKey =
    process.platform === "win32"
      ? Object.keys(environment)
          .sort()
          .find((key) => key.toUpperCase() === "PATH")
      : "PATH";
  const path = pathKey === undefined ? "" : (environment[pathKey] ?? "");
  const names =
    process.platform === "win32" && !/\.(?:exe|com)$/iu.test(command)
      ? [`${command}.exe`, `${command}.com`]
      : [command];
  for (const entry of path.split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/u, "$1");
    if (directory === "" || !isAbsolute(directory) || inside(boundary, directory)) continue;
    for (const name of names) {
      const executable = await usable(join(directory, name));
      if (executable !== undefined) return executable;
    }
  }
  throw new Error("No executable in an absolute host PATH directory outside the repository.");
}

async function boundedTool(command, cwd, environment, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      trustedExecutable(command, cwd, environment),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tool lookup exceeded its command budget.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function signalGroup(child, signal) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    // An absent group is already disposed. Other failures remain uncertain.
    if (error.code === "ESRCH") return true;
    try {
      child.kill(signal);
    } catch {
      /* Pipe disposal still remains bounded. */
    }
    return false;
  }
}

async function terminateTree(child, cwd) {
  if (process.platform !== "win32") {
    signalGroup(child, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
    return signalGroup(child, "SIGKILL");
  }
  if (child.pid === undefined) return false;
  // Windows has no POSIX process group. Kill the tree before the leader so the
  // OS can still discover descendants. The cleanup helper has its own deadline.
  return new Promise((resolve) => {
    let helper;
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        helper?.kill();
      } catch {
        /* Helper may already have exited. */
      }
      helper?.unref();
      resolve(success);
    };
    const timer = setTimeout(() => finish(false), WINDOWS_TREE_KILL_MS);
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || !isAbsolute(systemRoot)) {
      finish(false);
      return;
    }
    void trustedExecutable(join(systemRoot, "System32", "taskkill.exe"), cwd).then(
      (executable) => {
        if (settled) return;
        try {
          helper = spawn(executable, ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            shell: false,
            stdio: "ignore",
          });
          helper.on("error", () => finish(false));
          helper.on("close", (code) => finish(code === 0));
        } catch {
          finish(false);
        }
      },
      () => finish(false),
    );
  });
}

/** External process transport. Arguments and captured output are never logged. */
export async function runProcess(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const timeoutMs = options.timeoutMs ?? 30_000;
  let executable;
  try {
    executable = await boundedTool(command, options.cwd, options.env, timeoutMs);
  } catch {
    return { exitCode: 1, stdout: "", stderr: "", failure: "tool_unavailable" };
  }
  const remainingMs = timeoutMs - Number(process.hrtime.bigint() - started) / 1_000_000;
  if (remainingMs <= 0) return { exitCode: 1, stdout: "", stderr: "", failure: "timeout" };
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let stopping = false;
    const disposePipes = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (failure) => {
      if (stopping || finished) return;
      stopping = true;
      clearTimeout(timer);
      const completeTermination = (treeKillRequested) => {
        // A leader's close event cannot prove inherited pipes or descendants
        // are gone. Dispose locally even if the OS refused tree termination;
        // return explicit uncertainty rather than waiting forever for close.
        if (!treeKillRequested) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Bounded failure remains uncertain. */
          }
        }
        disposePipes();
        finish({
          exitCode: 1,
          stdout,
          stderr,
          failure,
          termination: treeKillRequested ? "requested" : "unconfirmed",
        });
      };
      void terminateTree(child, options.cwd).then(completeTermination, () =>
        completeTermination(false),
      );
    };
    const capture = (current, chunk) => {
      if (stopping || finished) return current;
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > OUTPUT_LIMIT_BYTES) {
        stop("output_limit");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.stdin.on("error", () => {
      /* Early process exit may close stdin before a write settles. */
    });
    const timer = setTimeout(() => stop("timeout"), remainingMs);
    child.on("error", (error) => {
      if (finished || stopping) return;
      finished = true;
      clearTimeout(timer);
      disposePipes();
      reject(error);
    });
    child.on("close", (code) => {
      if (!stopping) finish({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}
