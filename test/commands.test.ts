import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands/parse.js";
import { finalizeWorkflowRunRoute, routeCommand } from "../src/commands/router.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { inputs, permissions, pullRequestContext } from "./helpers.js";

describe("parseCommand", () => {
  it.each(["review", "diagnose", "fix", "implement"])("parses @dsh %s", (operation) => {
    expect(parseCommand(`@dsh ${operation} check carefully`)).toEqual({
      operation,
      instructions: "check carefully",
      requestedAccess: operation === "fix" || operation === "implement" ? "write" : "read",
    });
  });

  it.each([
    "please @dsh review",
    "@dsh",
    "@dsh-other explain this",
    "@dsh分析这个问题",
    "> @dsh fix",
    "@dsh review\n@dsh fix",
  ])("rejects ambiguous or embedded command: %s", (value) =>
    expect(parseCommand(value)).toBeNull(),
  );

  it("normalizes CRLF and accepts case-insensitive commands", () => {
    expect(parseCommand("  @DSH REVIEW focus on races\r\nordinary context")).toEqual({
      operation: "review",
      instructions: "focus on races\nordinary context",
      requestedAccess: "read",
    });
  });

  it("treats a custom trigger phrase literally", () => {
    expect(parseCommand("  /dsh+ review focus", "/dsh+")).toEqual({
      operation: "review",
      instructions: "focus",
      requestedAccess: "read",
    });
    expect(parseCommand("please /dsh+ review", "/dsh+")).toBeNull();
    expect(parseCommand("/dsh+ review\n/dsh+ fix", "/dsh+")).toBeNull();
    expect(parseCommand("@dsh review", "/dsh+")).toBeNull();
  });

  it("parses generic task intent with explicit access and multiline instructions", () => {
    expect(parseCommand("@dsh task explain the cache")).toEqual({
      operation: "task",
      instructions: "explain the cache",
      requestedAccess: "read",
    });
    expect(parseCommand("@dsh task --write repair the cache\nthen update its test")).toEqual({
      operation: "task",
      instructions: "repair the cache\nthen update its test",
      requestedAccess: "write",
    });
    expect(parseCommand("@dsh task --unknown do it")).toBeNull();
    expect(parseCommand("@dsh task")).toBeNull();
    expect(parseCommand("@dsh task --read --verbose inspect this")).toEqual({
      operation: "task",
      requestedAccess: "read",
      instructions: "--verbose inspect this",
    });
    expect(parseCommand("@dsh task --read --write do it")).toEqual({
      operation: "task",
      requestedAccess: "read",
      instructions: "--write do it",
    });
  });

  it.each(["帮我分析这个问题", "修复这个 Bug", "please explain this failure", "shell"])(
    "routes natural instructions as a read-only task: %s",
    (instructions) => {
      expect(parseCommand(`@dsh ${instructions}`)).toEqual({
        operation: "task",
        instructions,
        requestedAccess: "read",
      });
    },
  );

  it("opts direct natural writes in independently from legacy task access", () => {
    expect(parseCommand("@dsh 修复这个 Bug", "@dsh", { naturalLanguageWrite: true })).toEqual({
      operation: "task",
      instructions: "修复这个 Bug",
      requestedAccess: "write",
    });
    expect(
      parseCommand("@dsh task explain it", "@dsh", { naturalLanguageWrite: true }),
    ).toMatchObject({
      requestedAccess: "read",
    });
    expect(
      parseCommand("@dsh task --read explain it", "@dsh", { naturalLanguageWrite: true }),
    ).toMatchObject({
      requestedAccess: "read",
    });
    expect(
      parseCommand("@dsh task --write repair it", "@dsh", { naturalLanguageWrite: false }),
    ).toMatchObject({
      requestedAccess: "write",
    });
    expect(
      parseCommand("@dsh fix repair it", "@dsh", { naturalLanguageWrite: false }),
    ).toMatchObject({
      operation: "fix",
      requestedAccess: "write",
    });
  });

  it.each([
    "修复这个 Bug",
    "修复这个 Bug 并提交 PR",
    "请帮我修复这个 Bug",
    "能帮我修复这个 Bug 吗？",
    "将超时改为30秒",
    "把重试次数设置为3次",
    "修改 `src/cache.ts` 并提交 PR",
    "提交代码修复缓存问题",
    "创建一个 PR 修复这个问题",
    "Update README.md to mention X",
    "please fix this bug",
    "Could you fix this bug and open a PR?",
    "Please update README without changing runtime code",
    "Please update README without modifying runtime code",
    "Please fix the cache if needed and do not open a PR",
    "Please fix this bug but do not change any other files",
    "请修复 Bug，不要改其他文件，并提交 PR",
    "请修复 Bug，不要修改其他文件，并提交 PR",
    "Can you please change the timeout to 30 seconds?",
    "Please update `README.md` to explain installation",
    "Please update `README.md`",
    "Update `README.md`",
    "请更新 `README.md`",
    "commit these changes",
    "open a pull request for this change",
  ])("recognizes direct natural write requests only with the opt-in: %s", (request) => {
    expect(parseCommand(`@dsh ${request}`)).toMatchObject({ requestedAccess: "read" });
    expect(parseCommand(`@dsh ${request}`, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "write",
    });
  });

  it.each([
    "帮我分析这个问题",
    "解释如何修复这个 Bug 并提交 PR",
    "修复方案是什么？",
    "修复这个 Bug 的方法是什么？",
    "如何修改 README.md？",
    "不要修复这个 Bug，也不要提交 PR",
    "请不要更新 README.md",
    "如果测试失败，修复并提交 PR",
    '解释这句话："修复这个 Bug 并提交 PR"',
    '"修复这个 Bug 并提交 PR"',
    "`修复这个 Bug 并提交 PR`",
    "Please explain how to fix this bug and open a PR",
    "Could you explain how to update the README?",
    "Please do not fix this bug or open a PR",
    "Please fix this bug without changing any files",
    "Please fix this bug but only explain the changes",
    "Please fix this bug, don't change files, it's analysis only.",
    "Please fix this bug, don’t change any files.",
    "Please fix this bug, don‘t change any files.",
    "请修复这个 Bug，但不要实际修改代码",
    "请修复这个 Bug，只分析问题",
    "If needed, update README.md",
    "What would create a PR do?",
    'Please explain "update README.md"',
    '"Update README.md"',
    "'Please fix this bug'",
  ])("keeps analysis, examples, negated and ambiguous requests read-only: %s", (request) => {
    expect(parseCommand(`@dsh ${request}`, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "read",
    });
  });

  it.each([
    "Please fix this bug but do not change anything.",
    "Please fix this bug but do not modify the repository.",
    "Please fix this bug but do not edit the codebase.",
    "Please fix this bug without changing the project.",
    "Please fix this bug but do not change the `files`.",
    "请修复这个 Bug，但不要修改任何东西。",
    "请修复这个 Bug，但不要改动这个仓库。",
    "请修复这个 Bug，但不要改这个项目。",
    "Please fix this bug; I only want an explanation.",
    "Please fix this bug; tell me how to do it.",
  ])("keeps general mutation prohibitions and explanation requests read-only: %s", (request) => {
    expect(parseCommand(`@dsh ${request}`, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "read",
    });
  });

  it.each([
    "Change log analysis: why does it fail?",
    "Add this to the review?",
    "Update instructions for fixing the bug",
    "Change request analysis",
  ])("keeps questions and noun phrases read-only: %s", (request) => {
    expect(parseCommand(`@dsh ${request}`, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "read",
    });
  });

  it.each([
    "Do not change any files.\n\n@dsh Please fix this bug",
    "Only want an explanation.\n\n@dsh Please fix this bug",
    "不要修改这个仓库。\n\n@dsh 请修复这个 Bug",
    "@dsh Please fix this bug\n\n- Do not change any files.",
    "@dsh Please fix this bug\n\n1. Don’t change any files.",
    "@dsh 请修复这个 Bug\n\n- 不要修改任何文件。",
    "- Do not change any files.\n\n@dsh Please fix this bug",
  ])("applies whole-comment visible readonly constraints to natural requests: %s", (content) => {
    expect(parseCommand(content, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "read",
    });
  });

  it.each([
    "> Do not change anything.\n\n@dsh Please fix this bug",
    "```\n不要修改任何东西。\n```\n\n@dsh 请修复这个 Bug",
    "Do not change any other files.\n\n@dsh Please update README",
    "- > Do not change any files.\n\n@dsh Please update `README.md`",
    "- ```\nDo not change any files.\n```\n\n@dsh Please update `README.md`",
    "- Do not change any other files.\n\n@dsh Please update `README.md`",
  ])("keeps quoted and scoped preceding context from denying a clear request: %s", (content) => {
    expect(parseCommand(content, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "write",
    });
  });

  it.each(["fix this bug", "implement this change", "task --write repair it"])(
    "preserves explicit legacy access despite surrounding readonly prose: %s",
    (command) => {
      for (const naturalLanguageWrite of [false, true]) {
        expect(
          parseCommand(`Do not change anything.\n\n@dsh ${command}\nOnly explain.`, "@dsh", {
            naturalLanguageWrite,
          }),
        ).toMatchObject({ requestedAccess: "write" });
      }
    },
  );

  it("never obtains natural write intent from earlier or later context", () => {
    expect(
      parseCommand("修复这个 Bug 并提交 PR\n\n@dsh 帮我分析这个问题\nUpdate README.md", "@dsh", {
        naturalLanguageWrite: true,
      }),
    ).toMatchObject({ requestedAccess: "read" });
    expect(
      parseCommand("@dsh explain this\n\n> 请修复这个 Bug 并提交 PR", "@dsh", {
        naturalLanguageWrite: true,
      }),
    ).toMatchObject({ requestedAccess: "read" });
  });

  it.each([
    "@dsh Please fix this bug\nDo not change files; explain only.",
    "@dsh 请修复这个 Bug\n不要修改代码，只分析问题",
  ])("lets following prose narrow a natural request to read-only: %s", (content) => {
    expect(parseCommand(content, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "read",
    });
  });

  it.each([
    "@dsh Please fix this bug\n\n> Do not change files; explain only.",
    "@dsh 请修复这个 Bug\n```\n不要修改代码，只分析问题\n```",
    '@dsh Please fix this bug\n"Do not change files; explain only."',
    "@dsh Please fix this bug\n'Don't change files, it's analysis only.'",
  ])("does not mistake quoted or code examples for readonly constraints: %s", (content) => {
    expect(parseCommand(content, "@dsh", { naturalLanguageWrite: true })).toMatchObject({
      requestedAccess: "write",
    });
  });

  it.each(["Context before.\n@dsh", "@dsh\nContext after."])(
    "rejects a bare mention even with surrounding context: %s",
    (content) => expect(parseCommand(content)).toBeNull(),
  );

  it("preserves legacy task instructions supplied on following lines", () => {
    expect(parseCommand("@dsh task\nactual instructions")).toEqual({
      operation: "task",
      requestedAccess: "read",
      instructions: "actual instructions",
    });
  });

  it("accepts a direct request after context and preserves the full comment", () => {
    expect(parseCommand("The cache fails on startup.\n\n   @DSH 帮我分析\nMore context.")).toEqual({
      operation: "task",
      instructions: "The cache fails on startup.\n\n帮我分析\nMore context.",
      requestedAccess: "read",
    });
    expect(parseCommand("\n/dsh+ explain this", "/dsh+")).toMatchObject({
      operation: "task",
      instructions: "explain this",
    });
  });

  it.each([
    "> @dsh 帮我分析",
    "> an example\n@dsh 帮我分析",
    "```text\n@dsh 帮我分析\n```",
    "~~~\n@dsh 帮我分析\n~~~",
    "    @dsh 帮我分析",
    "\t@dsh 帮我分析",
    "`@dsh 帮我分析`",
    "Example: `\n@dsh 帮我分析\n`",
    "Example: ``\n@dsh 帮我分析\n``",
    "<!--\n@dsh 帮我分析\n-->",
    "<pre>\n@dsh 帮我分析\n</pre>",
    "<blockquote>\n@dsh 帮我分析\n</blockquote>",
  ])("ignores quoted and code examples: %s", (content) => {
    expect(parseCommand(content)).toBeNull();
  });

  it("counts only actionable mentions when rejecting ambiguous requests", () => {
    const instructions = [
      "帮我分析这个问题",
      "",
      "> @dsh fix this example",
      "",
      "```",
      "@dsh task another example",
      "```",
      "`@dsh fix`",
      "<!-- @dsh fix -->",
    ].join("\n");
    expect(parseCommand(`@dsh ${instructions}`)).toEqual({
      operation: "task",
      instructions,
      requestedAccess: "read",
    });
    expect(parseCommand("@dsh 帮我分析\n\n@dsh review")).toBeNull();
    expect(parseCommand("@dsh 帮我分析\n\n@dsh 修复这个 Bug")).toBeNull();
  });

  it("resumes matching after quoted context, fences and comments end", () => {
    expect(parseCommand("> @dsh example\n\n@dsh explain it")).toMatchObject({
      operation: "task",
    });
    expect(parseCommand("````\n```\n@dsh example\n````\n@dsh explain it")).toMatchObject({
      operation: "task",
    });
    expect(parseCommand("<!--\n@dsh example\n-->\n@dsh explain it")).toMatchObject({
      operation: "task",
    });
    expect(parseCommand("A literal unmatched `\n@dsh explain it")).toMatchObject({
      operation: "task",
    });
  });

  it.each(["- Example:\n  @dsh fix", "1. Example:\n@dsh 修复这个 Bug"])(
    "ignores mentions in Markdown list continuation: %s",
    (content) => expect(parseCommand(content)).toBeNull(),
  );

  it("accepts a direct mention after a list paragraph ends", () => {
    expect(parseCommand("- Example:\n  @dsh fix\n\n@dsh 帮我分析这个问题")).toMatchObject({
      operation: "task",
      requestedAccess: "read",
    });
  });

  it.each(["@dsh task --unknown do it", "@dsh --write do it", "@dsh task --read"])(
    "never reinterprets malformed access syntax as natural language: %s",
    (content) => {
      expect(parseCommand(content)).toBeNull();
    },
  );
});

