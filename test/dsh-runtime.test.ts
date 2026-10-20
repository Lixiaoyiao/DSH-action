import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bindDshRuntime,
  createDshRuntime,
  disposeDshRuntime,
  fingerprintDshRuntimeBinding,
  type DshRuntime,
  type DshRuntimeBinding,
} from "../src/dsh/runtime.js";
import { DSH_VERSION } from "../src/release.js";

const EXTENSION_DIGEST = "a".repeat(64);

function binding(overrides: Partial<DshRuntimeBinding> = {}): DshRuntimeBinding {
  return {
    compositionId: "github-action-controlled",
    dshVersion: DSH_VERSION,
    containerImage: `docker.io/library/node@sha256:${"1".repeat(64)}`,
    isolation: "docker",
    workspacePath: join(tmpdir(), "dsh-runtime-workspace"),
    chatBaseUrl: "https://api.deepseek.com/",
    webSearchProxy: false,
    extensionConfigurationDigest: EXTENSION_DIGEST,
    nativeRuntimeTools: ["read", "grep", "bash"],
    workspaceWrite: false,
    network: false,
    profileSchemaVersion: 1,
    ...overrides,
  };
}

function runtimeStub(): DshRuntime {
  return {
    root: "runtime-root",
    dshHome: "runtime-home",
    packageRoot: "runtime-package",
    npmCache: "runtime-npm-cache",
  };
}

