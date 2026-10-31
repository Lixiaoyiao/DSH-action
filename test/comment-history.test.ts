import { describe, expect, it, vi } from "vitest";
import { configureCommentPublication, upsertTrackingComment } from "../src/github/comments.js";
import { githubClientFixture } from "./helpers/github-client.js";

describe("per-run comment history", () => {
  it("preserves previous runs and attempts while updating the current reply", async () => {
    const comments = [
      { id: 1, user: { id: 42 }, body: "<!-- dsh-action:v1 kind=task -->\nold answer" },
    ];
    const api = githubClientFixture({
      paginate: vi.fn(() => Promise.resolve(comments)),
      rest: {
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(({ body }: { body: string }) => {
            const row = { id: comments.length + 1, user: { id: 42 }, body };
            comments.push(row);
            return Promise.resolve({ data: row });
          }),
          updateComment: vi.fn(({ comment_id, body }: { comment_id: number; body: string }) => {
            const row = comments.find((entry) => entry.id === comment_id);
            if (row === undefined) throw new Error("Comment not found");
            row.body = body;
            return Promise.resolve({ data: row });
          }),
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
