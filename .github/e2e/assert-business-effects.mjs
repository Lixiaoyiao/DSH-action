import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL, URLSearchParams } from "node:url";

const repository = "Lixiaoyiao/DSH-action";
const botId = 41898282;
const sha = /^[a-f0-9]{40}$/u;

function identity(environment) {
  assert.equal(environment.REPOSITORY, repository);
  const run = environment.GITHUB_RUN_ID;
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  const issue = environment.ISSUE_NUMBER;
  for (const value of [run, attempt, issue, environment.CHECKS_PR])
    assert.match(value ?? "", /^[1-9][0-9]*$/u);
  for (const value of [
    environment.CHECKS_HEAD,
    environment.CHECKS_BASE_SHA,
    environment.CANDIDATE_SHA,
  ])
    assert.match(value ?? "", sha);
  const key = createHash("sha256")
    .update([...repository.toLowerCase().split("/"), issue, run].join("\0"))
    .digest("hex")
    .slice(0, 24);
  const value = {
    suffix: `${run}/${attempt}`,
    issue: Number(issue),
    path: `.github/dsh-e2e-fixtures/checks-${run}-${attempt}.txt`,
    implementationPath: `dsh-e2e-implementation-${run}-${attempt}.txt`,
    base: `dsh-e2e/checks-base-${run}-${attempt}`,
    branch: `dsh-e2e/checks-${run}-${attempt}`,
    implementationBranch: `dsh-e2e/implement-${issue}-${key}`,
    key,
  };
  assert.equal(environment.FIXTURE_PATH, value.path);
  assert.equal(environment.CHECKS_BASE_BRANCH, value.base);
  if (environment.IMPLEMENTATION_BRANCH)
    assert.equal(environment.IMPLEMENTATION_BRANCH, value.implementationBranch);
  if (environment.IMPLEMENTATION_KEY) assert.equal(environment.IMPLEMENTATION_KEY, key);
  if (environment.IMPLEMENTATION_PATH)
    assert.equal(environment.IMPLEMENTATION_PATH, value.implementationPath);
  return value;
}

