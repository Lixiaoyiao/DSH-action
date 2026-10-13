# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[中文](README.zh-CN.md)

Run DeepSeek Harness directly from GitHub pull requests, issues, failed CI jobs, and maintainer-authored automations.

```text
GitHub PR / Issue / CI  →  DeepSeek Harness  →  Review / Diagnose / Fix / Issue → PR
```

The Action starts a credential-isolated DSH worker, validates its structured result, and lets a trusted Controller publish comments or validated changes. This is a community project, not an official DeepSeek or GitHub product. It is maintained by [@Lixiaoyiao](https://github.com/Lixiaoyiao).

## Quick Start

Run the installer anywhere inside the existing GitHub repository you want to configure:

```bash
npm create deepseek-harness-action@latest
```

In a terminal, the default guided flow starts with **read-only PR Review**.
It finds the Git root and `github.com` origin, checks GitHub CLI availability
and login, then creates an immutable-SHA workflow after your confirmation.
It creates no remote repository. If logged in, you can set `DEEPSEEK_API_KEY`
using hidden input; the key goes to `gh` through stdin and is never logged or
placed in command arguments. Missing login or Secret access prints recovery
steps, and rerunning preserves the identical generated workflow.

Commit and push each need a separate confirmation, defaulting to No. The
installer commits only its generated workflow, preserves other changes,
refuses an existing staged set, and runs no repository hooks or filters.
Its unsigned commit and checked non-force push require a compatible existing
branch; signed commits or other unpublished history can be completed manually.
The workflow must reach the default branch before opening a non-draft PR.

Use `--advanced` for interactive workflow and controlled/native choices:

```bash
npm create deepseek-harness-action@latest -- --advanced
```

Advanced choices are **PR Review**, **@dsh Coding Commands**, **Both**, and
**Automatic Session**. This flow and explicit `--mode` flags generate files
only. For CI or another non-interactive environment, pass the mode explicitly:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

With explicit `--mode`, omitting `--dsh-mode` keeps `controlled` in any
environment. Select native composition explicitly when needed:

```bash
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

Automatic Session creates a read-only starter with `queue: max` to retain pending
follow-ups. Commit it to the default branch and dispatch there with a lowercase
key. Reuse the key with a new prompt; no source run ID is needed. Failed,
expired, corrupt or unknown history requires reconciliation.

```bash
npm create deepseek-harness-action@latest -- --mode session
```

Installer `0.6.1` targets formal Action `v0.10.2`, retaining exact DSH
`0.2.0-rc.2`. Packing receives the verified full Action commit through
`DSH_ACTION_RELEASE_SHA` only after tag, Release and canary identity checks.
The separate immutable installer source tag is
`create-deepseek-harness-action-v0.6.1`; neither identity is guessed.

If guided setup did not configure the Secret, add `DEEPSEEK_API_KEY` under
**Settings → Secrets and variables → Actions**. Once the workflow reaches the
default branch, open or update a non-draft PR. For Coding Commands, put `@dsh`
on the first line of an Issue or PR comment and configure trusted validation
before requesting a write. See [Setup](docs/setup.md) for resume and manual steps.

### Manual installation

Add `DEEPSEEK_API_KEY` under **Settings → Secrets and variables → Actions**, then create `.github/workflows/dsh-review.yml`:

```yaml
name: DSH review

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
          fetch-depth: 1
      - uses: Lixiaoyiao/deepseek-harness-action@v0.10.2
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.2.0-rc.2
```

Open a non-draft pull request. The Action checks out only the trusted base SHA, reads the pull request through GitHub APIs, and never executes fork code.

For production, pin the complete commit published in the corresponding GitHub Release. Resolve the corresponding immutable release tag to its full SHA after qualification; the installer version and its Action binding are independent release identities. See [Setup](docs/setup.md) for permissions, pinning, checkout rules, and complete templates.

## Core capabilities

| Capability              | What it does                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pull request review     | Reviews new commits, publishes one summary, and adds high-confidence inline findings                        |
| General tasks           | Answers repository questions or performs an explicitly authorized coding task                               |
| CI diagnosis and repair | Reads failed checks and logs; trusted workflows may validate and publish a fix                              |
| Issue implementation    | Turns an authorized Issue request into a validated branch and pull request                                  |
| Composition modes       | Keeps the existing controlled tool profile by default and offers an experimental native DSH mode            |
| Controlled tools        | Adds exact profiles for native, fixed-command, typed Controller GitHub, MCP, Bundle, and Plugin tools       |
| Structured results      | Keeps the schema-v1 audit envelope and can validate an optional maintainer-defined task result              |
| Explicit Session resume | Continues a completed task in a new Actions run using a verified raw DSH checkpoint and current permissions |

v0.9.2 retains the experimental `dsh-mode: native` path over the locked DSH `0.2.0-rc.2` runtime and its official ecosystem composition. Native MCP servers, Profile Bundles, direct Cordis Plugins, repository Skills, Subagents, and Workflows retain DSH-native discovery and behavior. `controlled` remains the compatible default, so workflows that omit `dsh-mode` retain their existing composition, permissions, tools, budgets, receipts, and outputs.

Native mode is not an unsafe mode. It returns ownership of DSH's internal headless composition, capability graph, and model-visible inventory to DSH. Native MCP servers load through official `@deepseek-ai/dsh-mcp-client`; Bundles become official Profile layers; direct Plugins load through Cordis; and repository Skills, Subagents, and Workflows retain DSH-native behavior. Its definition-only extension schema declares owners and process requirements, not Action tools, grants, or per-tool budgets. Dynamic ecosystem tools appear only in runtime `observedTools`, and native `toolPolicy` never claims Controller `effectiveTools`.

The Action still owns trusted-workflow admission, exact package pins, lifecycle-script suppression, runtime inventory audit, Docker and `.git`-less workspace boundaries, the run-scoped DeepSeek credential proxy, GitHub credential isolation, actor/repository trust, validation and deferred writes, deadlines, cancellation, and secret redaction. Native remains Docker-only. Bridge network and read/write mounts are whole-worker capabilities, not per-extension or per-tool sandboxes. A user-configured GitHub MCP with its own credential is a trusted external extension whose direct effects do not receive the Controller Gateway's binding, revalidation, validation, or deferred-mutation guarantees. Controller-owned `command.*` and `github.*` capabilities remain a separate, mode-independent plane.

v0.10.0 adds [automatic Session creation and continuation by key](docs/session.md), retaining explicit save/resume. A trusted workflow discovers the latest successful compatible checkpoint; failed, unknown, missing, expired or corrupt history prevents silent fallback. Matching workflow identity and concurrency bindings serialize one key while allowing different keys to run concurrently. The existing Controller / DSH / Gateway / validation ownership, exact `0.2.0-rc.2` pin and default-off Session path remain. Current authority is recalculated; previous GitHub writes are not replayed. [Text file context](docs/text-files.md), [offline configuration checks](docs/configuration-check.md) and [bounded GitHub diagnostics](docs/github-requests.md) remain available. Native image and Office attachments remain deferred for the [documented runtime/transport reasons](docs/v0.9.2-runtime-audit.md).

## Live runs

These public runs show the comments and Actions logs produced by this repository.

| Scenario                                                | Run                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR review, including a rerun without duplicate comments | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| Diagnosis based on failed checks and logs               | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| Fix and validation in trusted write mode                | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| Issue implementation followed by a pull request         | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## Common `@dsh` commands

Put the command on the first line of an Issue or pull request comment.

| Command                       | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `@dsh task --read <question>` | Explain code, inspect the repository, or answer a general question |
| `@dsh task --write <task>`    | Request a coding task; every write gate must still pass            |
| `@dsh review`                 | Review the current pull request again                              |
| `@dsh diagnose`               | Diagnose failed checks and logs                                    |
| `@dsh fix`                    | Repair a same-repository pull request in trusted write mode        |
| `@dsh implement`              | Implement an Issue and open a pull request                         |

`--write`, `fix`, and `implement` request capabilities; they do not grant them. The workflow must explicitly enable write mode and provide Controller-run validation. See [Usage](docs/usage.md) for commands and automation, and [Configuration](docs/configuration.md) for the gates.

Maintainers can change the trigger phrase, add label/assignee routes, filter actors or historical comments, select a base branch, and choose a deterministic branch template. These settings change routing and naming only; GitHub authority still comes from the Controller policy and workflow token scopes.

## Security

- The Agent receives neither the real `GITHUB_TOKEN` nor the real DeepSeek key. Only the Controller can call Action-owned `github.*` mutation APIs; an explicitly configured external GitHub MCP uses its own credential and authority as described below.
- Repository content, diffs, issues, pull requests, comments, logs, model output, and tool output remain untrusted data.
- Fork review uses a `.git`-less, credential-free worker and must check out only the trusted base SHA with `persist-credentials: false`.
- Writes require a trusted same-repository context, authorized actors, Docker, `allow-write: "true"`, non-empty fixed validation commands, and successful validation. Protected-path and Validation Integrity checks still apply.
- Typed `github.*` mutations are exact-ID, entity-bound, deferred until Controller validation, and reconciled with bounded receipts. No arbitrary REST, GraphQL, URL, or credential pass-through exists.
- Validation Integrity provides high-confidence weakening detection plus baseline replay for its supported entrypoints, scripts, test/config weakening, lock/toolchain controls, and known wrappers/interpreters; it is not complete cross-language dependency provenance or a formal proof.
- Validation may use Docker bridge networking. On self-hosted or corporate-network runners, repository validation code may reach runner-accessible network services; use dedicated runners and runner-level segmentation/egress controls.
- An approved Bundle, Plugin, or stdio MCP server is trusted worker code. Controlled ToolRuntime limits model-routed calls; native leaves routing and inventory to DSH. Neither model is a sandbox for extension startup, background work, or direct process I/O, and any bridge/RW capability applies to the whole worker.
- `github.*` uses the Controller GitHub Gateway. A separately configured GitHub MCP uses its own external credential and is outside the Gateway's binding, revalidation, validation, and deferred-write guarantees.

Read the complete [Security policy](SECURITY.md) before enabling write mode, host execution, network access, or third-party extensions.

## Documentation

| Guide                                                              | Contents                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [Setup](docs/setup.md) · [中文](docs/setup.zh-CN.md)               | Installer, manual setup, Secret, permissions, safe checkout, and templates           |
| [Usage](docs/usage.md) · [中文](docs/usage.zh-CN.md)               | `@dsh` commands, tasks, review, diagnose, fix, implement, and automation             |
| [Configuration](docs/configuration.md)                             | Inputs, permission profiles, tools, validation, extensions, and outputs              |
| [Architecture](ARCHITECTURE.md) · [Invariants](docs/invariants.md) | Component ownership, authority boundaries, and stable system invariants              |
| [Troubleshooting](docs/troubleshooting.md)                         | Denials, Docker, timeouts, cancellation, validation, and extension failures          |
| [Security policy](SECURITY.md)                                     | Trust model, credential boundaries, network behavior, and known limitations          |
| [Extension contracts](docs/extension-contracts.md)                 | Deep technical contracts for MCP, Profile, Bundle, Plugin, ToolRuntime, and receipts |
| [Maintainer release guide](docs/maintainer-release.md)             | Local checks, Core E2E, release canary, version updates, and publishing              |
| [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)        | Development workflow and release history                                             |

## Development

Node.js 24 is required.

```bash
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The Marketplace `dist/` bundle is committed for releases and must not be edited by hand.

## License

[MIT](LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [BUNDLED_DEPENDENCIES.md](BUNDLED_DEPENDENCIES.md).

DeepSeek Harness supplies the headless runtime and official extension mechanisms. The GitHub integration also draws on the MIT-licensed [Claude Code Action](https://github.com/anthropics/claude-code-action) patterns and the execution/publication separation described by [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action); exact attributions are recorded in the third-party notices.
