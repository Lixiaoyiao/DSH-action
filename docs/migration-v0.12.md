# v0.12 migration and evaluation

This branch prepares Action **v0.12.0** and installer **0.7.2**. They are not
published. Main, Tags and npm publication require the user's final confirmation.
The production fallback is immutable v0.11.0 commit
`24618e72a7a9154142a601f3181ccdaef0ddf84c`.

## Inputs and tool execution

Replace `max-turns: N` with `max-controller-steps: N`; the default remains 3 and
the range remains 1–10. The shared budget counts initial execution, Controller
tool calls and validation repair attempts. Provider-specific call limits still
apply across the complete run. The obsolete input is rejected with migration
guidance rather than silently ignored.

Controller tools now run through DSH's official MCP client. The model calls real
tools and returns protocol v2 `final` or `blocked` JSON. Custom model fixtures must
replace `needs_tool/toolRequest` with ordinary tool-call/tool-result exchanges.
The business result schema, GitHub coordinates, fixed argv and final mutation
flush remain Controller-owned. Both compositions and existing host restrictions
remain supported; native still requires Docker.

Pure metadata tasks can use a read-only worker. Within a trusted, entity-bound
Issue/PR task, an explicit grant can be configured without repository validation:

```yaml
with:
  command: task
  task-access: read
  allow-write: "true"
  permission-profile: custom
  allowed-tools: '["github.issue.labels.set"]'
  run-tests: "false"
```

Current actor write permission, the workflow token scope and the bound entity
are still checked. This does not grant workspace editing, arbitrary commands,
commits or PR creation. Code persistence continues to require reviewed test
commands, integrity policy, current authorization and target revalidation.

## Three Action outputs and one report

Only `conclusion`, `summary`, and `result-json` remain. The JSON is a bounded
`schemaVersion: 2` RunReport, also consumed by the Markdown renderer.

| Previous scalar or JSON path                                  | v0.12 replacement inside `result-json`                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `review-summary`                                              | Use the retained `summary` output.                                              |
| `operation`                                                   | `operation.kind`                                                                |
| `findings-count`                                              | `operation.findingsCount`                                                       |
| `task-output`, `taskOutput`                                   | `operation.taskOutput`                                                          |
| `dsh-mode`, `dsh-composition`, `dsh`                          | `context.dsh.mode`, `context.dsh.composition`                                   |
| `trust`, `policy`                                             | `context.policy`                                                                |
| `permission-profile`, `effective-tools`, `permissions`        | `context.permission`                                                            |
| `network-access`, `workspace-write`, `trusted-extensions`     | `context.permission.network`, `.workspaceWrite`, `.trustedExtensions`           |
| `toolPolicy`, `authority`, `githubRequests`, `textSources`    | Same names under `context`.                                                     |
| `duration-ms`, `timing.durationMs`                            | `termination.durationMs`                                                        |
| `status`, `error-code`, `error-message`, `error`              | `termination.status`, `termination.error`                                       |
| `branch-name`, `pull-request-url`, `commit-sha`, `comment-id` | `publication.branchName`, `.pullRequestUrl`, `.commitSha`, `.commentId`         |
| `write.status`, `write.changedPaths`                          | `publication.writeStatus`, `publication.changedPaths`                           |
| Review `publication`                                          | `publication.review`                                                            |
| `loop`, `isolation`, `modelUsage`                             | `agent`, `agent.isolation`, `agent.usage`                                       |
| `extension-profile-digest`, `extensions`                      | `agent.extensionAudit`                                                          |
| `tool-receipts`                                               | `agent.toolReceipts`, `agent.dshToolReceipts`, optional `agent.receiptsDropped` |

Confirmed publication, validation and checkpoint facts remain visible when a
later step fails. Metadata-only validation is `not-applicable`, not a fabricated
passed suite. Worker observations and receipts remain telemetry, never authority.

## Session keys

Auto/save/resume, raw history and official image/file attachment bytes remain
supported. Manifest v2 rejects v0.11 checkpoints before worker startup, including
automatic continuation: it never silently creates replacement history.

Use a new maintainer-selected key, for example `issue-42-v012`, when evaluating
this version. Keep the prior key and artifacts with v0.11.0 for rollback. There is
no byte-rewriting conversion of old history and no replay of historical tools or
GitHub mutations. Every restored run recomputes current permissions and creates
fresh tool connections. Retention, provenance and corruption checks still apply.

## Installer and rollout

Installer 0.7.2 source templates retain the release-SHA build token. Evaluation
must use an explicitly identified candidate; no guessed production SHA is filled
in and no tarball is published. After final approval, a qualified immutable Action
SHA must be bound before preparing a release archive.

Review the complete comparison and test results before deciding whether to keep
this design. A clearer internal structure does not itself prove lower total
maintenance cost or justify replacing v0.11.0.
