# create-deepseek-harness-action

Configure GitHub workflows for
[DeepSeek Harness Action](https://github.com/Lixiaoyiao/deepseek-harness-action).

```bash
npm create deepseek-harness-action@latest
```

The local browser GUI is prepared for installer **0.7.3**, after formal Action
**v0.12.1** qualification. Published installer **0.7.2** retains the previous
terminal guide until that separate release is available.

## Local configuration GUI

Run inside the repository you want to configure. With no flags in an interactive
terminal, the installer opens the GUI with read-only `@dsh` conversation and PR
Review as its starting preset. Reopen the command to edit existing DSH workflows.

1. Choose a preset or an existing workflow and Action step.
2. Select controlled/native mode, Agent model, thinking effort and other inputs.
3. Add any plugins explicitly and review their version/compatibility.
4. Preview the YAML diff and static validation results.
5. Confirm Save, then commit and push with your normal Git workflow.

```bash
npm create deepseek-harness-action@latest -- --gui
npm create deepseek-harness-action@latest -- --no-open
```

`--gui` opens the GUI explicitly; `--advanced` is an alias. `--no-open` prints its
private local URL without opening a browser. Keep the terminal running while
editing. The server binds only `127.0.0.1` on a random port and authenticates API
requests with a fresh session token and same-origin checks. Restarting creates a
new URL. Do not share the token-bearing URL or forward the port.

The GUI saves only local workflow YAML under `.github/workflows`; YAML is the
single configuration source. It creates no sidecar database, commits, pushes or
remote repository. External file changes invalidate an earlier preview, so reload
before saving. Plaintext credentials and unsupported YAML require manual editing.
Use `${{ secrets.DEEPSEEK_API_KEY }}` in YAML and add the actual key through GitHub
**Settings → Secrets and variables → Actions**.

The form uses generated Action input metadata. The backend edits the parsed YAML,
uses the Action's actual static configuration validator, and owns preview/save
checks. The UI is a separate browser layer; it cannot grant runtime authority.
See [Architecture](../../ARCHITECTURE.md#local-configuration-gui).

## Non-interactive workflow generation

Explicit `--mode` generates files without a browser, including in CI:

```bash
npm create deepseek-harness-action@latest -- --mode review
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
npm create deepseek-harness-action@latest -- --mode session
```

Modes are `review`, `commands`, `both`, and `session`. The DSH composition defaults
to `controlled`; use `--dsh-mode native` explicitly. This path preserves existing
workflow files. CI and non-interactive sessions without `--mode` fail with usage
guidance instead of waiting for stdin.

Review includes read-only Issue/PR conversation and automatic PR Review. With
`both`, Commands handles interactive comments while Review handles automatic PR
events, avoiding duplicate replies. Commands requires repository-specific write
validation. Natural-language writes additionally need `natural-language-write:
"true"`, `allow-write: "true"`, and an explicit change request.

```bash
npm create deepseek-harness-action@latest -- --mode commands \
  --test-commands '[["node","trusted-tests.mjs"]]' \
  --container-image 'your-reviewed-image@sha256:<64 lowercase hex>'
```

Select trusted validation commands yourself. The installer does not discover or
execute project scripts; missing commands retain the fail-closed placeholder.
Static validation does not verify credentials, online permissions/quota, Docker,
model availability or repository test results.

Automatic Session is read-only, with matching run-name/key/concurrency bindings
and `queue: max`. Commit it to the default branch, then dispatch there with a
lowercase key and prompt. Reuse that key for follow-ups. See the
[Session contract](../../docs/session.md) for recovery and explicit usage.

## Release identity

The current independently published version `0.7.2` targets formal Action
`v0.12.0`, exact DSH `0.2.1-rc.2`, and source tag
`create-deepseek-harness-action-v0.7.2`. GUI source changes are prepared here before
installer `0.7.3` receives the separately qualified Action `v0.12.1` identity.

Packing receives the full formal Action commit through `DSH_ACTION_RELEASE_SHA`
only after its tag, GitHub Release and controlled/native canary agree. Source
templates retain the controlled build token; published workflows contain an
immutable SHA rather than a candidate, floating tag or branch. Qualify the archive
once, publish those bytes, then verify fresh anonymous public consumers.

## Import local DSH plugins

Run `npm create deepseek-harness-action@latest -- --gui --import-plugins` to open the plugin page. Discovery reads package metadata under `DSH_HOME/profiles` (default `~/.dsh/profiles`) after you choose a mode. Select the packages, review their installed versions and DSH `0.2.1-rc.2` compatibility, then review the resulting YAML diff. Use `--dsh-home` for another location.

Enabled npm DSH Bundles can be reinstalled at exact versions in Native mode. Controlled mode also asks for the exact `plugin__owner__tool` names and grants only the selected read-only tools. Packages using arbitrary tool names need Native mode or manual configuration. Local paths, npm aliases, disabled Bundles, incompatible versions and plain dependencies need manual setup; the list explains each case. An undeclared compatibility range is shown as unverified.

The generated workflow enables package installation only after confirmation. It does not copy `.env`, credentials, local Cordis patches, compatibility exceptions or plugin settings. Imported plugins use package defaults and request no extra network or workspace-write access; existing workflow permissions and shared worker mounts still apply. Add any required cloud configuration separately with the existing extension inputs. Fork reviews retain their extension-free configuration.

Native web search and fetch now use the DeepSeek Search/Fetch API through the Controller proxy. Controlled search uses the same Search API; add `native.web-fetch` explicitly under a custom or standard permission profile to enable Fetch. The `base-url` input also selects the upstream for these API routes; `web-search-base-url` remains the legacy Messages-search route. The API model ID for the new Flash catalog entry is `deepseek-flash`.

Controlled import declares only the selected read-only tool names. Additional coding permissions require explicit workflow configuration and the Action's existing trust checks. Native commands retain the trusted-context gates, so plugin discovery cannot authorize untrusted fork commands.

An explicit custom `web-search-base-url` keeps its legacy Messages-search protocol. The default selects the new Search API. Fetch always uses its separate API grant and `base-url`, including when Fetch is the only selected web tool.
