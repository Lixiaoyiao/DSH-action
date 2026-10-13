# Historical release evidence

[Current release procedure](maintainer-release.md) · [Changelog](../CHANGELOG.md)

These identities and qualification notes record earlier releases. Use the current
release procedure for new candidates; historical SHAs never supply a new binding.

Historical installer `0.5.0` binds formal v0.10.0 commit `9c52f682bbeed1b7752a9e21273e6c13b01e79b1` only after
[formal canary 37654999388](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/37654999388) succeeds.
Pass this verified SHA as `DSH_ACTION_RELEASE_SHA`; qualify and publish the same
actual tarball and repeat controlled/native and Session consumers against the
official registry with a fresh anonymous cache. Historical identities below remain unchanged.

For v0.9.3, keep DSH `0.2.0-rc.2` fixed and retain every existing gate.
The opt-in [Session contract](session.md) adds independent regressions and
the trusted [Session E2E workflow](../.github/workflows/session-e2e.yml).
Qualify a controlled save/resume pair and a native save/resume pair against
the frozen candidate. Each pair uses two independent Actions runs, a fresh
`session_key`, the same candidate and trusted harness SHA, and the successful
save run's ID as `source_run_id` for resume. Do not change the default branch
between the two runs. The fixture checks a hidden memory value, the original
raw-log prefix, a new worker, current read-only authorization and no replay;
a model's claim that it remembers is insufficient evidence.

Dispatch `session-e2e.yml` from `main` with the same approved
`DSH_E2E_CANDIDATE_SHA` and `candidate_mode`, `candidate_sha` and `pull_request`
arguments used by Core E2E, plus `phase=save`, `session_key` and `dsh_mode`.
After that run succeeds, dispatch again with `phase=resume` and its
`source_run_id`. Omit `pull_request` in exact-main mode. Preserve both runs'
proof and diagnostics artifacts. Retention, quota or an unconfirmed upload
failure must be reported; never resend a task or artifact upload to find a
green result. The artifact SDK uses the Controller job's runtime credential;
its requests are distinct from Core E2E fixtures and the release monitor.
Installer `0.4.1` binds the formal v0.9.3 Action commit `e7da1b33a043b4e2e26daa7e731c266817677a4a`
after its [controlled/native canary](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/37172280127) succeeds.
Installer source qualification and public npm installation remain separate gates.

For v0.9.2, keep DSH `0.2.0-rc.2` fixed. Qualify the independent text-file,
configuration-check and GitHub quota/cache regressions along with every existing
gate below. The formal two-mode canary exercises real `prompt-file` and
`context-files` loading and checks their result provenance. The offline
configuration check never replaces online authorization or final validation.
[Runtime evidence](v0.9.2-runtime-audit.md) distinguishes the Action-owned Resume
engineering gap from the Headless image-input gap and records residual audits.
The independently versioned installer 0.4.0 binds the formal v0.9.2 Action
commit `c184872f309ebfc5e57a0c5c1397c59e774709e0` after its controlled/native canary succeeds.
Historical installer 0.3.1/v0.9.1 identities below remain immutable evidence.

v0.9.1 migrates the existing controlled and experimental native compositions
to the fixed DSH `0.2.0-rc.2` candidate. It does not add Session/Resume, an
Action-owned GitHub MCP backend, or another GitHub capability. Its formal
annotated tag, GitHub Release, and release canary must resolve to the same
qualified exact-main commit. Installer `0.3.1` targets the formal v0.9.1
Action commit `80cf46ee9098158ea664c45ea6371604c47b71e6`. Its source review,
source tag, pack qualification, and npm publication are separate gates after
the Action's formal release canary. Never substitute a guessed or
installer-source SHA for the immutable Action release binding.
