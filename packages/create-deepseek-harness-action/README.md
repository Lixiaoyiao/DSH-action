# create-deepseek-harness-action

CLI-only installer for [DeepSeek Harness Action](https://github.com/Lixiaoyiao/deepseek-harness-action).

```bash
npm create deepseek-harness-action@latest
```

Installer **0.8.0** targets formal Action **v0.12.2** and DSH `0.2.1-rc.2`.
Generated workflow references are pinned to the verified full Action commit during
packaging with `DSH_ACTION_RELEASE_SHA`; installer source tag:
`create-deepseek-harness-action-v0.8.0`.

## Workflow generation

Run without arguments inside a local repository to generate the safe default:
read-only `@dsh` Issue/PR chat plus automatic PR review. It does not start a browser,
ask questions, read Secrets, or overwrite any existing workflow.

Other templates are explicit:

```bash
npm create deepseek-harness-action@latest -- --mode review
npm create deepseek-harness-action@latest -- --mode commands
npm create deepseek-harness-action@latest -- --mode both
npm create deepseek-harness-action@latest -- --mode session --dsh-mode native
```

`both` separates automatic PR review from interactive comment handling so
the two workflows do not respond to the same `@dsh` comment.
Controlled is the default; use `--dsh-mode native` for official DSH composition.
Commands require repository-specific test commands before validated writes.
The starter contains a deliberately failing validation placeholder until configured.

Only local YAML under `.github/workflows` is created. The installer never runs
repository scripts, commits, pushes, installs a GitHub App, or sets Secrets.
Commit and push the YAML yourself; create GitHub Actions Secret `DEEPSEEK_API_KEY`.
Existing installed workflows keep running independently of the installer.

## Manage an existing installation

Open `.github/workflows/*.yml` in GitHub or a code editor. Modify Action inputs,
upgrade the pinned Action SHA, adjust triggers, or delete the YAML to uninstall.
The CLI deliberately refuses to overwrite existing files.
Set model, thinking effort, permissions, MCP, Bundles, Plugins, and Session in YAML.
The local Web GUI and browser plugin-import interface have been removed.
Use [Setup](../../docs/setup.md) and [Configuration](../../docs/configuration.md).
