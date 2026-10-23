import { setTimeout as delay } from "node:timers/promises";

const REPOSITORY = "Lixiaoyiao/DSH-action";
const MAX_READS = 5;
const TOTAL_MS = 20_000;
const REQUEST_MS = 5_000;
const POLL_MS = 1_000;
const fail = (reason) => {
  throw new Error(`Fixture ref confirmation failed: ${reason}`);
};

/** One fixture ref write, followed only by bounded postcondition reads. */
export async function confirmFixtureRef(input, dependencies = {}) {
  const { operation, repository, runId, runAttempt, ref, expectedSha } = input;
  if (
    !["create", "delete"].includes(operation) ||
    repository !== REPOSITORY ||
    !/^[1-9][0-9]*$/.test(runId) ||
    !/^[1-9][0-9]*$/.test(runAttempt) ||
    ![
      `dsh-e2e/checks-${runId}-${runAttempt}`,
      `dsh-e2e/checks-base-${runId}-${runAttempt}`,
    ].includes(ref) ||
    !/^[a-f0-9]{40}$/.test(expectedSha)
  )
    fail("invalid fixture identity");
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? delay;
  const report = dependencies.report ?? (() => undefined);
  const request = dependencies.request ?? githubRequest;
  const deadline = now() + TOTAL_MS;
  let reads = 0;
  let writes = 0;
  const identity = (value) => {
    if (
      value?.ref !== `refs/heads/${ref}` ||
      value.object?.type !== "commit" ||
      value.object.sha !== expectedSha
    )
      fail("ref identity or SHA mismatch");
  };
  async function call(stage, method, path, body, attempt) {
    const remaining = deadline - now();
    if (remaining <= 0) fail("deadline exceeded");
    const controller = new AbortController();
    let timer;
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => request({ method, path, body, signal: controller.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error("Request deadline"));
            },
            Math.min(REQUEST_MS, remaining),
          );
        }),
      ]);
    } catch {
      result = { status: null };
    } finally {
      clearTimeout(timer);
    }
    if (now() >= deadline) fail("deadline exceeded");
    if (
      result?.status !== null &&
      (!Number.isInteger(result?.status) || result.status < 100 || result.status > 599)
    )
      fail("invalid HTTP status");
    report({ operation, stage, status: result.status, attempt });
    return result;
  }
  const read = async (stage, attempt) => {
    reads += 1;
    const result = await call(stage, "GET", `git/ref/heads/${ref}`, undefined, attempt);
    if (result.status === 200) identity(result.value);
    else if (result.status !== 404) fail("ref read was not authoritative");
    return result.status;
  };

  // The caller has already checked commit/tree/blob ownership. Recheck the
  // exact ref immediately before deletion; never delete a different target.
  if (operation === "delete" && (await read("preflight", 0)) === 404)
    return { operation, writes, reads };
  writes += 1;
  const written = await call(
    "write",
    operation === "create" ? "POST" : "DELETE",
    operation === "create" ? "git/refs" : `git/refs/heads/${ref}`,
    operation === "create" ? { ref: `refs/heads/${ref}`, sha: expectedSha } : undefined,
    1,
  );
  if (written.status === (operation === "create" ? 201 : 204)) {
    if (operation === "create") identity(written.value);
  } else if (
    written.status !== null &&
    written.status !== 404 &&
    !(written.status >= 500 && written.status <= 599)
  ) {
    // Known rejections, including authentication, permissions, quota and
    // conflict/validation responses, must not be converted into success.
    fail("ref write was rejected");
  }
  for (let attempt = 1; attempt <= MAX_READS; attempt += 1) {
    const status = await read("confirm", attempt);
    if ((operation === "create" && status === 200) || (operation === "delete" && status === 404))
      return { operation, writes, reads };
    if (attempt < MAX_READS) {
      const remaining = deadline - now();
      if (remaining <= POLL_MS) fail("deadline exceeded");
      await wait(POLL_MS);
    }
  }
  fail("postcondition did not converge");
}

async function githubRequest({ method, path, body, signal }) {
  const token = process.env.GH_TOKEN;
  if (!token) fail("GitHub token is unavailable");
  const response = await globalThis.fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    method,
    signal,
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value;
  if (response.status === 200 || response.status === 201) {
    try {
      value = await response.json();
    } catch {
      /* Invalid identity fails closed. */
    }
  } else await response.body?.cancel();
  return { status: response.status, value };
}

if (import.meta.main) {
  const [operation, ref, expectedSha, extra] = process.argv.slice(2);
  try {
    if (extra !== undefined || !process.env.GH_TOKEN) fail("invalid invocation");
    await confirmFixtureRef(
      {
        operation,
        ref,
        expectedSha,
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      },
      { report: (event) => process.stdout.write(JSON.stringify(event) + "\n") },
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof Error && error.message.startsWith("Fixture ref confirmation failed:")
        ? error.message
        : "Fixture ref confirmation failed") + "\n",
    );
    process.exitCode = 1;
  }
}
