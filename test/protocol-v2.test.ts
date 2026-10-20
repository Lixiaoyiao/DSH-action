import { describe, expect, it } from "vitest";
import { parseDshOutput } from "../src/dsh/schema.js";
import { loadInputs } from "../src/inputs.js";
import { buildActionOutputs, finishRunReport } from "../src/result.js";

const final = {
  protocolVersion: 2,
  operation: "task",
  state: "final",
  summary: "Completed without a repository change.",
  findings: [],
} as const;

describe("v0.12 Controller contract", () => {
  it("accepts terminal protocol v2 and rejects the former tool-request protocol", () => {
    expect(parseDshOutput(JSON.stringify(final), "task")).toEqual(final);
    expect(() => parseDshOutput(JSON.stringify({ ...final, protocolVersion: 1 }))).toThrow();
    expect(() =>
      parseDshOutput(
        JSON.stringify({ ...final, state: "needs_tool", toolRequest: { id: "command.test" } }),
      ),
    ).toThrow();
    expect(() =>
      parseDshOutput(JSON.stringify({ ...final, toolRequest: { id: "command.test" } })),
    ).toThrow();
  });

  it("reads the shared Controller step budget and rejects the obsolete input", () => {
    const credentials: Record<string, string> = {
      "deepseek-api-key": "fixture-model-key",
      "github-token": "fixture-github-token",
    };
    const inputs = loadInputs(
      (name) => credentials[name] ?? (name === "max-controller-steps" ? "4" : ""),
    );
    expect(inputs).toHaveProperty("maxControllerSteps", 4);
    expect(inputs).not.toHaveProperty("maxTurns");
    expect(() =>
      loadInputs((name) => credentials[name] ?? (name === "max-turns" ? "4" : "")),
    ).toThrow(/max-controller-steps/u);
  });

  it("publishes only the three canonical Action outputs", () => {
    const outputs = buildActionOutputs(
      finishRunReport({
        conclusion: "success",
        summary: final.summary,
        findingsCount: 0,
        durationMs: 12,
      }),
    );
    expect(Object.keys(outputs).sort()).toEqual(["conclusion", "result-json", "summary"]);
    expect(JSON.parse(String(outputs["result-json"]))).toMatchObject({
      schemaVersion: 2,
      termination: { conclusion: "success", summary: final.summary },
    });
  });
});
