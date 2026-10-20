import { z } from "zod";

import {
  REVIEW_LIMITS,
  reviewChangeSchema,
  reviewFindingSchema,
  reviewTestSchema,
} from "../review/schema.js";
import { DshMalformedOutputError } from "./errors.js";
import { validateTaskOutput, type TaskOutputSchema } from "./task-output.js";
import { renderDshSchemaIssues } from "./schema-diagnostics.js";

export const dshOperationSchema = z.enum(["task", "review", "diagnose", "fix", "implement"]);
export type DshOperation = z.infer<typeof dshOperationSchema>;

/**
 * The only accepted boundary format from the untrusted model process. Unknown
 * keys are rejected so a model cannot smuggle controller directives alongside
 * review data.
 */
export const dshOutputSchema = z
  .strictObject({
    protocolVersion: z.literal(2),
    operation: dshOperationSchema,
    state: z.enum(["final", "blocked"]),
    summary: z.string().trim().min(1).max(REVIEW_LIMITS.summaryCharacters),
    findings: z.array(reviewFindingSchema).max(REVIEW_LIMITS.maxFindings),
    diagnosis: z.string().trim().min(1).max(REVIEW_LIMITS.diagnosisCharacters).optional(),
    changePlan: z.array(reviewChangeSchema).max(REVIEW_LIMITS.maxChanges).optional(),
    verification: z.array(reviewTestSchema).max(REVIEW_LIMITS.maxTests).optional(),
    taskOutput: z.unknown().optional(),
  })
  .superRefine((output, context) => {
    if (
      output.taskOutput !== undefined &&
      (output.operation !== "task" || output.state !== "final")
    ) {
      context.addIssue({
        code: "custom",
        path: ["taskOutput"],
        message: "is allowed only for a final task operation",
      });
    }
  });

export type DshOutput = z.infer<typeof dshOutputSchema>;

/** Parse one complete JSON value. Markdown fences and trailing prose fail. */
export function parseDshOutput(
  raw: string,
  expectedOperation?: DshOperation,
  taskOutputSchema?: TaskOutputSchema,
): DshOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch (error: unknown) {
    throw new DshMalformedOutputError("DSH stdout was not one complete JSON value", {
      cause: error,
    });
  }

  const parsed = dshOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new DshMalformedOutputError(
      `DSH output failed schema validation: ${renderDshSchemaIssues(parsed.error)}`,
    );
  }
  if (expectedOperation !== undefined && parsed.data.operation !== expectedOperation) {
    throw new DshMalformedOutputError(
      `DSH returned operation ${parsed.data.operation}; expected ${expectedOperation}`,
    );
  }
  if (parsed.data.taskOutput !== undefined && taskOutputSchema === undefined) {
    throw new DshMalformedOutputError(
      "DSH output failed schema validation: $.taskOutput: no trusted task-output-schema is configured",
    );
  }
  if (
    taskOutputSchema !== undefined &&
    parsed.data.operation === "task" &&
    parsed.data.state === "final"
  ) {
    if (parsed.data.taskOutput === undefined) {
      throw new DshMalformedOutputError(
        "DSH output failed schema validation: $.taskOutput: is required for a final task when task-output-schema is configured",
      );
    }
    try {
      return {
        ...parsed.data,
        taskOutput: validateTaskOutput(parsed.data.taskOutput, taskOutputSchema),
      };
    } catch (error: unknown) {
      throw new DshMalformedOutputError(
        `DSH output failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return parsed.data;
}
