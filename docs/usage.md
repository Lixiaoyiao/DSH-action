# Usage

[中文](usage.zh-CN.md) · [README](../README.md) · [Setup](setup.md) · [Configuration](configuration.md)

DeepSeek Harness can run from automatic repository events, natural-language `@dsh` requests, existing commands, or an explicit prompt in a maintainer-authored automation workflow.

## How operations are selected

| Entry point                                                                                  | Resolved operation |
| -------------------------------------------------------------------------------------------- | ------------------ |
| Pull request `opened`, `synchronize`, `ready_for_review`, or `reopened` with `command: auto` | `review`           |
| Failed `workflow_run` with the diagnosis template                                            | `diagnose`         |
| Failed `workflow_run` with the trusted auto-fix template                                     | `fix`              |
| `@dsh Help me understand this issue`                                                         | `task`             |
| `@dsh task ...`                                                                              | `task`             |
| `@dsh review`                                                                                | `review`           |
| `@dsh diagnose`                                                                              | `diagnose`         |
| `@dsh fix`                                                                                   | `fix`              |
| `@dsh implement` on an Issue                                                                 | `implement`        |
| Maintainer-configured label or assignee on an Issue                                          | `task`             |
| Maintainer-configured label or assignee on a pull request                                    | `review`           |
| Dispatch or schedule with `command: auto` and a non-empty `prompt`                           | `task`             |

For an interactive request, start `@dsh` on an unquoted, non-code line, with at most three leading spaces. Earlier lines may supply context; later lines may continue the instruction. Use exactly one actionable mention in each comment. Mid-sentence mentions, Markdown quotes (including their continued paragraphs), fenced/indented code, inline code and HTML comments are ignored. A bare `@dsh` without a request does not start a task. The Controller authorizes every originating actor before treating the request as trusted operator instruction; permission lookup failure denies it.

Issue/PR conversation comments, PR review bodies and inline review comments are supported when their events are subscribed by the workflow. Bot-authored natural requests are ignored. Explicitly allowed bots can continue to use existing commands under the normal authorization policy.

For fork PRs, ask `@dsh` in a top-level **Conversation** comment. Review/inline comment events may lack the Actions secrets or token permissions needed to run the Action.

The workflow's `if: contains(..., '@dsh')` expression is only a coarse job filter. Keep it aligned when changing `trigger-phrase`; the Action still performs exact parsing, context checks, and authorization. Label/assignee routes and actor/comment filters are maintainer-controlled routing only and never grant trust.

## General tasks

Ask directly for repository questions or code analysis:

```text
@dsh Help me understand this issue
@dsh 帮我分析这个问题
```

Natural language selects a general `task` and defaults to read-only. `@dsh Please fix this bug` also stays read-only: the verb does not grant access or select the specialized `fix` operation. The guided installer enables these conversations and automatic PR Review without code-write authority.

Natural-language writes have an independent `natural-language-write` switch, defaulting to `false`. Even with that switch enabled, a request must clearly ask to change code, for example:

```text
@dsh Please fix this bug and open a PR
@dsh 修复这个 Bug 并提交 PR
@dsh 修复这个 Bug
```

An explicit request to publish is optional; a direct change request is enough to request write access. The Controller still selects the permitted delivery path for the Issue or PR.

Questions, ambiguous instructions and requests to explain how to make a change remain read-only. The workflow must also set `allow-write: "true"`, use a write-capable permission profile and keep all validation and authorization gates below. The advanced Commands starter leaves `natural-language-write: "false"`; enable it deliberately after configuring your project's validation. Setting `task-access: write` alone does not change natural-language access.

The first word after `@dsh` reserves `task`, `review`, `diagnose`, `fix` and `implement` as existing commands, case-insensitively. `@dsh fix this bug` therefore requests the legacy `fix` operation, which the read-only starter denies; the natural-language switch does not change legacy commands. Use `@dsh Please fix this bug` for natural language.

Existing explicit task commands remain available:

```text
@dsh task --read Explain why this pull request needs a two-phase commit
@dsh task --write Add empty-input coverage to the parser and run validation
```

`--read` is the default when the access flag is omitted. A read task can inspect only the tools left by the effective trust and permission policy.

`--write` requests a capability; it does not authorize it. The workflow must also set `allow-write: "true"`, keep `run-tests: "true"`, provide at least one validation argv array for an actual mutation, run in an eligible same-repository context that is not `pull_request_target`, pass every actor and identity check, and retain `workspace.edit` after policy intersection. A fork pull request can never be upgraded to write mode.

Result delivery depends on the target:

- A read task attached to an Issue or PR reuses one Controller-owned task comment.
- A read automation without an Issue or PR returns through the step summary and outputs.
- An Issue-backed or entity-free write task creates a Controller-owned branch and pull request; it never pushes directly to the selected base branch. Defaults preserve `dsh/task-*`; custom prefixes/templates remain deterministic and retain the Controller key.
- A write task attached to a same-repository PR can affect only the bound and revalidated PR head branch.
- If an authorized write task produces no repository change, it may publish its final answer but creates no commit, ref, PR, or release mutation.

## Pull request review

Automatic review is the simplest entry point. The Action reads the bound diff and repository context, publishes one summary, and adds inline comments only for selected high-confidence findings. Re-running the same operation updates the Controller-owned summary marker instead of creating another summary comment.

