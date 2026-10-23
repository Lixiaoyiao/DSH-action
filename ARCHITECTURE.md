# Architecture

DeepSeek Harness for GitHub is intentionally split into a trusted Controller
and a disposable DSH worker. The split exists to keep model execution useful
without treating model output, repository content, or extension code as GitHub
authority. The system-level promises are indexed in the
[invariant catalog](docs/invariants.md).

## Ownership

The **Controller** owns GitHub event routing, actor and repository trust,
credential routing, Action input validation, workspace preparation, deadlines,
Controller tools, validation, publication, and every persistent GitHub effect.
It decides what may happen before asking DSH to do work.

**DSH** owns the Agent turn and its composition. It receives bounded context and
only the worker authority selected by the Controller. DSH output remains
untrusted and must pass Controller schemas and policy before it can influence a
persistent effect.

**Validation** is Controller-owned. It runs against the disposable workspace
after an eligible change and before a commit, ref update, pull request, or typed
GitHub mutation is flushed. A model response cannot waive it
([INV-004](docs/invariants.md#inv-004-githubmutationrequiresvalidation)).

## Local configuration GUI

The standalone installer has a local browser UI over a small loopback HTTP
backend. Browser code owns presentation and editing state; backend modules own
YAML inspection/editing, plugin metadata discovery, static validation, diff
preview and local file saves. The server binds to `127.0.0.1`, uses a fresh
session token and checks the request host/origin.

`src/action-contract.ts` generates the GUI's input metadata. The packaged
validator bundles the same `checkConfiguration` implementation used by the
Action, so browser forms do not become a second schema. YAML workflow files are
the persistent source; there is no sidecar configuration store. Saving requires
a current diff preview, checks the source hash again, and affects only workflow
files. Git publication and runtime GitHub authority remain outside this UI.

The UI files live under
`packages/create-dsh-action/src/gui/ui/`; the sibling backend files
can evolve independently while keeping the HTTP contract. These modules are
installer tooling and are not loaded by the Action worker.

## Controlled and native composition

`controlled` is the compatibility default. The Controller builds the
`github-action-controlled` Profile, resolves a positive canonical tool set, and
owns the model-facing ToolRuntime policy.

`native` selects the official `dsh-native-headless` graph. DSH owns discovery
and the model-facing inventory for Profile, MCP, Bundle, Plugin, Skill,
Subagent, and Workflow capabilities. Native is Docker-only
([INV-001](docs/invariants.md#inv-001-nativerequiresdocker)), and its discovered
tool names are observations rather than Controller grants
([INV-005](docs/invariants.md#inv-005-nativeinventoryisobservednotgranted)).

The mode changes composition ownership, not trust. Actor checks, immutable
repository binding, credentials, workspace mounts, Controller tools,
validation, publication, cancellation, and output bounds remain outside DSH in
both modes.

## Tool policy

The Controller owns the Action capability catalog: `workspace.*`, `native.*`,
fixed-argv `command.*`, typed `github.*`, and controlled extension tool IDs.
Permission presets and requested tools are intersected with explicit denies,
trust, capability, isolation, and provider availability. An explicit deny has
deterministic precedence
([INV-002](docs/invariants.md#inv-002-explicitdenywins)).

Native DSH inventory is not copied into this catalog. The Action may report it
as `observedTools`, but telemetry does not become authority.

## GitHub authority

`GitHubAuthorityGateway` is the only Action-owned facade through which typed
GitHub tools execute. It preserves repository/entity/head bindings, queues
mutations, revalidates immediately before effects, reconciles uncertain API
outcomes, and emits bounded receipts.

The Backend is deliberately narrower: it adapts GitHub API transport and does
not decide policy. Keeping retries, postconditions, and revalidation behind the
Gateway prevents callers from accidentally treating a successful API call as
sufficient authorization. A separately configured GitHub MCP is external
extension authority and does not inherit Gateway guarantees.

## Credential and persistence boundaries

The real DeepSeek key remains in a run-scoped Controller proxy. The real GitHub
token remains in the Controller. Neither enters the DSH worker, repository
commands, validation, or model context
([INV-003](docs/invariants.md#inv-003-controllercredentialsneverenterworker)).
Explicit credentials for a trusted extension belong to that extension and do
not widen Controller authority.

Workspace write access changes only the disposable, `.git`-less worker copy.
Persistent GitHub authority is separate: the Controller must inspect the
change, validate it, revalidate the bound entity, and use its own credential to
perform an allowed mutation. A writable mount is therefore never equivalent to
permission to commit, push, comment, or update GitHub metadata.

The fixed DSH 0.2.1-rc.2 runtime uses disposable, run-scoped Session storage.
The optional `session-mode` inputs let the Controller import verified raw Session
history with its referenced official attachment bytes and save a bounded
checkpoint artifact. Provenance, compatibility,
settlement and current actor authority are checked before import or upload;
restored history never grants authority or replays old writes. Worker mounts and
runtime storage are cleaned at completion or cancellation. Headless events
describe execution; only terminal text enters the Controller business schema.
Result formatting repair receives that text alone and cannot drive another
Agent turn.

## Module design and lifecycle

The architecture above remains the organizing principle. Refactoring follows
responsibility and ownership, rather than file size. A module should hide the
ordering rules callers would otherwise repeat, expose a small interface and be
tested through that interface. A shared abstraction needs two real uses; a
generic workflow framework or a pass-through wrapper earns no place here.

The dependency direction is entrypoint → orchestration → domain modules →
external adapters. Input schemas decode values; input invariant validation
checks combinations and credential isolation before side effects. Result types,
failure classification, Action output serialization and Markdown rendering have
independent implementations behind the existing public result contract.

`runAction` orders admission, capability preparation and Agent execution. Each
phase retains its own observations, including facts obtained before preparation
fails. `RunLifecycle` owns only progress and cancellation reporting. Final
outputs combine read-only snapshots; they do not grant authority.

`runAgentLoop` owns turn/retry decisions. Its lifecycle module owns acquisition,
bounded execution and disposal; feedback handles bounded, untrusted repair
context. The selected `PreparedOperation` binds only its actual publication
inputs. Review and diagnosis never receive write validation or Session state.
Operations retain confirmed effects before another asynchronous step can fail.

`WorkspaceValidation` owns command counts, integrity findings and accepted
workspace revisions. Repository writes and the Gateway use that same owner.
A matching revision can reuse its executed suite; permission and remote target
checks still run at the effect seam. A completed historical operation is
reportable validation evidence but cannot authorize a new workspace mutation.

`ControllerSession` owns preparation, restore, save and settlement. The owner
exists before preparation starts, so an acknowledged artifact remains visible
even if a subsequent metadata read fails. Session failure cannot erase a
confirmed PR, comment or completed validation. Session transport and the pure
archive decoder retain their existing bounds and provenance checks.

Write transactions own validation → fresh actor authorization → entity/ref
revalidation → effects → reconciliation. Task and implementation share the
new-PR transaction; a PR-head fix uses its separate update semantics. Both reuse
the same validation/authority stage. The Gateway applies the same fresh actor
gate to queued typed mutations. Reauthorization can revoke admitted capability;
it cannot add capability to a running Agent.

The DSH engine belongs to the DSH adapter. Controlled Profile rows and tool
policy hooks stay inside that adapter; generic extension package resolution
serves both real compositions.
The engine lifecycle interface carries one complete turn-result type. The DSH
adapter returns its existing result directly, and the Agent loop validates the
business output while retaining the remaining execution evidence. There is no
separate metadata format to split and reconstruct across this seam.

DSH resource ownership stays run-scoped. Controlled and native compositions may
share installation and environment preparation, while their tool-policy owners
and admission rules remain distinct. Cleanup uses one bounded grace period and
attempts every acquired resource's disposer, preserving the primary outcome.

## Installation design

The installer defaults to read-only conversation and automatic PR Review in the
local configuration GUI described above. Advanced modes are explicit choices.
GUI and non-interactive entrypoints share release-bound templates and the local
workflow save transaction. Existing files are read from the repository root;
concurrent edits invalidate the preview before saving.

The installer stores Secret references in YAML and never sets GitHub Secrets,
commits, pushes, or runs repository scripts. Maintainers perform those steps
through their normal GitHub and Git tools. Local plugin discovery reads package
metadata only; cloud configuration names exact packages and explicit tools,
without copying local credentials or private settings.

## Verification seams

Behavior is verified at four interfaces: the complete Action lifecycle/results;
DSH/Agent execution, deadlines and disposal; write/Gateway transactions and
external effects; and installer CLI onboarding in a fresh Git repository.
GitHub, Docker and model transports are external adapters. Internal validation,
policy, state transitions and output projection stay real wherever feasible.
An extraction preserves these behavior tests and replaces obsolete tests of
private structure. Shared candidate admission is exercised with real Bash
and transport fixtures. Version and artifact binding checks remain; prose,
local variable names and equivalent source layouts are not contracts. Release qualification then
checks the exact candidate SHA and fresh public consumers.

## Extension points

Supported extension points are intentionally narrow:

- add a Controller capability through the typed catalog, policy requirements,
  provider binding, schemas, receipts, and tests;
- add GitHub transport behavior behind the existing Gateway facade without
  bypassing binding or revalidation;
- add controlled MCP/Bundle/Plugin definitions through the versioned manifests;
  or
- compose native DSH ecosystem definitions through the native admission path.

Extensions do not move credential ownership, create implicit grants, or bypass
the Controller validation and persistence boundaries.
