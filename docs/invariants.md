# Architecture invariant catalog

This catalog gives the small set of system-level invariants stable identifiers.
It is an index, not a second policy engine: production code remains the source
of enforcement, and tests exercise public behavior without importing a shared
decision implementation merely to reproduce its answer.

## INV-001 NativeRequiresDocker

Native composition is rejected unless effective isolation is Docker; a host
`dsh-executable` is controlled-mode compatibility only.

Evidence: `test/inputs.test.ts`, `test/security-invariant-matrix.test.ts`, and
`test/dsh-composition.test.ts`.

## INV-002 ExplicitDenyWins

An exact `disallowed-tools` entry takes precedence over preset expansion,
requested grants, trust eligibility, and provider availability. Its denial is
reported as an explicit deny before lower-precedence reasons.

Evidence: `test/permission-profile.test.ts`, `test/tools.test.ts`, and the
six-axis matrix in `test/security-invariant-matrix.test.ts`.

## INV-003 ControllerCredentialsNeverEnterWorker

The Controller's DeepSeek and GitHub credentials must not enter worker
environment variables, argv, prompts, extension configuration, validation, or
result channels. The worker receives only mediated or extension-owned authority.

Evidence: `test/dsh-env.test.ts`, `test/extensions.test.ts`,
`test/security-invariant-matrix.test.ts`, and `test/authority.test.ts`.

## INV-004 GithubMutationRequiresValidation

Repository commits, ref updates and code publication require successful Controller
validation and fresh authorization/target revalidation. Pure GitHub metadata
mutations are deferred until operation finalization and fresh write authorization
and entity binding; they do not require a repository suite. Cancellation or a
failed code validation must leave queued mutations unflushed.

Result projection preserves completed validation evidence. An integrity audit
on a no-change task does not start command validation; a later publication
failure cannot turn unexecuted configured commands into failed validation.

Evidence: `test/github-tools.test.ts`, `test/action-lifecycle.integration.test.ts`,
`test/action-validation-evidence.integration.test.ts`, `test/write-finalizers.integration.test.ts`
and `test/write-transactions.integration.test.ts`.

## INV-005 NativeInventoryIsObservedNotGranted

Native DSH-discovered tool names are emitted only as `observedTools`. They are
never represented as Controller `requestedTools`, `effectiveTools`, or
`deniedTools`, and observation is not an authorization input.

Evidence: `test/dsh-composition.test.ts`, `test/dsh-runner.test.ts`,
`test/native-ecosystem.integration.test.ts`, and
`test/security-invariant-matrix.test.ts`.
