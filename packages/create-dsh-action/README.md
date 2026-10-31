# DSH-action installer

Unreleased: native project Profiles, independent network access (on by default), per-run reply history and live diagnostics. See [configuration and migration](../../docs/native-profile.md).

Configure GitHub workflows for
[DeepSeek Harness Action](https://github.com/Lixiaoyiao/DSH-action).

```bash
npm create dsh-action@latest
```

Installer **0.7.4** creates workflows bound to formal Action **v0.12.2**.

## Interactive setup

Run from the root of the repository you want to configure. With no flags in an interactive
terminal, the installer asks which workflow to install, then which DSH composition
to use. Press Enter to select read-only `@dsh` conversation and PR Review, then
`controlled`. Use `--advanced` to enter these questions explicitly.

The installer creates workflow YAML under `.github/workflows` and refuses to
overwrite existing files or follow symbolic-link destinations. Review the files,
then commit and push with your normal Git workflow.

Use `${{ secrets.DEEPSEEK_API_KEY }}` in YAML and add the actual key through GitHub
**Settings → Secrets and variables → Actions**.

Set model, thinking effort, actor filters and other Action inputs directly in the
workflow YAML. See [Configuration](../../docs/configuration.md) and the
[offline configuration check](../../docs/configuration-check.md).

## Non-interactive workflow generation

Explicit `--mode` generates files without terminal questions, including in CI:

```bash
npm create dsh-action@latest -- --mode review
npm create dsh-action@latest -- --mode both --dsh-mode native
npm create dsh-action@latest -- --mode session
```

Modes are `review`, `commands`, `both`, and `session`. The DSH composition defaults
to `controlled`; use `--dsh-mode native` explicitly. CI and non-interactive
sessions without `--mode` fail with usage guidance instead of waiting for stdin.

Review includes read-only Issue/PR conversation and automatic PR Review. With
`both`, Commands handles interactive comments while Review handles automatic PR
events, avoiding duplicate replies. Commands requires repository-specific write
validation. Natural-language writes additionally need `natural-language-write:
"true"`, `allow-write: "true"`, and an explicit change request.

```bash
npm create dsh-action@latest -- --mode commands \
  --test-commands '[["node","trusted-tests.mjs"]]' \
  --container-image 'your-reviewed-image@sha256:<64 lowercase hex>'
```

Select trusted validation commands yourself. The installer does not discover or
execute project scripts; missing commands retain the fail-closed placeholder.
The first Action run checks credentials, online permissions/quota and runner
availability; writes also require successful repository validation.

Automatic Session is read-only, with matching run-name/key/concurrency bindings
and `queue: max`. Commit it to the default branch, then dispatch there with a
lowercase key and prompt. Reuse that key for follow-ups. See the
[Session contract](../../docs/session.md) for recovery and explicit usage.

## Release identity

Installer `0.7.4` targets formal Action `v0.12.2` at
`23a998ccd209f5422f220f038234a89984f0471c`, exact DSH `0.2.1-rc.2`, and
source tag `create-dsh-action-v0.7.4`. The reviewed installer source
commit and the formal Action commit are separate release identities.

Packing receives the full formal Action commit through `DSH_ACTION_RELEASE_SHA`
only after its tag, GitHub Release and controlled/native canary agree. Source
templates retain the controlled build token; published workflows contain an
immutable SHA rather than a candidate, floating tag or branch. Qualify the archive
once, publish those bytes, then verify fresh anonymous public consumers.

## Import local DSH plugins

Run `npm create dsh-action@latest -- --import-plugins` in an interactive terminal outside CI. Discovery reads package metadata under `DSH_HOME/profiles` (default `~/.dsh/profiles`) after you choose a workflow and composition. It lists installed versions and DSH `0.2.1-rc.2` compatibility, then asks for package numbers and final confirmation. Use `--dsh-home` for another location.

Enabled npm DSH Bundles can be reinstalled at exact versions in Native mode. Controlled mode also asks for the exact `plugin__owner__tool` names and grants only the selected read-only tools. Packages using arbitrary tool names need Native mode or manual configuration. Local paths, npm aliases, disabled Bundles, incompatible versions and plain dependencies need manual setup; the list explains each case. An undeclared compatibility range is shown as unverified.

The generated workflow enables package installation only after confirmation. It does not copy `.env`, credentials, local Cordis patches, compatibility exceptions or plugin settings. Imported plugins use package defaults and request no extra network or workspace-write access; existing workflow permissions and shared worker mounts still apply. Add any required cloud configuration separately with the existing extension inputs. Fork reviews retain their extension-free configuration.

Native web search and fetch now use the DeepSeek Search/Fetch API through the Controller proxy. Controlled search uses the same Search API; add `native.web-fetch` explicitly under a custom or standard permission profile to enable Fetch. The `base-url` input also selects the upstream for these API routes; `web-search-base-url` remains the legacy Messages-search route. The API model ID for the new Flash catalog entry is `deepseek-flash`.

Controlled automatic import targets read-only Review and Session workflows. Coding-command plugins need manual per-task permission declarations; selecting both workflows imports into Review and leaves Commands unchanged. Native commands retain the trusted-context gates, so plugin discovery cannot authorize untrusted fork commands.

An explicit custom `web-search-base-url` keeps its legacy Messages-search protocol. The default selects the new Search API. Fetch always uses its separate API grant and `base-url`, including when Fetch is the only selected web tool.