/** Verify remote effects independently of model prose or Action result fields. */
export async function assertBusinessEffects(mode, environment, request) {
  assert.ok(["fix", "fix-cleanup", "implement", "cleanup-implement"].includes(mode));
  const expected = identity(environment);
  const call = async (method, path, body) => {
    const result = await request(method, path, body);
    assert.ok(Number.isInteger(result.status), "GitHub response status is unavailable");
    return result;
  };
  const get = async (path) => {
    const result = await call("GET", path);
    assert.equal(result.status, 200, `GitHub ${path} must be confirmed`);
    return result.value;
  };
  const pullIdentity = (pull, branch) => {
    assert.equal(pull.head.repo.full_name.toLowerCase(), repository.toLowerCase());
    assert.equal(pull.base.repo.full_name.toLowerCase(), repository.toLowerCase());
    assert.equal(pull.head.repo.id, pull.base.repo.id);
    assert.equal(pull.head.ref, branch);
    assert.equal(pull.base.ref, expected.base);
    assert.equal(pull.base.sha, environment.CHECKS_BASE_SHA);
    assert.equal(pull.user.id, botId);
    assert.ok(["open", "closed"].includes(pull.state));
  };
  const changedFile = async (base, head, path, status, content) => {
    const comparison = await get(`compare/${base}...${head}`);
    assert.equal(comparison.total_commits, 1);
    assert.equal(comparison.base_commit.sha, base);
    assert.equal(comparison.files.length, 1);
    const file = comparison.files[0];
    assert.equal(file.filename, path);
    assert.equal(file.status, status);
    assert.match(file.sha, sha);
    const blob = await get(`git/blobs/${file.sha}`);
    assert.equal(blob.sha, file.sha);
    assert.equal(blob.encoding, "base64");
    assert.equal(
      Buffer.from(blob.content.replaceAll("\n", ""), "base64").toString("utf8"),
      content,
    );
  };
  const assertCommit = async (head, parent, message) => {
    assert.match(head ?? "", sha);
    const commit = await get(`git/commits/${head}`);
    assert.equal(commit.sha, head);
    assert.equal(commit.parents.length, 1);
    assert.equal(commit.parents[0].sha, parent);
    assert.equal(commit.message, message);
  };
  if (mode === "fix" || mode === "fix-cleanup") {
    const head = environment.FIXED_HEAD;
    assert.match(head ?? "", sha);
    assert.notEqual(head, environment.CHECKS_HEAD);
    const pull = await get(`pulls/${environment.CHECKS_PR}`);
    pullIdentity(pull, expected.branch);
    assert.equal(pull.number, Number(environment.CHECKS_PR));
    if (environment.CHECKS_PR_ID) assert.equal(pull.id, Number(environment.CHECKS_PR_ID));
    if (mode === "fix") assert.equal(pull.state, "open");
    assert.equal(pull.head.sha, head);
    assert.equal(pull.draft, true);
    assert.ok(
      pull.body.includes(
        `<!-- dsh-e2e:github-integration:v1 run=${environment.GITHUB_RUN_ID} attempt=${environment.GITHUB_RUN_ATTEMPT} candidate=${environment.CANDIDATE_SHA} -->`,
      ),
    );
    await assertCommit(head, environment.CHECKS_HEAD, "fix: apply DeepSeek Harness fix");
    await changedFile(
      environment.CHECKS_HEAD,
      head,
      expected.path,
      "modified",
      `DSH E2E fixed ${expected.suffix}\n`,
    );
    return { mode, head, pull: pull.number };
  }

  const refPath = `git/ref/heads/${expected.implementationBranch}`;
  const ref = await call("GET", refPath);
  assert.ok([200, 404].includes(ref.status), "Implementation ref absence must be authoritative");
  const query = new URLSearchParams({
    head: `${repository.split("/")[0]}:${expected.implementationBranch}`,
    base: expected.base,
    state: "all",
    per_page: "100",
  });
  const pulls = await get(`pulls?${query}`);
  assert.ok(Array.isArray(pulls) && pulls.length <= 1, "Implementation PR identity is ambiguous");
  if (ref.status === 404 && pulls.length === 0 && mode === "cleanup-implement")
    return { mode, absent: true };
  if (mode === "implement") {
    assert.equal(ref.status, 200);
    assert.equal(pulls.length, 1);
  }
  const head = ref.status === 200 ? ref.value.object.sha : pulls[0]?.head.sha;
  assert.match(head ?? "", sha);
  if (ref.status === 200) {
    assert.equal(ref.value.ref, `refs/heads/${expected.implementationBranch}`);
    assert.equal(ref.value.object.type, "commit");
  }
  const commit = await get(`git/commits/${head}`);
  const snapshot = /^DSH-Issue-Snapshot: ([a-f0-9]{24})$/mu.exec(commit.message)?.[1];
  assert.ok(snapshot, "Implementation snapshot trailer is missing");
  await assertCommit(
    head,
    environment.CHECKS_BASE_SHA,
    `feat: implement #${expected.issue}\n\nDSH-Operation-Key: ${expected.key}\nDSH-Issue-Snapshot: ${snapshot}`,
  );
  await changedFile(
    environment.CHECKS_BASE_SHA,
    head,
    expected.implementationPath,
    "added",
    `DSH E2E implemented ${expected.suffix}\n`,
  );
  const implementationPullIdentity = (pull) => {
    pullIdentity(pull, expected.implementationBranch);
    assert.ok(Number.isSafeInteger(pull.id) && pull.id > 0);
    assert.ok(Number.isSafeInteger(pull.number) && pull.number > 0);
    assert.equal(pull.head.sha, head);
    assert.ok(
      pull.body.startsWith(
        `<!-- dsh-action:implement:v1 operation=${expected.key} snapshot=${snapshot} -->`,
      ),
    );
    assert.ok(pull.body.includes(`Closes #${expected.issue}`));
    if (environment.IMPLEMENTATION_PULL_NUMBER)
      assert.equal(pull.number, Number(environment.IMPLEMENTATION_PULL_NUMBER));
  };
  for (const pull of pulls) {
    implementationPullIdentity(pull);
    if (mode === "implement") assert.equal(pull.state, "open");
    if (mode === "cleanup-implement" && pull.state === "open") {
      // Reads of commits and blobs do not authorize a later PR mutation.
      const currentPull = await get(`pulls/${pull.number}`);
      assert.equal(currentPull.id, pull.id);
      assert.equal(currentPull.number, pull.number);
      implementationPullIdentity(currentPull);
      if (currentPull.state === "closed") continue;
      const closed = await call("PATCH", `pulls/${pull.number}`, { state: "closed" });
      assert.equal(closed.status, 200);
      const observed = await get(`pulls/${pull.number}`);
      assert.equal(observed.id, pull.id);
      assert.equal(observed.state, "closed");
    }
  }
  if (mode === "cleanup-implement" && ref.status === 200) {
    // One exact deletion after immediate identity revalidation; no replay.
    const current = await get(refPath);
    assert.equal(current.ref, `refs/heads/${expected.implementationBranch}`);
    assert.equal(current.object.type, "commit");
    assert.equal(current.object.sha, head);
    const deleted = await call("DELETE", `git/refs/heads/${expected.implementationBranch}`);
    assert.equal(deleted.status, 204);
    assert.equal((await call("GET", refPath)).status, 404);
  }
  return { mode, head, pull: pulls[0]?.number };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const request = async (method, path, body) => {
    const response = await globalThis.fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, ...(text ? { value: JSON.parse(text) } : {}) };
  };
  const result = await assertBusinessEffects(process.argv[2], process.env, request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
