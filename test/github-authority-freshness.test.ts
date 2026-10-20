import { expect, it, vi } from "vitest";

import { issueContentFingerprint } from "../src/github/issue-identity.js";
import { checkActorPermissions } from "../src/github/permissions.js";
import { createAuthorityRevalidator } from "../src/orchestration/authority.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { GitHubAuthorityGateway } from "../src/tools/github-authority-gateway.js";
import type { GitHubToolBackend } from "../src/tools/github-backend.js";
import { permissions, pullRequestContext } from "./helpers.js";
import { githubClientFixture } from "./helpers/github-client.js";

it("discards queued metadata when current actor authority changes after admission", async () => {
  const issue = {
    kind: "issue" as const,
    number: 7,
    title: "Issue",
    body: "Body",
    authorId: 1,
    state: "open" as const,
    stateReason: null,
    labels: [],
    assignees: [],
  };
  const unsupported = (): Promise<never> => Promise.reject(new Error("Unexpected transport call"));
  const setLabels = vi.fn(() => Promise.resolve());
  const backend: GitHubToolBackend = {
    getRepository: () => Promise.resolve({ id: 1 }),
    getIssue: () => Promise.resolve(issue),
    setLabels,
    setAssignees: unsupported,
    updateIssueState: unsupported,
    listRecentComments: unsupported,
    createComment: unsupported,
    getPull: unsupported,
    updatePull: unsupported,
    readChecks: unsupported,
  };
  let permission = "write";
  const permissionRead = vi.fn(() => Promise.resolve({ data: { permission } }));
  const client = githubClientFixture({
    rest: {
      users: { getByUsername: () => Promise.resolve({ data: { type: "User" } }) },
      repos: { getCollaboratorPermissionLevel: permissionRead },
    },
  });
  const context = pullRequestContext();
  const command = {
    operation: "task" as const,
    requestedAccess: "read" as const,
    source: "explicit-input" as const,
    instructions: "Triage this issue",
  };
  const policy = evaluatePolicy({
    context,
    operation: "task",
    requestedAccess: "read",
    allowWrite: true,
    permissions: await checkActorPermissions(client, context),
  });
  expect(policy).toMatchObject({
    trust: "trusted-read",
    capabilities: { manageIssueLabels: true, modifyWorkspace: false, push: false },
  });
  const options = {
    ids: ["github.issue.labels.set"] as const,
    binding: {
      repositoryId: 1,
      owner: "o",
      repo: "r",
      target: "issue" as const,
      entityNumber: 7,
      state: "open" as const,
      updatedAt: "2026-10-10T00:00:00Z",
      contentFingerprint: issueContentFingerprint(issue),
    },
    policy,
    allowWrite: true,
    expectedAuthorId: 41898282,
    backend,
    revalidateAuthority: createAuthorityRevalidator({
      client,
      context,
      command,
      inputs: { allowWrite: true, allowedBots: [] },
      policy,
      signal: new AbortController().signal,
    }),
  };
  const gateway = new GitHubAuthorityGateway(options);
  await gateway.invoke(
    { callId: "call-1", id: "github.issue.labels.set", input: { labels: ["triaged"] } },
    { workspacePath: "worker", timeoutMs: 30_000 },
  );
  permission = "read";
  await expect(gateway.flush({ workspacePath: "worker", timeoutMs: 30_000 })).rejects.toMatchObject(
    { code: "POLICY_DENIED" },
  );
  expect(setLabels).not.toHaveBeenCalled();
  expect(permissionRead.mock.calls.length).toBeGreaterThan(1);
  expect(gateway.hasPendingMutations()).toBe(false);
});

it("does not grant metadata capability to an actor with repository read permission", () => {
  const policy = evaluatePolicy({
    context: pullRequestContext(),
    operation: "task",
    requestedAccess: "read",
    allowWrite: true,
    permissions: permissions(false),
  });
  expect(policy.capabilities).toMatchObject({
    manageIssueLabels: false,
    manageIssueAssignees: false,
    updateIssueState: false,
    updatePullRequestMetadata: false,
    modifyWorkspace: false,
    push: false,
  });
  expect(policy.trust).toBe("untrusted");
});
