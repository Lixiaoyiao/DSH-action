import type { zipSync, unzipSync } from "fflate";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { z } from "zod";
import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";

it("rejects oversized Zod collections before traversing their elements", () => {
  let visited = 0;
  const bounded = z
    .array(
      z.string().transform((value) => {
        visited++;
        return value;
      }),
    )
    .max(4);
  expect(bounded.safeParse(Array.from({ length: 1000 }, () => "value")).success).toBe(false);
  expect(visited).toBe(0);
  expect(bounded.parse(["valid"])).toEqual(["valid"]);
  expect(visited).toBe(1);
});

it("uses the official HTTP fetch consumer through success, redirect protection, private-address rejection and cancellation", async () => {
  let signalWaiting: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    signalWaiting = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: "/text" }).end();
    else if (request.url === "/cross")
      response.writeHead(302, { location: "http://different.example/text" }).end();
    else if (request.url === "/wait") signalWaiting();
    else
      response.writeHead(200, { "content-type": "text/plain" }).end("official provider transport");
  });
  const limits = {
    maxResponseBytes: 8192,
    maxBodyChars: 8192,
    timeoutMs: 2000,
    maxRedirects: 2,
    userAgent: "dsh-security-regression",
  };
  // The official injectable resolver is the sole test seam. Requests still use
  // the actual Undici resolved by dsh-web-fetch-http. Public-IP policy is tested separately below.
  const provider = new HttpFetchProvider(limits, () =>
    Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
  );
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const base = "http://fixture.example:" + String(address.port);
    expect(await provider.fetch({ url: base + "/redirect" })).toMatchObject({
      statusCode: 200,
      body: { content: "official provider transport" },
    });
    await expect(provider.fetch({ url: base + "/cross" })).rejects.toMatchObject({
      code: "WEB_REDIRECT_BLOCKED",
    });
    await expect(
      new HttpFetchProvider(limits).fetch({
        url: "http://127.0.0.1:" + String(address.port) + "/text",
      }),
    ).rejects.toMatchObject({ code: "WEB_BLOCKED_URL" });
    const controller = new AbortController();
    const response = provider.fetch({ url: base + "/wait" }, controller.signal);
    await Promise.race([
      waiting,
      response.then(() => {
        throw new Error("Hanging fixture unexpectedly completed");
      }),
    ]);
    controller.abort();
    await expect(response).rejects.toMatchObject({ code: "WEB_ABORTED" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps the Office consumer ZIP roundtrip and rejects the malformed ZIP64 regression", () => {
  const require = createRequire(import.meta.url);
  const officeRequire = createRequire(require.resolve("@deepseek-ai/libreoffice-kit/package.json"));
  const zip = z
    .object({
      zipSync: z.custom<typeof zipSync>((value) => typeof value === "function"),
      unzipSync: z.custom<typeof unzipSync>((value) => typeof value === "function"),
    })
    .parse(officeRequire("fflate"));
  const archive = zip.zipSync({ "x.txt": new TextEncoder().encode("roundtrip") }, { level: 0 });
  expect(new TextDecoder().decode(zip.unzipSync(archive)["x.txt"])).toBe("roundtrip");
  const eocd = archive.length - 22;
  const original = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const central = original.getUint32(eocd + 16, true);
  const centralSize = original.getUint32(eocd + 12, true);
  const malformed = new Uint8Array(archive.length + 76);
  malformed.set(archive.subarray(0, eocd));
  malformed.set(archive.subarray(eocd), eocd + 76);
  const view = new DataView(malformed.buffer);
  view.setUint32(central + 20, 0xffffffff, true);
  view.setUint16(eocd + 76 + 8, 0xffff, true);
  view.setUint16(eocd + 76 + 10, 0xffff, true);
  view.setUint32(eocd + 76 + 16, 0xffffffff, true);
  // ZIP64 end record + locator, but the central entry has no required 0x0001 extra field.
  view.setUint32(eocd, 0x06064b50, true);
  view.setBigUint64(eocd + 4, 44n, true);
  view.setUint16(eocd + 12, 45, true);
  view.setUint16(eocd + 14, 45, true);
  view.setBigUint64(eocd + 24, 1n, true);
  view.setBigUint64(eocd + 32, 1n, true);
  view.setBigUint64(eocd + 40, BigInt(centralSize), true);
  view.setBigUint64(eocd + 48, BigInt(central), true);
  view.setUint32(eocd + 56, 0x07064b50, true);
  view.setBigUint64(eocd + 64, BigInt(eocd), true);
  view.setUint32(eocd + 72, 1, true);
  // Bound a future parser regression outside the test process itself.
  const script =
    "const z=require(" +
    JSON.stringify(officeRequire.resolve("fflate")) +
    ");try{z.unzipSync(Buffer.from(process.argv[1],'base64'));process.exitCode=2;}catch(e){if(e.code!==13)throw e;console.log('invalid ZIP rejected');}";
  const result = spawnSync(
    process.execPath,
    ["-e", script, Buffer.from(malformed).toString("base64")],
    { encoding: "utf8", timeout: 3000, windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("invalid ZIP rejected");
});