To request another review manually, comment:

```text
@dsh review
```

Fork and `pull_request_target` review remain read-only. The workflow must check out only the trusted base SHA; the worker receives no repository tools in the untrusted profile and never executes fork code.

## CI diagnosis

Use [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml) to run after a failed CI workflow. The Controller selects checks and logs by repository and immutable head SHA, bounds and redacts them, and labels them as untrusted before DSH reads them.

An authorized maintainer can also request:

```text
@dsh diagnose
```

Diagnosis is read-only. It publishes the cause and suggested next step; it does not grant a shell or modify the repository.

## Fix a pull request

On an eligible same-repository pull request, use:

```text
@dsh fix
```

The workflow must explicitly enable trusted write mode and fixed validation commands. DSH edits a disposable `.git`-less workspace; the Controller checks actual changes, protected paths, validation, and Validation Integrity before it creates a commit or updates the bound PR branch. No write-task lifecycle comment is published before final validation succeeds.

See [`examples/commands.yml`](../examples/commands.yml) for interactive fixes and [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml) for a failed-CI repair workflow.

## Implement an Issue

On an Issue, comment:

```text
@dsh implement
```

After authorization, the Controller binds the Issue and maintainer-selected base head, runs the same edit and validation gates, creates a dedicated branch, and opens a pull request. Editing the bound Issue specification or moving the selected base head during the operation causes the write to fail closed. Merging the resulting PR is a separate maintainer action.

## Explicit automation

Automation is a workflow pattern, not an `@dsh automation` command. On `workflow_dispatch`, `repository_dispatch`, or `schedule`, `command: auto` plus a non-empty `prompt` selects `task`. You can set `command: task` explicitly; then `prompt` is required.

```yaml
with:
  command: auto
  prompt: "Check the dependency boundary, add tests if needed, and explain the result"
  task-access: read
```

`task-access` defaults to `read`. A write value still passes every normal write gate and, for an Issue-backed or entity-free task, produces a branch and PR rather than a direct default-branch push.

`prompt` is trusted control-plane configuration. Populate it only from a maintainer-authored workflow or a dispatch input whose callers you trust. Do not promote Issue bodies, PR content, logs, repository files, or model output into `prompt`. Apply the same provenance rule to all capability-bearing inputs, especially permission profiles, tool lists, validation, container/runtime, network endpoints, and extension configuration.

The full read/write dispatch template is [`examples/task-automation.yml`](../examples/task-automation.yml). Custom triggers, typed GitHub tools, safe branch UX, and structured task output are shown in [`examples/github-integration.yml`](../examples/github-integration.yml).

## Multi-turn tools, validation, and repair

Every outer iteration is a fresh DSH turn bound to the same task, workspace, and Controller policy:

```text
DSH turn
  ├─ needs_tool → an allowed tool runs → bounded, redacted result → next turn
  ├─ final → Controller validation fails → bounded output → repair turn
  ├─ final → validation passes → Controller publishes or writes
  └─ blocked → neutral only when no Controller validation failure is pending
```

`max-turns` defaults to 3 and counts tool requests and validation repair turns. The Action's `timeout-minutes` is the overall setup and execution deadline. Runtime setup, extension installation, each Agent turn, and validation also have independent caps. Repeating the same validation failure on the same workspace revision stops with a no-progress error.

A repair turn cannot erase an unresolved validation or Validation Integrity failure by returning `blocked`, exhausting its turns, or emitting malformed structured output. The original Controller failure remains authoritative until a later finalization passes.

## Progress and results

For an authorized read operation with an Issue or PR target, the Controller updates one sticky comment during major lifecycle stages and reuses the same marker for the final result.

| Operation           | Marker      |
| ------------------- | ----------- |
| `task`              | `task`      |
| `review`            | `summary`   |
| `diagnose`          | `diagnosis` |
| `fix` / `implement` | `write`     |

`progress-comment` defaults to `true`. Setting it to `false` disables intermediate lifecycle updates only; normal summaries, inline findings, diagnoses, and authorized final results remain enabled.

Write requests deliberately publish no lifecycle/status comment until validation succeeds or actual-change inspection confirms a no-change task. On failure, inspect the step summary and outputs. The Action sets scalar outputs and the schema-v1 `result-json` on success, neutral, and failure paths. A configured task schema adds only a Controller-validated `task-output`/`taskOutput` value; it does not replace the audit envelope.

Cancellation finalization is bounded and best effort. `SIGTERM` or `SIGINT` can update an eligible sticky comment, but `SIGKILL`, runner/host loss, a process crash, or GitHub API failure can leave it at “In progress.” See [Troubleshooting](troubleshooting.md) and treat the Actions conclusion as authoritative.

For the complete output schema and a safe `always()` consumption example, see [Configuration](configuration.md#outputs).

## Workflow templates

- [Fork-safe review](../examples/fork-review.yml)
- [Interactive commands](../examples/commands.yml)
- [CI diagnosis](../examples/ci-diagnose.yml)
- [Trusted CI auto-fix](../examples/ci-auto-fix.yml)
- [General task automation](../examples/task-automation.yml)
- [GitHub integration options](../examples/github-integration.yml)
- [Controlled extensions](../examples/controlled-extensions.yml)

All templates keep checkout credentials disabled. Replace their release tag with the corresponding immutable release commit SHA before production use.