describe("routeCommand", () => {
  it.each([
    ["issue_comment", "comment"],
    ["pull_request_review", "review"],
    ["pull_request_review_comment", "comment"],
  ] as const)("routes natural requests from the triggering %s body", (eventName, field) => {
    const context = pullRequestContext({
      rawEventName: eventName,
      eventName,
      payload: {
        [field]: { body: "@dsh 帮我分析这个问题", user: { login: "alice", type: "User" } },
      },
    });
    expect(routeCommand(context, inputs())).toEqual({
      operation: "task",
      instructions: "帮我分析这个问题",
      requestedAccess: "read",
      source: "mention",
    });
  });

  it("routes Issue natural tasks without requiring a PR", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      isPullRequest: false,
      pullRequest: undefined,
      payload: { comment: { body: "@dsh 修复这个 Bug" } },
    });
    expect(routeCommand(context, inputs())).toMatchObject({
      operation: "task",
      requestedAccess: "read",
    });
  });

  it.each([
    ["github-actions[bot]", "User", "alice"],
    ["custom-agent", "Bot", "alice"],
    ["alice", "User", "github-actions[bot]"],
  ])("ignores natural requests from bot author %s or sender %s", (author, type, actor) => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      actor,
      payload: { comment: { body: "@dsh explain it", user: { login: author, type } } },
    });
    expect(routeCommand(context, inputs({ allowedBots: ["*"] }))).toBeNull();
  });

  it("ignores bot sender payloads and preserves allowlisted legacy bot commands", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      actor: "custom-agent",
      payload: {
        sender: { login: "custom-agent", type: "Bot" },
        comment: { body: "@dsh review inspect this" },
      },
    });
    expect(routeCommand(context, inputs())).toBeNull();
    expect(routeCommand(context, inputs({ allowedBots: ["custom-agent"] }))).toEqual({
      operation: "review",
      instructions: "inspect this",
      requestedAccess: "read",
      source: "mention",
    });
    expect(
      routeCommand(
        { ...context, payload: { ...context.payload, comment: { body: "@dsh explain this" } } },
        inputs({ allowedBots: ["custom-agent"] }),
      ),
    ).toBeNull();
  });

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ] as const)(
    "keeps natural write intent behind natural-language-write=%s and allow-write=%s",
    (naturalLanguageWrite, allowWrite, canModify) => {
      const context = pullRequestContext({
        rawEventName: "issue_comment",
        eventName: "issue_comment",
        payload: { comment: { body: "@dsh 修复这个 Bug" } },
      });
      const routed = routeCommand(context, inputs({ naturalLanguageWrite, allowWrite }));
      if (routed === null) throw new Error("Expected a natural task route");
      const policy = evaluatePolicy({
        context,
        ...routed,
        commandSource: routed.source,
        allowWrite,
        permissions: permissions(true),
      });
      expect(routed.requestedAccess).toBe(naturalLanguageWrite ? "write" : "read");
      expect(policy.capabilities.modifyWorkspace).toBe(canModify);
      expect(policy.allowed).toBe(!naturalLanguageWrite || allowWrite);
    },
  );

  it("retains actor and fork authorization for natural tasks", () => {
    const context = pullRequestContext({
      fork: true,
      rawEventName: "pull_request_review_comment",
      eventName: "pull_request_review_comment",
      payload: { comment: { body: "@dsh 修复这个 Bug" } },
    });
    for (const naturalLanguageWrite of [false, true]) {
      const routed = routeCommand(context, inputs({ naturalLanguageWrite, allowWrite: true }));
      if (routed === null) throw new Error("Expected a natural task route");
      const policy = evaluatePolicy({
        context,
        ...routed,
        commandSource: routed.source,
        allowWrite: true,
        permissions: permissions(naturalLanguageWrite),
      });
      expect(policy.allowed).toBe(false);
      expect(policy.capabilities.modifyWorkspace).toBe(false);
    }
  });

  it("does not let task-access upgrade natural requests without the independent switch", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: { comment: { body: "@dsh 修复这个 Bug" } },
    });
    expect(routeCommand(context, inputs({ taskAccess: "write", allowWrite: true }))).toMatchObject({
      requestedAccess: "read",
    });
    expect(
      routeCommand(context, inputs({ taskAccess: "read", naturalLanguageWrite: true })),
    ).toMatchObject({
      requestedAccess: "write",
    });
  });

  it("automatically reviews supported pull request actions", () => {
    expect(routeCommand(pullRequestContext(), inputs())).toMatchObject({
      operation: "review",
      source: "automatic-event",
    });
  });

  it("takes commands only from the triggering comment field", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: { comment: { body: "@dsh diagnose now" }, repositoryReadme: "@dsh fix" },
    });
    expect(routeCommand(context, inputs())).toEqual({
      operation: "diagnose",
      source: "mention",
      instructions: "now",
      requestedAccess: "read",
    });
  });

  it("uses the configured trigger phrase without broadening comment parsing", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: { comment: { body: "/deepseek diagnose now" } },
    });
    expect(routeCommand(context, inputs({ triggerPhrase: "/deepseek" }))).toMatchObject({
      operation: "diagnose",
      source: "mention",
      instructions: "now",
    });
    expect(routeCommand(context, inputs())).toBeNull();
  });

  it("keeps GitHub image sources out of trusted mention instructions", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        comment: {
          body: "@dsh task --read inspect this\n![upload](https://github.com/user-attachments/assets/secret)",
        },
      },
    });
    expect(routeCommand(context, inputs())).toMatchObject({
      operation: "task",
      instructions: "inspect this\n[image removed]",
      source: "mention",
    });
  });

  it("removes reference, HTML, and raw attachment sources from command instructions", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        comment: {
          body: [
            "@dsh task --read inspect these",
            "![upload][attachment]",
            "[attachment]: https://github.com/user-attachments/assets/example?token=secret",
            '<picture><source srcset="https://example.test/a"><img src="https://example.test/b"></picture>',
            "raw https://user-images.githubusercontent.com/1/example.png?sig=secret",
          ].join("\n"),
        },
      },
    });
    const routed = routeCommand(context, inputs());
    expect(routed?.instructions).not.toContain("user-attachments");
    expect(routed?.instructions).not.toContain("example.test");
    expect(routed?.instructions).not.toContain("user-images.githubusercontent.com");
    expect(routed?.instructions).toContain("[image removed]");
  });

  it("applies the same text-only boundary to configured prompts", () => {
    const routed = routeCommand(
      pullRequestContext(),
      inputs({
        command: "review",
        prompt:
          'inspect <img src="https://example.test/private.png"> and https://github.com/user-attachments/assets/example?token=secret',
      }),
    );
    expect(routed?.instructions).toBe("inspect [image removed] and [image removed]");
  });

  it("routes maintainer-configured label and assignee events by entity kind", () => {
    const issue = pullRequestContext({
      rawEventName: "issues",
      eventName: "issues",
      eventAction: "labeled",
      isPullRequest: false,
      pullRequest: undefined,
      payload: { label: { name: "dsh-ready" } },
    });
    expect(
      routeCommand(
        issue,
        inputs({ labelTrigger: "DSH-READY", taskAccess: "write", prompt: "handle issue" }),
      ),
    ).toEqual({
      operation: "task",
      source: "automatic-event",
      instructions: "handle issue",
      requestedAccess: "write",
    });

    const pull = pullRequestContext({
      eventAction: "assigned",
      payload: { assignee: { login: "review-bot" } },
    });
    expect(
      routeCommand(pull, inputs({ assigneeTrigger: "@Review-Bot", taskAccess: "write" })),
    ).toEqual({
      operation: "review",
      source: "automatic-event",
      instructions: "",
      requestedAccess: "read",
    });
    expect(routeCommand(issue, inputs({ labelTrigger: "other" }))).toBeNull();
  });

  it("applies allowed-actors only as a routing filter", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      actor: "outsider",
      payload: { comment: { body: "@dsh review" } },
    });
    expect(routeCommand(context, inputs({ allowedActors: ["maintainer"] }))).toBeNull();
    expect(routeCommand(context, inputs({ allowedActors: ["*"] }))).toMatchObject({
      operation: "review",
      source: "mention",
    });
  });

  it.each([
    ["pull_request_review", { review: { body: "@dsh review" } }],
    ["pull_request_review_comment", { comment: { body: "@dsh diagnose" } }],
  ] as const)("routes %s trigger bodies", (eventName, payload) => {
    expect(
      routeCommand(pullRequestContext({ rawEventName: eventName, eventName, payload }), inputs()),
    ).toMatchObject({ source: "mention" });
  });

  it("ignores unsupported PR actions and unrelated comments", () => {
    expect(routeCommand(pullRequestContext({ eventAction: "closed" }), inputs())).toBeNull();
    expect(
      routeCommand(
        pullRequestContext({
          rawEventName: "issue_comment",
          eventName: "issue_comment",
          payload: { comment: { body: "ordinary discussion" } },
        }),
        inputs(),
      ),
    ).toBeNull();
  });

  it("routes read-only workflow failures to diagnosis", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [] },
    };
    expect(routeCommand(context, inputs())).toMatchObject({ operation: "diagnose" });
    expect(
      finalizeWorkflowRunRoute(
        context,
        {
          operation: "review",
          source: "explicit-input",
          instructions: "",
          requestedAccess: "read",
        },
        false,
      ),
    ).toMatchObject({ operation: "review" });
  });

  it("lets explicit trusted inputs select an operation", () => {
    expect(
      routeCommand(pullRequestContext(), inputs({ command: "fix", prompt: "repair" })),
    ).toEqual({
      operation: "fix",
      source: "explicit-input",
      instructions: "repair",
      requestedAccess: "write",
    });
  });

  it("routes a non-empty automation prompt into generic task mode", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_dispatch" as const,
      eventName: "workflow_dispatch" as const,
      eventAction: "requested",
    };
    expect(
      routeCommand(
        context,
        inputs({ command: "auto", prompt: "upgrade dependencies", taskAccess: "write" }),
      ),
    ).toEqual({
      operation: "task",
      source: "explicit-prompt",
      instructions: "upgrade dependencies",
      requestedAccess: "write",
    });
  });

  it("routes a failed workflow run to opt-in auto-fix when write is enabled", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [7] },
    };
    expect(routeCommand(context, inputs({ allowWrite: true }))).toMatchObject({
      operation: "fix",
      source: "automatic-event",
    });
  });

  it("downgrades automatic workflow_run fix to diagnosis when no PR resolves", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [] },
    };
    const routed = routeCommand(context, inputs({ allowWrite: true }));
    if (routed === null) throw new Error("Expected workflow_run to be routed");
    expect(finalizeWorkflowRunRoute(context, routed, false)).toMatchObject({
      operation: "diagnose",
      source: "automatic-event",
    });
  });

  it("keeps automatic workflow_run fix when a PR resolves", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [7] },
    };
    const routed = routeCommand(context, inputs({ allowWrite: true }));
    if (routed === null) throw new Error("Expected workflow_run to be routed");
    expect(finalizeWorkflowRunRoute(context, routed, true)).toMatchObject({ operation: "fix" });
  });
});
