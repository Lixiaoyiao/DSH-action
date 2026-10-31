import { describe, expect, it, vi } from "vitest";
import { configureCommentPublication, upsertTrackingComment } from "../src/github/comments.js";
import { githubClientFixture } from "./helpers/github-client.js";

describe("per-run comment history", () => {
  it("shares a server-returned id between progress and final clients without relisting", async () => {
    const paginate = vi.fn(() => Promise.resolve([]));
    const createComment = vi.fn(() => Promise.resolve({ data: { id: 73 } }));
    const updateComment = vi.fn<
      (input: { comment_id: number; body: string }) => Promise<{ data: { id: number } }>
    >(() => Promise.resolve({ data: { id: 73 } }));
    const first = githubClientFixture({
      paginate,
      rest: { issues: { listComments: vi.fn(), createComment, updateComment } },
    });
    const final = githubClientFixture({
      paginate,
      rest: { issues: { listComments: vi.fn(), createComment, updateComment } },
    });
    const publication = { mode: "append", runId: "123", attempt: "1" } as const;
    configureCommentPublication(first, publication);
    configureCommentPublication(final, publication);
    const target = { owner: "o", repo: "r", issueNumber: 1 };
    await upsertTrackingComment(first, target, 42, "task", "progress");
    await upsertTrackingComment(final, target, 42, "task", "final");
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment.mock.calls[0]?.[0].comment_id).toBe(73);
    expect(updateComment.mock.calls[0]?.[0].body).toContain("final");
  });
  it("does not recover an uncertain create from an unrelated historical or spoofed reply", async () => {
    const body = "<!-- dsh-action:v1 kind=task -->\n<!-- dsh-action:run=124 attempt=1 -->";
    const paginate = vi.fn(() =>
      Promise.resolve([
        { id: 9, user: { id: 42 }, body: "<!-- dsh-action:v1 kind=task -->old" },
        { id: 10, user: { id: 999 }, body },
      ]),
    );
    const createComment = vi.fn(() => Promise.reject(new Error("connection lost")));
    const updateComment = vi.fn();
    const api = githubClientFixture({
      paginate,
      rest: { issues: { listComments: vi.fn(), createComment, updateComment } },
    });
    configureCommentPublication(api, { mode: "append", runId: "124", attempt: "1" });
    const target = { owner: "o", repo: "r", issueNumber: 1 };
    await expect(upsertTrackingComment(api, target, 42, "task", "progress")).rejects.toThrow(
      "connection lost",
    );
    await expect(upsertTrackingComment(api, target, 42, "task", "final")).rejects.toThrow(
      "connection lost",
    );
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).not.toHaveBeenCalled();
  });

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
    expect(api.paginate).toHaveBeenCalledTimes(1);
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
