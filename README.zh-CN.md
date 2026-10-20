# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[English](README.md)

让 GitHub 里的 PR、Issue、失败 CI 和维护者编写的自动化流程直接调用 DeepSeek Harness。

```text
GitHub PR / Issue / CI  →  DeepSeek Harness  →  Review / Diagnose / Fix / Issue → PR
```

Action 会启动与凭据隔离的 DSH worker，校验结构化结果，再由受信任的 Controller 发布评论或经过验证的改动。这是社区项目，并非 DeepSeek 或 GitHub 官方产品，由 [@Lixiaoyiao](https://github.com/Lixiaoyiao) 维护。

## 快速开始

Action 会在 GitHub 的 Linux 运行器上安装并运行 DSH，**你的电脑不需要安装 DSH 或 Docker**。本地 DSH 是在你电脑上运行的独立程序，它的密钥和设置不会自动同步到 GitHub。

### 1. 安装工具

Windows 用户先安装 [Node.js 24 或更新版本](https://nodejs.org/en/download)、[Git for Windows](https://git-scm.com/download/win) 和 [GitHub CLI](https://cli.github.com/)。保持安装程序的默认选项即可。安装后关闭并重新打开 PowerShell，检查：

```powershell
node --version
npm.cmd --version
git --version
gh --version
```

PowerShell 如果提示禁止运行 `npm.ps1`，请使用这里的 `npm.cmd`，无需修改执行策略。macOS 和 Linux 用户可以直接使用 `npm`。

### 2. 打开仓库并登录 GitHub

在已有的本地仓库文件夹中打开 PowerShell，不必重新下载代码。

```powershell
cd "C:\你的路径\你的仓库"
git remote -v
gh auth login
```

登录时选择 GitHub.com 和浏览器登录。`origin` 应指向你要接入的 GitHub 仓库。安装器使用现有仓库，不会替你创建远端仓库。

### 3. 安装工作流并配置密钥

```powershell
npm.cmd create deepseek-harness-action@latest
```

默认引导安装**只读 `@dsh` 对话和自动 PR Review**。安装器会显示目标仓库，在创建文件、设置密钥、提交和推送之前分别询问。在隐藏输入提示中粘贴 DeepSeek API Key，它会保存为该仓库的 `DEEPSEEK_API_KEY` Actions Secret。

也可以手工添加：在 GitHub 仓库打开 **Settings → Secrets and variables → Actions → New repository secret**，名称填 `DEEPSEEK_API_KEY`，值填你的密钥。只在本地 DSH 中配置密钥，云端 Action 仍然无法使用它。

### 4. 直接向 `@dsh` 提问

先让生成的 `.github/workflows/dsh-review.yml` 到达仓库默认分支，通常是 `main`。如果默认分支不能直接推送，先为工作流创建 PR 并合并。

具有仓库 write 权限的协作者可以直接在 Issue 或 PR 中评论：

```text
@dsh 帮我分析这个问题
```

让 `@dsh` 从引用、代码之外的一行开始即可，不需要固定子命令。Action 会在原讨论中回答。默认工作流中，即使写 `@dsh 修复这个 Bug`，也只会分析或提出修复建议，不会改动文件。运行进度和失败原因可在仓库的 **Actions → DSH review** 查看。

需要自动审查时，创建**非草稿 PR**，或向已有 PR 推送一次新提交。Action 会发布审查结果，不改动 PR 文件。

### 可选：导入本地插件或安装其他功能

需要选择只读对话与 Review、高级 Coding Commands、两者一起安装或自动 Session 时，使用 `--advanced`。已经有本地 DSH 插件时，再加 `--import-plugins`，安装器会列出已安装版本和兼容情况，让你选择并确认：

```powershell
npm.cmd create deepseek-harness-action@latest -- --advanced --import-plugins
```

Native 模式可直接使用 DSH Bundle。Controlled 模式还会询问插件实际提供的只读工具名（`plugin__owner__tool`）；没有符合要求的工具名时，需要手工配置。GitHub 会重新安装选中的精确版本，本地密钥和设置不会被复制。仅存在本地、已停用或不兼容的包会显示简单原因。DSH 使用其他目录时，可加 `--dsh-home "C:\你的路径\.dsh"`。

只生成文件或在 CI 中运行，可以明确指定选项：

```powershell
npm.cmd create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

默认仍为 Controlled。自然语言写入需要在支持写入的工作流中同时配置 `natural-language-write: "true"`、`allow-write: "true"`，提供适合项目的验证命令，并明确要求修改代码，例如 `@dsh 修复这个 Bug 并提交 PR`。高级 Commands 模板默认关闭自然语言写入这一独立开关；旧的 `fix`、`implement` 和 `task --write` 保留原有写入请求语义。安装器 `0.7.1` 对应 Action `v0.11.0` 和 DSH `0.2.1-rc.2`；打包通过 `DSH_ACTION_RELEASE_SHA` 绑定已验证的 Action commit，源码 Tag 为 `create-deepseek-harness-action-v0.7.1`。手工安装和故障恢复见[安装指南](docs/setup.zh-CN.md)。

### 手工安装

先在仓库的 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`，再创建 `.github/workflows/dsh-review.yml`：

```yaml
name: DSH review

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: dsh-${{ github.event_name == 'pull_request_target' && 'review' || 'chat' }}-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: ${{ github.event_name == 'pull_request_target' }}

jobs:
  review:
    if: >-
      (github.event_name == 'pull_request_target' && github.event.pull_request.draft == false) ||
      (github.event.sender.type != 'Bot' &&
      contains(github.event.comment.body || github.event.review.body, '@dsh'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout trusted base or default branch only
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 1
      - uses: Lixiaoyiao/deepseek-harness-action@v0.12.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.2.1-rc.2
          permission-profile: strict
          isolation: docker
          natural-language-write: "false"
          allow-write: "false"
```

在 Issue/PR 评论 `@dsh 帮我分析这个问题`，或打开非 draft PR 进行自动审查。Action 只检出受信任的 base/default branch，通过 GitHub API 读取 PR，不运行 fork 中的代码。`issues: write` 和 `pull-requests: write` 供 Controller 发布回复使用，代码仍然只读。

生产环境应绑定对应 GitHub Release 公布的完整 commit。正式版本通过验证后，解析对应不可变 tag 的完整 SHA；安装器版本和其绑定的 Action commit 是独立的发布身份。权限、版本固定、安全检出规则和完整模板见[安装指南](docs/setup.zh-CN.md)。

## 核心能力

| 能力             | 作用                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| PR 审查          | 审查新提交，发布一条汇总，并为高置信度问题添加行内评论                              |
| 通用任务         | 回答仓库问题，或执行经过明确授权的编码任务                                          |
| CI 诊断与修复    | 读取失败的检查和日志；受信任 workflow 可以验证并发布修复                            |
| Issue 实现       | 把经过授权的 Issue 请求实现为已验证的分支和 PR                                      |
| Composition 模式 | 默认保留现有受控工具档位，并提供实验性的 DSH native 模式                            |
| 受控工具         | 以精确工具档位提供原生、固定命令、Controller GitHub、MCP、Bundle 与 Plugin 工具     |
| 结构化结果       | 保留 schema-v1 审计信封，并可校验维护者定义的可选 task 结果                         |
| 图片与二进制文件 | 使用 DSH 官方工具读取 PNG/JPEG/WebP/GIF，下载符合条件的 GitHub 图片并保持二进制字节 |

Action 提供基于锁定 DSH `0.2.1-rc.2` runtime 的实验性 `dsh-mode: native` 路径及其官方生态 composition。Native MCP server、Profile Bundle、direct Cordis Plugin、仓库 Skills、Subagent 和 Workflow 保留 DSH-native discovery 与行为。`controlled` 仍是兼容默认值，因此未配置 `dsh-mode` 的 workflow 会继续使用原有 composition、权限、工具、budget、receipt 和输出行为。

Native 模式并不是 unsafe 模式。它把 DSH 内部 headless composition、capability graph 和 model-visible inventory 的 ownership 交还给 DSH。Native MCP 通过官方 `@deepseek-ai/dsh-mcp-client` 加载；Bundle 作为官方 Profile layer 组合；direct Plugin 通过 Cordis 加载；仓库 Skills、Subagent 与 Workflow 保留 DSH-native 行为。它使用 definition-only 扩展 schema 来声明 owner 和进程需求，而不是声明 Action tool、grant 或 per-tool budget。动态生态工具只通过运行时 `observedTools` 出现，native `toolPolicy` 不会虚构 Controller `effectiveTools`。

Action 仍拥有 trusted-workflow admission、package exact pin、lifecycle script 禁用、runtime inventory audit、Docker 与 `.git`-less workspace 边界、run-scoped DeepSeek 凭据代理、GitHub 凭据隔离、actor/repository trust、validation 与 deferred write、deadline、cancellation 和 secret redaction。Native 仍仅支持 Docker；bridge network 和 read/write mount 都是 whole-worker 能力，不是 per-extension 或 per-tool sandbox。用户自行配置并携带自有凭据的 GitHub MCP 属于受信任外部扩展，其直接副作用不享受 Controller Gateway 的 binding、revalidation、validation 或 deferred-mutation 保证。Controller-owned `command.*` 与 `github.*` 能力继续作为独立且与 mode 正交的平面。

Action 支持[按 key 自动创建或续接 Session](docs/zh-CN/session.md)，保留显式保存与恢复。受信工作流自动定位最新成功且兼容的检查点；失败、状态不明、缺失、过期或损坏的历史会明确阻断，避免静默回退。同 key 串行，不同 key 可以并行。继续复用 DSH 已发布的 persistence 和 Headless 接口，保持 Controller / DSH / Gateway / validation 分层、DSH `0.2.1-rc.2` 精确锁定及 Session 默认关闭。本次权限重新计算，旧 GitHub 写入不会重放。[文本文件上下文](docs/text-files.md)、[离线配置检查](docs/configuration-check.md)和[限界 GitHub 请求诊断](docs/github-requests.md)继续可用。

### 图片和文件

在 GitHub Issue、PR 或评论中上传 PNG、JPG、WebP、GIF，再用 `@dsh task --read` 提问。符合现有信任条件、使用 Docker 且具有 `workspace.read` 权限时，Controller 自动下载 GitHub 托管图片，由 DSH 官方 `read_image` 读取；仓库图片也使用同一工具。最多尝试下载 8 张，每张 4 MiB、合计 16 MiB；跳过或失败的原因会写入运行日志。不可信 PR 的工具权限保持不变。

二进制仓库文件在工作区复制和 Git Blob 发布时保持原始字节。生成或修改文件需要已有授权的二进制处理命令或扩展，并通过原有写入验证。Session 检查点也会保存官方图片/文件附件引用对应的字节。PDF、Word、Excel 默认仅支持原样保存；理解或编辑内容需要维护者配置合适的 DSH 扩展，Action 不内置文档解析器。详见[文件支持与限制](docs/zh-CN/file-support.md)。

## 真实运行

以下是本仓库的公开运行记录，可以直接查看评论和 Actions 日志。

| 场景                            | 运行记录                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 审查，以及复跑时不重复发评论 | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| 根据失败的检查和日志进行诊断    | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| 在受信任写模式下修复并验证      | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| 实现 Issue 后创建 PR            | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## 自然语言与原有 `@dsh` 命令

在 Issue/PR 评论、PR review 或行内评论中，让 `@dsh` 从代码之外的一行开始，后面直接写需求即可。前面可以有背景说明或空行；每条评论使用一个实际调用。引用、代码块、行内代码和机器人发布的自然语言不会触发任务。`请让 @dsh 看一下` 这类句中提及也不会触发。

| 命令                          | 用途                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `@dsh 帮我分析这个问题`       | 通用任务；默认只读，除非工作流明确启用写任务               |
| `@dsh 修复这个 Bug 并提交 PR` | 仅在工作流开启自然语言写入并满足原有写入关卡时，请求写任务 |
| `@dsh task --read <问题>`     | 解释代码、检查仓库或回答通用问题                           |
| `@dsh task --write <任务>`    | 请求编码任务；所有写入关卡仍须通过                         |
| `@dsh review`                 | 重新审查当前 PR                                            |
| `@dsh diagnose`               | 诊断失败的检查和日志                                       |
| `@dsh fix`                    | 在受信任写模式下修复同仓库 PR                              |
| `@dsh implement`              | 实现 Issue 并创建 PR                                       |

紧跟 `@dsh` 的首个词如果是 `task`、`review`、`diagnose`、`fix` 或 `implement`，仍按原有命令处理，不区分大小写。例如 `@dsh fix` 是显式写请求，不受自然语言写入开关控制；默认只读 starter 会拒绝它。自然语言可以使用 `@dsh 修复这个 Bug` 或 `@dsh Please fix this bug`。

`--write`、`fix` 和 `implement` 只是请求能力，并不授予权限。workflow 必须显式启用写模式，并提供由 Controller 执行的验证命令。自然语言默认只读；只有启用 `natural-language-write` 且明确要求修改代码时，才会请求写入。`task-access` 不会启用自然语言写入。命令和自动化用法见[使用指南](docs/usage.zh-CN.md)，完整关卡见[配置参考](docs/configuration.md)。

维护者可以修改 trigger phrase，添加 label/assignee 路由，过滤 actor 或历史评论，选择 base branch，并配置确定性 branch template。这些设置只改变路由和命名；GitHub authority 仍由 Controller policy 与 workflow token scope 决定。

## 安全边界

- Agent 不会拿到真实的 `GITHUB_TOKEN` 或 DeepSeek key。只有 Controller 能调用 Action-owned `github.*` 写入 API；显式配置的外部 GitHub MCP 使用其自有凭据和 authority，边界见下文。
- 仓库内容、diff、Issue、PR、评论、日志、模型输出和工具输出始终是不可信数据。
- fork 审查使用没有 `.git`、没有凭据的 worker；workflow 只能检出受信任的 base SHA，并设置 `persist-credentials: false`。
- 写入需要受信任的同仓库上下文、通过授权检查的操作者、Docker、`allow-write: "true"`、非空固定验证命令，以及全部验证成功；受保护路径和 Validation Integrity 检查仍然有效。
- Typed `github.*` mutation 使用精确 ID、绑定当前 entity，并延迟到 Controller 验证成功后执行，同时保留有界 receipts 与 reconciliation；不存在 arbitrary REST、GraphQL、raw URL 或凭据透传。
- Validation Integrity 针对已支持的 entrypoint、package script、test/config 变弱、lock/toolchain 控制和已知 wrapper/interpreter 提供高置信度变弱检测与 baseline replay；它不是完整的跨语言 dependency provenance 或形式化完整性证明。
- Validation 可能使用 Docker bridge network。在 self-hosted runner 或企业网络中，仓库验证代码可能访问 runner 可达的网络服务；应使用专用 runner 以及 runner 级网络分段和出口控制。
- 获准的 Bundle、Plugin 或 stdio MCP server 属于受信任的 worker code。Controlled ToolRuntime 只限制模型路由的调用；native 的路由与 inventory 由 DSH 自己管理。两种模式都不能沙箱化扩展启动、后台任务或直接进程 I/O，任何 bridge/RW 能力都作用于整个 worker。
- `github.*` 使用 Controller GitHub Gateway；另行配置的 GitHub MCP 使用它自己的外部凭据，不享受 Gateway 的 binding、revalidation、validation 和 deferred-write 保证。

启用写模式、host 执行、网络访问或第三方扩展前，请完整阅读[安全策略](SECURITY.md)。

## 文档

| 指南                                                                       | 内容                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [安装指南](docs/setup.zh-CN.md) · [English](docs/setup.md)                 | 安装器、手工安装、Secret、权限、安全检出和模板                       |
| [使用指南](docs/usage.zh-CN.md) · [English](docs/usage.md)                 | `@dsh` 命令、task、review、diagnose、fix、implement 和自动化         |
| [配置参考](docs/configuration.md)                                          | 输入、权限档位、工具、验证、扩展和输出                               |
| [图片与文件](docs/zh-CN/file-support.md) · [English](docs/file-support.md) | 支持的类型、GitHub 下载、二进制字节、Session 附件与限制              |
| [架构](ARCHITECTURE.md) · [不变量](docs/invariants.md)                     | 组件职责、authority 边界与稳定系统不变量                             |
| [故障排查](docs/troubleshooting.md)                                        | 权限拒绝、Docker、超时、取消、验证和扩展故障                         |
| [安全策略](SECURITY.md)                                                    | 信任模型、凭据边界、网络行为和已知限制                               |
| [扩展契约](docs/extension-contracts.md)                                    | MCP、Profile、Bundle、Plugin、ToolRuntime 和 receipts 的深层技术约束 |
| [维护者发布指南](docs/maintainer-release.md)                               | 本地检查、核心 E2E、release canary、版本更新和发布                   |
| [贡献指南](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)                     | 开发流程和版本历史                                                   |

## 开发

需要 Node.js 24。

```bash
npm ci
npm run check
```

具体流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。用于 GitHub Marketplace 的 `dist/` 会随版本提交，请勿手工修改。

## 许可证

本项目采用 [MIT](LICENSE) 许可证。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [BUNDLED_DEPENDENCIES.md](BUNDLED_DEPENDENCIES.md)。

DeepSeek Harness 提供 headless runtime 和官方扩展机制。GitHub 集成还参考了采用 MIT 许可证的 [Claude Code Action](https://github.com/anthropics/claude-code-action) 模式，以及 [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) 对执行权限和发布权限的分离方式；准确的来源说明记录在第三方许可文件中。
