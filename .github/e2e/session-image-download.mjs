import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run only in the explicitly requested image qualification, using the bound
// candidate's real Controller downloader. Signed redirect queries stay private.
const source = "https://github.com/user-attachments/assets/d69331e6-fc50-4bc0-87af-40b59f1a80b0";
const directory = join(process.env.RUNNER_TEMP, "session-e2e", "download");
const evidencePath = join(
  process.env.RUNNER_TEMP,
  "session-e2e",
  "evidence",
  "image-download.json",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const { prepareGitHubImages } = await import(
  pathToFileURL(resolve("candidate-action/src/github/images.ts")).href
);
const result = await prepareGitHubImages({
  texts: [`![GitHub upload fixture](${source})`],
  directory,
  token: process.env.GH_TOKEN,
  enabled: true,
  signal: new AbortController().signal,
});
let sha256;
let valid =
  result.images.length === 1 && result.images[0].status === "ready" && result.files.length === 1;
if (valid) {
  const bytes = await readFile(join(directory, result.files[0]));
  sha256 = createHash("sha256").update(bytes).digest("hex");
  valid =
    bytes.length === result.images[0].bytes &&
    result.files[0].startsWith(`${sha256}.`) &&
    result.images[0].mediaType === "image/png" &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
}
await writeFile(
  evidencePath,
  JSON.stringify(
    {
      qualified: valid,
      sourceIssue: "https://github.com/anthropics/claude-code-action/issues/1041",
      images: result.images,
      ...(sha256 === undefined ? {} : { sha256 }),
    },
    null,
    2,
  ) + "\n",
);
if (!valid) throw new Error("SESSION_E2E_LIVE_GITHUB_IMAGE_DOWNLOAD_FAILED");
