import { createHash } from "node:crypto";

/** The exact public-name contract of the pinned official DSH MCP client. */
export function controllerToolName(id) {
  const server = "action-controller";
  const joined = `mcp__${server}__${id}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (normalized === joined && joined.length <= 64) return joined;
  const hash = createHash("sha256").update(`${server}\0${id}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

/** Both supported provider protocols must carry the actual prior tool responses. */
export function controllerToolReply(body, route, index, plan) {
  const results = (body.messages ?? []).flatMap((message) =>
    message.role === "tool"
      ? [{ id: message.tool_call_id, content: message.content }]
      : message.role === "user" && Array.isArray(message.content)
        ? message.content
            .filter((block) => block.type === "tool_result")
            .map((block) => ({
              id: block.tool_use_id,
              content: block.content,
              failed: block.is_error === true,
            }))
        : [],
  );
  if (results.length !== index - 1 || results.length > plan.length)
    throw new Error("Controller fixture requires the complete single-loop tool history");
  for (const [position, result] of results.entries()) {
    const expected = plan[position];
    const text =
      typeof result.content === "string"
        ? result.content
        : (result.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const value = JSON.parse(text);
    if (
      result.failed ||
      result.id !== `${route}-controller-${position + 1}` ||
      value.id !== expected.id ||
      value.ok !== true ||
      value.output?.effect !== (expected.id === "github.checks.read" ? "read" : "scheduled")
    )
      throw new Error(
        "Controller fixture requires a matching successful read or scheduled mutation",
      );
  }
  const next = plan[results.length];
  if (next === undefined) return undefined;
  const name = controllerToolName(next.id);
  if (!(body.tools ?? []).some((tool) => (tool.name ?? tool.function?.name) === name))
    throw new Error("Controller fixture requires the real admitted MCP tool schema");
  return {
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: `${route}-controller-${index}`,
        type: "function",
        function: { name, arguments: JSON.stringify(next.input) },
      },
    ],
  };
}
