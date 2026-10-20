/** Deterministic business scenarios; real DSH tools and Controller writes still run. */
export function businessReply(route, index, body, settings) {
  const { fixturePath, implementationPath, suffix } = settings;
  if (
    !/^\.github\/dsh-e2e-fixtures\/checks-[1-9][0-9]*-[1-9][0-9]*\.txt$/u.test(fixturePath ?? "") ||
    !/^dsh-e2e-implementation-[1-9][0-9]*-[1-9][0-9]*\.txt$/u.test(implementationPath ?? "") ||
    !/^[1-9][0-9]*\/[1-9][0-9]*$/u.test(suffix ?? "")
  )
    throw new Error("Business fixture identity is invalid");
  const output = {
    protocolVersion: 2,
    operation: route,
    state: "final",
    summary: `DSH E2E ${route} completed ${suffix}`,
    findings: [],
  };
  if (route === "review") {
    if (index !== 1) throw new Error("Review fixture may run only once");
    output.findings.push({
      title: "Fixture head marker requires a fix",
      body: `DSH E2E inline review ${suffix}: replace the intentional fixture head marker with the validated fixed marker.`,
      severity: "high",
      category: "correctness",
      confidence: 1,
      path: fixturePath,
      line: 1,
      side: "RIGHT",
      evidence: `The changed line contains DSH E2E checks head ${suffix}.`,
    });
    return { message: { role: "assistant", content: JSON.stringify(output) }, phase: "final" };
  }
  if (route !== "fix" && route !== "implement") throw new Error("Unknown business operation");
  const path = route === "fix" ? fixturePath : implementationPath;
  const content = `DSH E2E ${route === "fix" ? "fixed" : "implemented"} ${suffix}`;
  const marker = `DSH_E2E_${route.toUpperCase()}_TOOL_COMPLETED`;
  const callId = `business-${route}-bash-once`;
  if (index === 1) {
    if (!(body.tools ?? []).some((tool) => (tool.name ?? tool.function?.name) === "bash"))
      throw new Error("Business fixture requires the actual DSH Bash tool");
    if (route === "fix" && !JSON.stringify(body.messages).includes(`DSH_E2E_CI_FAILURE_${suffix}`))
      throw new Error("Fix fixture did not receive immutable failed-check evidence");
    return {
      message: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: `printf '${content}\\n' > '${path}' && printf '${marker}\\n'`,
                description: `Write only the isolated ${route} fixture`,
                timeoutMs: 10_000,
              }),
            },
          },
        ],
      },
      phase: "bash-issued",
    };
  }
  const messages = body.messages ?? [];
  const feedback = messages.flatMap((message) =>
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
  const issued = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => [
      ...(message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function?.name })),
      ...(Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_use")
        : []),
    ]);
  if (
    index !== 2 ||
    feedback.length !== 1 ||
    feedback[0].id !== callId ||
    feedback[0].failed === true ||
    !JSON.stringify(feedback[0].content).includes(marker) ||
    issued.length !== 1 ||
    issued[0].id !== callId ||
    issued[0].name !== "bash"
  )
    throw new Error("Business fixture requires one matching completed Bash call");
  output.changePlan = [{ path, summary: `Validated ${route} fixture content` }];
  return {
    message: { role: "assistant", content: JSON.stringify(output) },
    phase: "bash-observed",
  };
}
