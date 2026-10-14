# Dependency security review — 2026-10-14

This review updates the dependency assessment for the current source tree while
retaining the exact DSH `0.2.0-rc.2` family. The
[rc.2 migration audit](dsh-0.2.0-rc.2-migration.md) and
[v0.9.2 audit](v0.9.2-runtime-audit.md) describe historical releases; their counts
and statements about available fixes are not the current dependency status.

## Compatible updates

| Package                     | Previous lock | Current lock | Evidence and disposition                                                                                                                                                                                                              |
| --------------------------- | ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | `1.30.0`      | `1.32.1`     | The [OAuth advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h) identifies `1.31.0` as the first patched 1.x version. The direct development pin is exact; the production optional-peer consumer also resolves this copy.     |
| `proxy-addr`                | `2.0.7`       | `2.0.8`      | Express permits `^2.0.7`. The [official 2.0.8 release](https://github.com/jshttp/proxy-addr/releases/tag/v2.0.8) explicitly fixes [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).                           |
| `http-cache-semantics`      | `4.2.0`       | `4.3.0`      | `cacheable-request` permits `^4.2.0`; [official npm metadata](https://registry.npmjs.org/http-cache-semantics/4.3.0) confirms this compatible release. It is outside the current advisory range; see the qualification below.         |
| `source-map-js`             | `1.2.1`       | `1.2.2`      | The existing development dependency ranges permit `^1.2.1`. [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) identifies `1.2.2` as the first patched version for indexed-source-map offset denial of service. |

The cache advisory [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
still lists `<=4.2.0` and no first patched version. The
[upstream maintainer disputes the report](https://github.com/kornelski/http-cache-semantics/issues/56#issuecomment-5975759591),
explaining that private response reuse is governed by `Cache-Control: private`.
Consequently, the `4.3.0` update is reported as a compatible update outside the
current advisory match, not as independently proven remediation of the disputed
report. The Action's telemetry consumers remain disabled; the fixed OTel event
transport does not enable Got caching.

## Residual findings and reachability

The official production audit changed from **15 affected-package entries
(1 critical, 7 high, 7 moderate)** to **12 (0 critical, 5 high, 7 moderate)**.
The final full development-plus-production audit also reports 12. These entries
include affected ancestors of **two underlying advisories**, not twelve distinct
vulnerabilities. Both audit commands still exit nonzero; the graph is not clean.

| Advisory                                                                                      | Locked dependency chain                                                                                                          | Reachability and remaining constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MCP OAuth credential disclosure](https://github.com/advisories/GHSA-6qxp-vccf-f47h)          | `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2` → exact `@modelcontextprotocol/client@2.0.0` → exact `@modelcontextprotocol/core@2.0.0` | The fixed DSH adapter constructs stdio or HTTP transports with explicit request headers, without an OAuth `authProvider`. The advisory requires an OAuth client holding credentials and an untrusted or compromised MCP server. That path was not demonstrated for the default Action. A trusted extension that supplies its own OAuth client needs a separate assessment. Official client `2.2.0` is patched, but replacing the exact upstream requirement would violate the retained package contract. |
| [fflate malformed ZIP64 denial of service](https://github.com/advisories/GHSA-px8p-9vwx-vf98) | DSH Office paths → `@deepseek-ai/libreoffice-kit@0.1.5` → exact `fflate@0.8.2`                                                   | The root `fflate@0.8.3` and the Session fixture decoder use the patched copy; they do not replace the nested Office copy. The default headless task transport is text-only. Trusted extensions that activate Office archive processing can make this dependency reachable. Removing or overriding the nested copy would break the published exact requirement.                                                                                                                                           |

The exact constraints are published in the official
[DSH MCP package metadata](https://registry.npmjs.org/@deepseek-ai/dsh-mcp-client/0.2.0-rc.2)
and [LibreOffice package metadata](https://registry.npmjs.org/@deepseek-ai/libreoffice-kit/0.1.5).
Limited default reachability does not repair the installed packages. No dependency
override, peer bypass, DSH alpha upgrade, or audit suppression is used.

The former `proxy-addr` critical rating also did not establish a Controller
credential disclosure: the Controller proxy uses `node:http` and its own token
check, not Express IP trust. Updating the installed dependency removes that
advisory match without claiming the default Controller had the vulnerable IP
authorization configuration.

## Reproducing the assessment

```sh
npm ci --strict-peer-deps --registry=https://registry.npmjs.org/
npm ls --all
npm audit --json --registry=https://registry.npmjs.org/
npm audit --omit=dev --json --registry=https://registry.npmjs.org/
npm run check
```

Record the actual audit exit code and retain residual findings. Advisory data can
change independently of this lockfile. Compatibility qualification must also run
the exact candidate's Linux Docker checks, Core E2E and controlled/native Session
paths; audit counts alone do not establish runtime compatibility. Session capacity
bounds remain unchanged. Real expired-history proof must use the
[existing natural-expiry fixture](../.github/e2e/session-history-fixtures.md#actual-manifest-expiry),
not a shortened TTL or a simulated clock.
