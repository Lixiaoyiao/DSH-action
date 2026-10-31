# Resource limits and their purpose

These are engineering budgets, not measured guarantees of model quality or
hardware capacity. The Controller applies them independently of model output.
Changing a budget requires checking cold installation, cancellation, malformed
input and a fresh consumer, rather than only changing a constant.

| Budget                                      | Current value                               | Design reason and consequence                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime acquisition                         | 30 seconds                                  | Local temporary storage should be quick; a stalled filesystem must not consume the whole job. Late resources are disposed.                                       |
| Runtime and extension installation          | 5 minutes each                              | Cold package installation gets a separate bounded phase. Installation cannot extend the immutable run deadline.                                                  |
| Setup/progress hooks                        | 60 seconds                                  | External setup and reporting may be slow, but must not indefinitely prevent a turn or cleanup.                                                                   |
| Agent execution and validation              | Agent: remaining overall deadline; validation: 10 minutes                             | Agent work uses the immutable run deadline, without a hidden ten-minute cap. Validation retains its separate bounded attempt.                                      |
| Cleanup and terminal cancellation reporting | 5 seconds each                              | Attempt all disposers and preserve the primary result; cleanup/reporting failure remains visible as a warning.                                                   |
| Worker container                            | 2 GiB, 2 CPUs, 256 PIDs                     | Constrain the worker's memory, process tree and CPU demand. Larger projects may need a narrower task; these are fixed limits, not promises for arbitrary builds. |
| Installation container                      | 4 GiB, 2 CPUs, 256 PIDs                     | Package extraction and dependency resolution need more memory than the bounded worker. Worker and installer authority remain separate.                           |
| Container temporary storage                 | 512 MiB                                     | Permit normal temporary files without an unbounded writable filesystem. The worker `/tmp` also uses `noexec,nosuid,nodev`.                                       |
| DSH output                                  | 2 MiB                                       | Bound process buffering and schema input; truncation is an explicit failure, never accepted as a complete model result.                                          |
| Public receipt outputs                      | 640 KiB in UTF-16 bytes                     | Reserve headroom under GitHub's job output budget for other outputs. Old receipts are dropped with counts; final status and confirmed effects remain.            |
| GitHub image downloads                      | 8 attempts; 4 MiB each; 16 MiB total        | Bound Controller download bytes; unsupported URLs and failed images report their reason.                                                                         |
| Image download request chain                | 30 seconds; 3 redirects                     | Bound one supported GitHub upload; redirect destinations remain restricted to GitHub image storage.                                                              |
| Official DSH image source                   | 20 MiB; 64 million pixels; 8,192 per side   | Official attachment admission bounds decoding. DSH may normalize the model image without rewriting the repository source.                                        |
| Model proxy request / response              | 32 MiB each                                 | Bound model transport including text and base64 image data.                                                                                                      |
| Repository materialization / workspace      | 50,000 files; 1 GiB                         | Preserve regular file bytes in a bounded isolated workspace.                                                                                                     |
| GitHub commit publication                   | 200 changed files; 10 MiB                   | Bound added/modified byte uploads while retaining existing write validation.                                                                                     |
| Session payload / manifest / archive        | 4 MiB / 16 KiB / payload + 50 MiB + 64 KiB  | Bound raw history, referenced attachment bytes, ZIP overhead and decompression. Large history fails explicitly.                                                  |
| Session attachment bytes                    | 20 references; 20 MiB each; 50 MiB total    | Verify reference identity, digest and byte count before restore; the official Worker verifies image media type and dimensions at use.                            |
| Session JSONL                               | 20,000 rows; 1 MiB per row                  | Bound streaming records and prevent one oversized event from bypassing the total payload check.                                                                  |
| Session JSON complexity                     | depth 40; 200,000 nodes; 20,000 array items | Limit nested traversal and expanded references independently of encoded bytes.                                                                                   |
| Known Session secrets                       | 256                                         | Inspect all admitted credential representations within a finite work budget; exceeding it fails closed.                                                          |
| Session retention                           | 1–7 days, default 3                         | Keep checkpoints short-lived. Expired history cannot silently become a new conversation with the same key.                                                       |
| Acknowledged Session artifact confirmation  | 5 reads, 1 second apart, within 5 seconds   | Confirm an SDK-acknowledged artifact ID without repeating its upload. Only metadata 404s are retried; the task deadline and cancellation still win.              |

Source owners are [lifecycle/deadline.ts](../src/lifecycle/deadline.ts),
[dsh/docker-policy.ts](../src/dsh/docker-policy.ts),
[GitHub images](../src/github/images.ts),
[repository materialization](../src/github/repository.ts),
[GitHub publication](../src/write/github.ts),
[model proxy](../src/dsh/proxy.ts),
[result/outputs.ts](../src/result/outputs.ts), and
[session contracts](../src/session/contracts.ts) /
[checkpoint inspection](../src/session/checkpoint.ts) /
[artifact transport](../src/session/artifact-store.ts).

The artifact SDK can confirm an upload before its metadata is readable through
the GitHub REST endpoint. The short confirmation window limits extra API traffic
to four reads beyond the initial check and occupies at most one sixth of the
existing 30-second artifact phase. It confirms an acknowledged effect and never
repeats an upload. The confirmation loop does not retry authentication, quota or
other HTTP failures; a visible receipt must still pass every identity, size,
digest, provenance and retention check. If confirmation exhausts its bound or is
cancelled, the recorded artifact ID remains available for effect reconciliation
and the task fails closed.
Each physical confirmation read contributes to the existing GitHub request count.
These are fresh metadata reads, distinct from transport retries and SDK uploads.

Automatic Session history verification currently reads at most 1,000 runs for
its workflow and requires a complete, stable listing. Repository/run artifact
enumeration is similarly bounded. This deliberately rejects uncertain history,
including a new key whose full workflow history cannot be verified. For a
high-volume repository, use an explicit save/resume source or rotate to a new
maintainer-reviewed workflow path and a new key before this limit. Merely
deleting artifacts or changing the key does not prove old effects absent.
Failures and ambiguous uploads require effect reconciliation before starting
another task. The installer and examples use `queue: max` with
`cancel-in-progress: false` so additional same-key requests do not replace the
single pending request; the platform queue remains finite and ordering must
still be verified by the Controller.

The credential proxy binds the locally inspected Docker bridge gateway.
Production Docker execution requires a local Linux daemon whose bridge address
is bindable by the Controller. Remote daemons and Docker Desktop networking are
not silently converted to a wildcard listener. Shared host networking still
requires appropriate runner isolation; bridge binding reduces exposure but does
not make unrelated tenants trustworthy.
