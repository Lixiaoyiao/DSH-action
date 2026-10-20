# GitHub requests and recovery

The Action reuses the Controller client and sticky lifecycle/result comments.
Schema-v2 `result-json` is the common report. Accepted tasks log their operation, trust and run
link. Denied requests cannot post lifecycle comments. Write-task comments stay
deferred until final validation passes or no repository change is confirmed.
The Actions run remains authoritative if terminal comment publication fails.

Only explicitly selected immutable text blobs/trees use a run-scoped cache and
concurrent request merging. The cache retains at most 128 responses and 2 MiB,
is isolated to one client/credential, returns isolated copies, and never
persists across runs. Failed/oversized responses are not cached. Comment scans
reuse their already-read first page. Actor permissions, mutable branches and
entity bindings, immediate write revalidation and unknown-effect reconciliation
always make fresh requests; they never opt into the cache.

Review context shares its existing 36 KiB JSON text budget fairly across
changed-file patches before source snippets. Short patches return unused space;
early large documentation cannot consume every later file's share. Explicit
coverage and truncation metadata describes this projection, while the original
snapshot and publication anchors stay intact. The final worker prompt can still
truncate, so coverage metadata is not proof of a complete model review.

Quota-limited GETs may wait and retry at most twice, with at most 15 seconds of
total waiting and enough time left in the current task budget. `retry-after`
and exhausted primary-quota reset headers set the earliest allowed retry time.
An unspecified secondary-limit recovery requires at least a minute, so this
short-budget policy fails immediately, including a secondary-limit `403` with
no `retry-after` header. Ordinary permission-denied `403` responses retain their
original classification. No POST/PATCH/PUT/DELETE or ambiguous
transport error is retried by the client. Existing Gateway postcondition reads
remain responsible for uncertain effects. The worker task is never replayed.

`result-json.context.githubRequests` and the step summary retain redacted counters,
credential scope, `clientRole: main-controller`, safe resource category and recovery time. Lifecycle comments use a separate client and are excluded from these counters. No URLs, request
bodies, response bodies or credential values are included. A quota error has
stable code `GITHUB_QUOTA_EXHAUSTED`; inspect recorded commit/branch/PR and
Gateway receipts before rerunning. A result lists confirmed effects; absence
of an identity does not prove an interrupted external extension had no effect.

If an unknown mutation and its reconciliation read both fail, the current
diagnostic cause retains the read failure rather than the original transport
failure. The effect remains `possible`, the attempt count stays one, and the
mutation is not resent. This is a remaining diagnostic limitation.

Keep three operational scopes distinct:

| Scope              | Credential and evidence                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production Action  | The configured `github-token`, normally its job's `GITHUB_TOKEN`; result counters refer to this scope only. A supplied PAT/App token can use another budget.                                |
| Core E2E fixtures  | Each fixture job's declared reader/writer Actions token and exact run/attempt identities. The one-blob diagnostic uses a new token context and cannot prove an old fixture token recovered. |
| Release monitoring | The maintainer CLI/OAuth or connector/App installation used to inspect runs and publish. Its quota is not proof of the Action or fixture quota.                                             |

Do not rotate credentials to evade limits. Save the exact SHA, run/artifact
identity, quota headers and recovery time, then resume only the blocked gate
after recovery within an explicit budget. Long waits fail and retain evidence.

This policy follows GitHub's [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
and [authentication-specific rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
Conditional requests are useful for mutable monitoring; production freshness
checks remain uncached, and immutable text reuse needs no monitoring poll.

中文：仅显式选择的完整 SHA 文本对象缓存；授权、写前重验与未知副作用核对
始终新鲜。限流最多重试两次只读请求，累计等待不超过 15 秒且受任务预算约束。
写请求和任务不重放。错误、恢复时间及脱敏统计保存在现有结果和 summary 中。
生产 Action、E2E fixture、发布监控的凭据与配额必须分别判断。
