/* The Controller's built-in MCP client: only bootstrap and agent-scope policy live here. */
import { URL } from "node:url";
import { closeSync, createReadStream, openSync } from "node:fs";
import { devNull } from "node:os";
import { finished } from "node:stream/promises";
export const name = "dsh-action-controller";
export const inject = ["tools"];
const BOOTSTRAP_KEY = "actionControllerMcp";

export function parseControllerBootstrap(raw) {
  if (Buffer.byteLength(raw) > 64 * 1024)
    throw new Error("Controller MCP bootstrap exceeds its limit");
  const value = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["url", "token", "tools", "timeoutMs"].includes(key)) ||
    typeof value.url !== "string" ||
    !/^http:\/\/[^/]+\/action\/mcp$/u.test(value.url) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.token) ||
    !Array.isArray(value.tools) ||
    !value.tools.every(
      (tool) =>
        typeof tool === "string" &&
        /^mcp__action-controller__[A-Za-z0-9_-]+$/u.test(tool) &&
        tool.length <= 64,
    ) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1
  )
    throw new Error("Controller MCP bootstrap is invalid");
  return Object.freeze(value);
}

/** Own and close fd 0 before DSH can create any tool-capable descendant. */
export async function consumeControllerBootstrap() {
  const input = createReadStream("", { fd: 0, autoClose: true, highWaterMark: 4096 });
  const closed = finished(input);
  const chunks = [];
  let bytes = 0;
  let failure;
  try {
    for await (const chunk of input) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) throw new Error("Controller MCP bootstrap exceeds its limit");
      chunks.push(chunk);
    }
    await closed;
  } catch (error) {
    failure = error;
  }
  input.destroy();
  await closed.catch(() => undefined);
  // Node's ReadStream close path treats fd 0 as falsy. Close it explicitly
  // after all reads settle; a future runtime may have closed it already.
  try {
    closeSync(0);
  } catch (error) {
    if (error.code !== "EBADF") throw error;
  }
  // Keep standard fd numbers reserved for libuv, without retaining the pipe.
  if (process.platform !== "win32") {
    const emptyInput = openSync(devNull, "r");
    if (emptyInput !== 0) {
      closeSync(emptyInput);
      throw new Error("bootstrap input was not closed");
    }
  }
  if (failure !== undefined) throw failure;
  return parseControllerBootstrap(Buffer.concat(chunks, bytes).toString("utf8"));
}

export function controllerBridgePatches(bootstrap) {
  return bootstrap === undefined
    ? []
    : [
        {
          insert: [
            {
              id: name,
              name: new URL("./action-controller.mjs", import.meta.url).href,
            },
          ],
        },
      ];
}

/** Called in boot.prepare, before the required Loader row activates. */
export function installControllerBootstrap(host, bootstrap, client) {
  if (bootstrap === undefined) return;
  host.provide(BOOTSTRAP_KEY, { ...bootstrap, client });
}

/** Loader awaits the official MCP client before Headless creates its first Agent. */
export async function apply(ctx) {
  const bootstrap = ctx.get(BOOTSTRAP_KEY);
  if (bootstrap === undefined) throw new Error("Controller MCP bootstrap is missing");
  const names = new Set(bootstrap.tools);
  ctx.provide("actionControllerToolNames", bootstrap.tools);
  let root;
  ctx.on(
    "agent/created",
    ({ agent }) => {
      const child =
        agent.session.header.origin === "subagent" ||
        agent.session.header.parentSession !== undefined;
      if (!child && root === undefined) {
        root = agent;
        ctx.provide("actionControllerRootAgent", agent);
      }
      if (agent !== root && names.size > 0) {
        const inherited = agent.ctx.tools
          .schemas(agent)
          .map((tool) => tool.name)
          .filter((tool) => names.has(tool));
        if (inherited.length > 0) agent.ctx.tools.restrict({ deny: inherited });
      }
    },
    { prepend: true },
  );
  ctx.tools.guard((execution) => {
    if (!names.has(execution.name)) return undefined;
    return execution.agent !== root || root === undefined
      ? "Controller tools require the current root Agent"
      : undefined;
  });
  await bootstrap.client.apply(ctx, {
    serverName: "action-controller",
    transport: "streamable-http",
    url: bootstrap.url,
    headers: { authorization: `Bearer ${bootstrap.token}` },
    toolCallTimeoutMs: bootstrap.timeoutMs,
    failOnStartupError: true,
    reconnect: { enabled: false },
  });
  const registered = ctx.tools
    .schemas()
    .map((tool) => tool.name)
    .filter((tool) => tool.startsWith("mcp__action-controller__"));
  if (registered.length !== names.size || registered.some((tool) => !names.has(tool))) {
    throw new Error("Controller MCP tool inventory does not match its current grant");
  }
}
