import { describe, expect, it, vi } from "vitest";
import { configureCommentPublication, upsertTrackingComment } from "../src/github/comments.js";
import { githubClientFixture } from "./helpers/github-client.js";

describe("per-run comment history", () => {
  it("preserves previous runs and attempts while updating the current reply", async () => {
    const comments = [
      { id: 1, user: { id: 42 }, body: "<!-- dsh-action:v1 kind=task -->\nold answer" },
    ];
    const api = githubClientFixture({
      paginate: vi.fn(async () => comments),
      rest: {
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(async ({ body }: { body: string }) => {
            const row = { id: comments.length + 1, user: { id: 42 }, body };
            comments.push(row);
            return { data: row };
          }),
          updateComment: vi.fn(
            async ({ comment_id, body }: { comment_id: number; body: string }) => {
              const row = comments.find((entry) => entry.id === comment_id)!;
              row.body = body;
              return { data: row };
            },
          ),
        },
      },
    });
    const target = { owner: "o", repo: "r", issueNumber: 1 };
    configureCommentPublication(api, { mode: "append", runId: "100", attempt: "1" });
    const first = await upsertTrackingComment(api, target, 42, "task", "working");
    expect(await upsertTrackingComment(api, target, 42, "task", "done")).toBe(first);
    configureCommentPublication(api, { mode: "append", runId: "101", attempt: "1" });
    await upsertTrackingComment(api, target, 42, "task", "second");
    configureCommentPublication(api, { mode: "append", runId: "101", attempt: "2" });
    await upsertTrackingComment(api, target, 42, "task", "rerun");
    expect(comments).toHaveLength(4);
    expect(comments[0]?.body).toContain("old answer");
    expect(comments[1]?.body).toContain("done");
    expect(comments[2]?.body).toContain("second");
    expect(comments[3]?.body).toContain("rerun");
  });
});