describe("run-scoped DSH runtime", () => {
  it("creates private runtime, profile, state, and installer-cache directories", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-runtime-test-"));
    const runtime = await createDshRuntime(temporaryRoot);
    try {
      expect(runtime.root.startsWith(temporaryRoot)).toBe(true);
      expect(runtime.dshHome).toBe(join(runtime.root, "home"));
      expect(runtime.packageRoot).toBe(join(runtime.dshHome, "profiles", "github-action"));
      expect(runtime.npmCache).toBe(join(runtime.root, "npm-cache"));
      expect(runtime.npmCache.startsWith(`${runtime.dshHome}/`)).toBe(false);
      expect(runtime).not.toHaveProperty("binding");
      expect(runtime).not.toHaveProperty("installedVersion");
      expect(runtime).not.toHaveProperty("installedExtensionDigest");
      expect(runtime).not.toHaveProperty("installedPackageInventory");
      expect(runtime).not.toHaveProperty("installedPackageLockBaseline");
      expect(runtime).not.toHaveProperty("installedExtensionRuntimeLock");
      expect(runtime).not.toHaveProperty("verifiedPluginModuleSpecifiers");

      const directories = [
        runtime.root,
        runtime.dshHome,
        runtime.packageRoot,
        runtime.npmCache,
        join(runtime.dshHome, "action-state"),
        join(runtime.dshHome, "sessions"),
        join(runtime.dshHome, "attachments"),
        join(runtime.dshHome, "storages"),
      ];
      for (const directory of directories) {
        const details = await stat(directory);
        expect(details.isDirectory()).toBe(true);
        if (process.platform !== "win32") expect(details.mode & 0o777).toBe(0o700);
      }

      await disposeDshRuntime(runtime);
      await expect(stat(runtime.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("canonicalizes tool order and reuses an identical immutable binding", () => {
    const runtime = runtimeStub();
    const first = bindDshRuntime(runtime, binding());
    const reordered = binding({
      workspacePath: join(tmpdir(), "dsh-runtime-workspace", "."),
      chatBaseUrl: "https://API.DEEPSEEK.COM:443/?ignored=yes#fragment",
      nativeRuntimeTools: ["bash", "read", "grep", "read"],
    });
    const second = bindDshRuntime(runtime, reordered);

    expect(second).toBe(first);
    expect(first.binding.nativeRuntimeTools).toEqual(["bash", "grep", "read"]);
    expect(first.binding.workspacePath).toBe(join(tmpdir(), "dsh-runtime-workspace"));
    expect(first.binding.chatBaseUrl).toBe("https://api.deepseek.com/");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDshRuntimeBinding(binding())).toBe(fingerprintDshRuntimeBinding(reordered));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.binding)).toBe(true);
    expect(Object.isFrozen(first.binding.nativeRuntimeTools)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(runtime, "binding")).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
    });
  });

  it("preserves the released binding fingerprints across normalized runtime modes", () => {
    const windows = process.platform === "win32";
    const workspacePath = windows ? "C:\\dsh-workspace\\fixture" : "/dsh-workspace/fixture";
    const base = binding({ workspacePath, dshVersion: "0.2.1-rc.2" });
    // Captured from the released serializer before removing its duplicate projection.
    const cases: readonly [DshRuntimeBinding, string][] = [
      [
        base,
        windows
          ? "4755230d78d0b604444d50616af9fb1bbef01b346a0e6b4e472a97bbbcb950ef"
          : "6f5605b122f051c91c4f3735ad1a72d31f715ba70974cdc3f3678271d6910049",
      ],
      [
        {
          ...base,
          compositionId: "dsh-native-headless",
          webSearchProxy: true,
          webSearchBaseUrl: "https://SEARCH.EXAMPLE.TEST:443/anthropic/v1///?ignored=yes#fragment",
          nativeRuntimeTools: ["web_search", "read", "read", "bash"],
          workspaceWrite: true,
          network: true,
        },
        windows
          ? "00bcf1b186913000de3f389cd1437cbc8cf6b78f3089215a2fc94f33d2419cb2"
          : "54192446311f5f2e058a818affe59d07a6ec34981ddc50155d5150ea41bd9192",
      ],
      [
        {
          ...base,
          isolation: "none",
          dshExecutableIdentity: windows ? "C:\\dsh-runtime\\bin.js" : "/dsh-runtime/bin.js",
          profileSchemaVersion: 2,
        },
        windows
          ? "b42ba8fc666a1ed9a1aebc993bbad8fcd0a1e2cba28b13c909f7396149c9bddd"
          : "a834970ede3c5fcb671530b33abe3c28164d1b64f93b180717d8956061c23db7",
      ],
    ];
    for (const [requested, expected] of cases) {
      expect(fingerprintDshRuntimeBinding(requested)).toBe(expected);
      const runtime = runtimeStub();
      expect(bindDshRuntime(runtime, requested).fingerprint).toBe(expected);
      expect(bindDshRuntime(runtime, requested).fingerprint).toBe(expected);
      expect(
        fingerprintDshRuntimeBinding(Object.assign({}, requested, { ignored: "extra field" })),
      ).toBe(expected);
    }
  });

  it("rejects every authorization-relevant field change with the field name", () => {
    const changes: readonly [
      keyof DshRuntimeBinding,
      Partial<DshRuntimeBinding>,
      Partial<DshRuntimeBinding>,
    ][] = [
      ["compositionId", {}, { compositionId: "another-composition" }],
      ["dshVersion", {}, { dshVersion: "0.1.0-rc.9" }],
      ["containerImage", {}, { containerImage: `example.invalid/node@sha256:${"2".repeat(64)}` }],
      [
        "isolation",
        {},
        {
          isolation: "none",
          dshExecutableIdentity: join(tmpdir(), "dsh-runtime-bin.js"),
        },
      ],
      ["workspacePath", {}, { workspacePath: join(tmpdir(), "another-workspace") }],
      ["chatBaseUrl", {}, { chatBaseUrl: "https://chat.example.test/v1" }],
      [
        "webSearchProxy",
        {},
        {
          webSearchProxy: true,
          webSearchBaseUrl: "https://search.example.test/anthropic/v1",
        },
      ],
      [
        "webSearchBaseUrl",
        {
          webSearchProxy: true,
          nativeRuntimeTools: ["read", "web_search"],
          webSearchBaseUrl: "https://search.example.test/anthropic/v1",
        },
        {
          webSearchProxy: true,
          nativeRuntimeTools: ["read", "web_search"],
          webSearchBaseUrl: "https://other-search.example.test/anthropic/v1",
        },
      ],
      [
        "dshExecutableIdentity",
        {
          isolation: "none",
          dshExecutableIdentity: join(tmpdir(), "dsh-runtime-bin.js"),
        },
        {
          isolation: "none",
          dshExecutableIdentity: join(tmpdir(), "other-dsh-runtime-bin.js"),
        },
      ],
      ["extensionConfigurationDigest", {}, { extensionConfigurationDigest: "b".repeat(64) }],
      ["nativeRuntimeTools", {}, { nativeRuntimeTools: ["read", "grep"] }],
      ["workspaceWrite", {}, { workspaceWrite: true }],
      ["network", {}, { network: true }],
      ["profileSchemaVersion", {}, { profileSchemaVersion: 2 }],
    ];

    for (const [field, initial, change] of changes) {
      const runtime = runtimeStub();
      bindDshRuntime(runtime, binding(initial));
      expect(() => bindDshRuntime(runtime, binding({ ...initial, ...change }))).toThrow(
        new RegExp(`binding changed:.*${field}`, "u"),
      );
    }
  });

  it("rejects malformed first-use bindings before fixing the runtime", () => {
    const malformed: readonly Record<string, unknown>[] = [
      { compositionId: "" },
      { dshVersion: "" },
      { containerImage: " " },
      { isolation: "invalid" },
      { workspacePath: "relative/workspace" },
      { chatBaseUrl: "http://remote.example.test" },
      { chatBaseUrl: "https://user:password@api.example.test" },
      { webSearchBaseUrl: "https://search.example.test/anthropic/v1" },
      { webSearchProxy: true },
      { isolation: "none" },
      { dshExecutableIdentity: join(tmpdir(), "docker-cannot-use-host-bin.js") },
      { extensionConfigurationDigest: "not-a-digest" },
      { nativeRuntimeTools: "read" },
      { nativeRuntimeTools: ["not/a/tool"] },
      { workspaceWrite: "yes" },
      { network: 1 },
      { profileSchemaVersion: 0 },
    ];

    for (const invalid of malformed) {
      const runtime = runtimeStub();
      // Mutate a valid typed value at the untrusted JavaScript boundary to
      // exercise the production runtime validator with malformed fields.
      expect(() => bindDshRuntime(runtime, Object.assign(binding(), invalid))).toThrow(
        /DSH runtime binding/u,
      );
      expect(runtime).not.toHaveProperty("binding");
    }
  });

  it("rejects a forged existing fingerprint and an unbindable runtime", () => {
    const requested = binding();
    const forged = runtimeStub();
    Object.defineProperty(forged, "binding", {
      value: Object.freeze({ fingerprint: "0".repeat(64), binding: requested }),
      enumerable: true,
    });
    expect(() => bindDshRuntime(forged, requested)).toThrow(/invalid binding fingerprint/u);

    const sealed = Object.preventExtensions(runtimeStub());
    expect(() => bindDshRuntime(sealed, requested)).toThrow(/could not be fixed on first use/u);
  });
});
