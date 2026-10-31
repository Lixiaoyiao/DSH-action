# Native project configuration

The Action controls GitHub events, credentials, Docker, network access, deadlines,
validation and publication. DSH controls its model, Agent, plugins, MCP, prompts,
tools and subagents through its native Profile. These changes are unreleased.

## Files and source trust

Commit `.dsh/package.json` and `.dsh/cordis.patch.yml`. The optional `dsh-profile`
input selects another repository-relative Profile directory; `auto` discovers
`.dsh`. A missing auto-discovered directory retains legacy workflow support. A
present invalid Profile, or a missing explicitly selected directory, is an error.

The Controller reads immutable Git objects from the verified PR **base** commit,
or the repository default branch for other events. PR-head configuration is never
executed. Files must be ordinary Git files: no symlinks, submodules or traversal.
Profiles are bounded to 256 files and 8 MiB. The selected directory and its digest
appear in `result-json.configuration`.

The run copies that source into a disposable Profile. It uses DSH 0.2.1-rc.2's
`loadProfileDirectory`, ordered Bundle patches and official Cordis composition.
`.dsh` is an application-selected Profile directory; the standalone DSH CLI does
not automatically discover it just because the current directory is a repository.

```json
{
  "name": "dsh-project-profile",
  "private": true,
  "type": "module",
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    }
  },
  "dependencies": {}
}
```

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
- id: system-prompt
  config:
    personaPrefix: "Explain observed results and distinguish incomplete work."
```

Cordis replaces an entry's `config` as a whole; it does not deep-merge arbitrary
objects. Include required sibling fields when replacing a config. Bundle order
is preserved. User patches follow Bundle patches. Action-owned transport,
current task, JSON output, Session admission, workspace and credential fields
are applied last. Non-owned model/plugin settings remain intact.

Source files are never rewritten. Native parser expressions remain inert in the
Controller and are evaluated only by the Worker. Internal launcher
and helper filenames are reserved. A skipped Bundle, failed required extension,
or unapplied project patch is reported as a configuration/startup failure.

## Controlled and Native

Both modes use the same native Profile. Controlled remains the default. Native
lets DSH discover and expose its own inventory; observations do not grant
Controller GitHub authority. Neither mode can acquire the Controller's GitHub
token or real DeepSeek key, waive validation or persist changes independently.

Controlled tool requests and budgets live in the existing policy plugin's native
Cordis configuration:

```yaml
- id: dsh-action-policy
  config:
    allowedTools:
      - workspace.read
      - workspace.search
      - native.web-search
      - native.web-fetch
      - mcp.docs.lookup
    deniedTools: []
    rules:
      - id: mcp.docs.lookup
        runtimeName: mcp__docs__lookup
        permissions: [read, network]
        timeoutMs: 60000
        maxOutputBytes: 131072
        maxCalls: 10
        groupMaxCalls: 30
- insert:
    - id: docs-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: docs
        transport: streamable-http
        url: https://example.com/mcp
        headers:
          Authorization: !!js "'Bearer ' + process.env.HARNESS_DOCS_TOKEN"
        failOnStartupError: true
```

Replace the example MCP endpoint with your server. Tool schemas and descriptions
come from DSH/MCP; they are not duplicated in workflow JSON. Controlled extension
runtime names must belong to their `mcp__owner__` or `plugin__owner__` namespace.
Aliases cannot grant builtin Bash, editors or subagents. Explicit denies win;
the Controller intersects requests with current actor and write authority.
Unlisted tools stay hidden, and agent-scoped tools cannot bypass the post-check.
The policy entry is inactive in Native mode and is reported as such.

Extra credentials use explicit names, with values supplied through GitHub Secrets:

```yaml
with:
  deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
  dsh-env: '["HARNESS_DOCS_TOKEN"]'
env:
  HARNESS_DOCS_TOKEN: ${{ secrets.HARNESS_DOCS_TOKEN }}
```

Reserved runtime/loader/Controller variables and aliases containing Controller
credential values are rejected. Extra environment values are withheld from
untrusted runs. An untrusted PR receives bounded context and does not activate
project extensions or execute PR configuration; its network switch remains
independent.

## Network, replies and diagnostics

- `worker-network: "true"` is the default in both modes, including fork Workers.
  It enables ordinary bridge egress without changing write or credential grants.
  Legacy plugin `network` declarations no longer choose the Worker network.
- `worker-network: "false"` creates an internal network, disables web tools and
  web proxy routes, and rejects server-side web tool requests through model
  routes. Fixed model mediation remains available. GitHub access and dependency
  installation are Controller operations. `isolation: none` cannot enforce the
  off setting and is rejected with that combination.
- Official DSH search and anonymous HTTP fetch are available by default in
  Controlled strict mode. Explicit native configuration/denies still apply.
- `comment-mode: append` creates one reply per run and attempt, then updates that
  reply with progress and its final result. Previous replies remain unchanged.
  `update` retains the former latest-comment behavior. Disabling progress does
  not disable final publication. Inline finding deduplication is unchanged.
- `diagnostics: basic` emits phase events and a 30-second waiting heartbeat.
  `detailed` additionally attempts a bounded, redacted artifact with three-day
  retention. `off` retains normal errors/results without the new trace.

The Action-wide `timeout-minutes` deadline bounds the Agent. There is no hidden
ten-minute Agent cap. Installation, validation and cleanup retain separate
bounded phases. Diagnostics retain the last observed stage, tool and model
transport activity on failure. They do not record model thinking, complete
prompts, tool arguments, request bodies or credential headers. Worker events are
untrusted observations and do not become Controller tool requests or receipts.

## Maintain native files directly

Installer changes are deferred. The existing npm installer remains unchanged;
create the project Profile from the example files above or copy
`examples/native-profile` to `.dsh`, then commit it. Subsequent runs load the
trusted committed version without rerunning an installer.

Native settings plus non-empty legacy Harness inputs (model, reasoning-effort,
MCP/plugin JSON, or Harness tool grants) are rejected with a migration location.
Controller-only GitHub/command capabilities remain Action inputs. Workflows
without a project Profile retain the legacy conversion path.

The runtime reuses exact Action-provided package versions and rejects conflicts.
Bundle patch declarations accept a string or an ordered string array; every
referenced file is checked for containment. An optional native npm v3 lock
constrains additions without replacing the Action runtime lock.

For an offline static check:

```sh
npm run check:config -- --config examples/config-check.json --profile examples/native-profile
```

Plugin activation, network and GitHub authority remain not_checked. Runtime and
Session compatibility include effective configuration and network; history
never restores old authorization.

The selected Profile directory is a Controller-protected publication path, including
custom `dsh-profile` directories. Worker additions, edits and deletions beneath it
are rejected before any GitHub blob or commit is created. The directory selection
is carried by the Controller workspace snapshot, not accepted from model output.

With `dsh-profile: auto`, a `.dsh` directory containing only native repository
resources such as `skills/` does not activate project Profile loading. Either
`package.json` or `cordis.patch.yml` indicates Profile intent, and both files must
then exist and validate. An explicit `dsh-profile` always requires a valid Profile.
