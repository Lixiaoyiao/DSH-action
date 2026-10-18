import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { prepareGitHubImages } from "../src/github/images.js";

const roots: string[] = [];
const url = "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "github-images-"));
  roots.push(root);
  return root;
}

it("downloads GitHub markdown/HTML images once and stages their exact bytes outside the repository", async () => {
  const root = await directory();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(png, { headers: { "content-type": "image/png" } }));
  const result = await prepareGitHubImages({
    texts: [`![screenshot](${url})`, `<img src="${url}">`],
    directory: root,
    token: "controller-only",
    enabled: true,
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.images).toHaveLength(1);
  expect(result.images[0]).toMatchObject({
    status: "ready",
    bytes: png.length,
    mediaType: "image/png",
  });
  const file = result.files[0];
  if (file === undefined) throw new Error("Downloaded image is missing");
  expect(await readFile(join(root, file))).toEqual(png);
  expect(result.images[0]?.path).toBe(`/dsh-home/github-images/${file}`);
  expect(JSON.stringify(result)).not.toContain("controller-only");
});

it("does not fetch external image URLs or grant tools to an untrusted worker", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const result = await prepareGitHubImages({
    texts: [`![external](https://evil.example/x.png) ![github](${url})`],
    directory: await directory(),
    token: "secret",
    enabled: false,
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.files).toEqual([]);
  expect(result.images[0]?.status).toBe("skipped");
  expect(result.images[0]?.reason).toContain("workspace.read");
});

it("refuses redirects outside GitHub image storage without forwarding credentials", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    );
  const result = await prepareGitHubImages({
    texts: [url],
    directory: await directory(),
    token: "secret",
    enabled: true,
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.images[0]?.status).toBe("failed");
  expect(result.images[0]?.reason).toContain("redirect");
});

it.each([
  "https://private-user-images.githubusercontent.com/1/image.png?jwt=private",
  "https://github-production-user-asset-6210df.s3.amazonaws.com/1034007/image.png?signature=private",
])("follows a signed GitHub image redirect without the Controller token: %s", async (location) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
    .mockResolvedValueOnce(new Response(png, { headers: { "content-type": "image/png" } }));
  const result = await prepareGitHubImages({
    texts: [url],
    directory: await directory(),
    token: "secret",
    enabled: true,
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
  expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty("authorization");
  expect(result.images[0]?.status).toBe("ready");
  expect(JSON.stringify(result)).not.toContain("jwt");
});

it("reports HTTP and size failures and rejects non-image bodies", async () => {
  for (const response of [
    new Response("denied", { status: 403 }),
    new Response(png, { headers: { "content-length": "999999999", "content-type": "image/png" } }),
    new Response("<html>not image</html>", { headers: { "content-type": "text/html" } }),
  ]) {
    const result = await prepareGitHubImages({
      texts: [url],
      directory: await directory(),
      token: "secret",
      enabled: true,
      signal: new AbortController().signal,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    expect(result.files).toEqual([]);
    expect(result.images[0]?.status).toBe("failed");
  }
});
