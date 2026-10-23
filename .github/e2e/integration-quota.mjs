import { fileURLToPath } from "node:url";

const repository = "Lixiaoyiao/DSH-action";
const fail = () => {
  throw new Error(
    "Integration job content-read quota was not established; no fixture or task was started",
  );
};
const integer = (raw) => {
  if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/u.test(raw)) return "unknown";
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : "unknown";
};

/** One read in the actual Integration job's token context, before any fixture mutation. */
export async function probeIntegrationQuota(options, dependencies = {}) {
  if (
    options.repository !== repository ||
    !/^[a-f0-9]{40}$/u.test(options.blobSha ?? "") ||
    typeof options.token !== "string" ||
    options.token.trim() === ""
  )
    fail();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await (dependencies.fetch ?? globalThis.fetch)(
      `https://api.github.com/repos/${repository}/git/blobs/${options.blobSha}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
        redirect: "error",
      },
    );
    await response.body?.cancel();
  } catch {
    fail();
  } finally {
    clearTimeout(timer);
  }
  const quota = Object.fromEntries(
    ["limit", "used", "remaining", "reset"].map((name) => [
      name,
      integer(response.headers.get(`x-ratelimit-${name}`)),
    ]),
  );
  quota.resource = response.headers.get("x-ratelimit-resource") === "core" ? "core" : "unknown";
  const known = [quota.limit, quota.used, quota.remaining, quota.reset].every(
    (value) => typeof value === "number",
  );
  const reset = typeof quota.reset === "number" ? new Date(quota.reset * 1000) : undefined;
  const resetAt =
    reset !== undefined && Number.isFinite(reset.getTime()) ? reset.toISOString() : "unknown";
  const readAdmitted =
    response.status === 200 &&
    known &&
    quota.resource === "core" &&
    quota.limit > 0 &&
    quota.remaining > 0 &&
    quota.used + quota.remaining === quota.limit &&
    resetAt !== "unknown";
  (dependencies.report ?? ((value) => process.stdout.write(JSON.stringify(value) + "\n")))({
    scope: "core-e2e-integration-job",
    status: response.status,
    quota,
    resetAt,
    readAdmitted,
    oldTokenRecoveryProven: false,
    completeJobBudgetProven: false,
  });
  if (!readAdmitted) fail();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await probeIntegrationQuota({
      repository: process.env.REPOSITORY,
      blobSha: process.argv[2],
      token: process.env.GH_TOKEN,
    });
  } catch {
    process.stderr.write(
      "Integration job content-read quota was not established; no fixture or task was started\n",
    );
    process.exitCode = 1;
  }
}
