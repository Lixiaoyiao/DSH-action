# 安装与接入

[English](setup.md) · [项目首页](../README.zh-CN.md) · [使用指南](usage.zh-CN.md) · [配置参考](configuration.md)

本指南从安装开始，带你启用只读 `@dsh` 对话和自动 PR Review。仓库需要修改代码时，再加入写入能力。

## 快速开始：安装器

在需要接入的现有 GitHub 仓库内运行：

```bash
npm create deepseek-harness-action@latest
```

在交互式终端中不传选项时，安装器打开本地浏览器 GUI，默认配置只读对话与
PR Review，也可以读取现有 DSH 工作流继续编辑。安装器 `0.7.3` 提供此 GUI，
生成的工作流绑定正式 Action `v0.12.2`。

选择预设或已有工作流，再选择 controlled/native、模型、思考强度和其它 Action
选项。预览显示 YAML 差异，并调用 Action 自身的静态配置检查器。确认保存后只写入
本地 `.github/workflows/*.yml` 或 `*.yaml`。安装器不提交、不推送、不创建远端仓库，
也不上传密钥。

在 GitHub **Settings → Secrets and variables → Actions** 添加 `DEEPSEEK_API_KEY`。
工作流使用 `${{ secrets.DEEPSEEK_API_KEY }}` 等引用，不在编辑器或 YAML 中填写真实
密钥。通过日常 Git 流程审查、提交并推送文件，让它们到达默认分支。

```bash
npm create deepseek-harness-action@latest -- --gui
npm create deepseek-harness-action@latest -- --no-open
```

`--gui` 显式打开浏览器；`--no-open` 只打印本次会话的私有地址，供你自行打开。
编辑期间保持终端运行。服务只监听 `127.0.0.1` 的随机端口，使用每次新生成的会话
Token 和同源校验。停止服务后旧地址失效；再次运行即可建立新会话。不要转发端口或
分享含 Token 的完整地址。

YAML 是配置源，没有额外配置数据库或浏览器持久化副本。重新打开时从文件读取；
如果外部编辑器在预览后改动文件，先重新加载再保存。不支持的 YAML 结构或包含明文
密钥的工作流需要手工处理。

在现有 `allowed-actors` 输入中填写逗号分隔的用户名，GUI 会生成 job 级条件，
让名单外的触发者在 Runner 启动前被跳过，并保留自定义条件和 Action 的运行时授权。
默认 `*` 不添加限制。动态表达式名单需要在 YAML 编辑器中配置前置条件；GUI 不猜测
动态值。手工修改过的生成条件也由你在 YAML 中维护。若组合后的表达式超过 GitHub
长度上限，GUI 会报错；可缩短名单或在 YAML 中使用更短的条件。

GUI 提供以下预设；`--advanced` 保留为 GUI 别名：

| 选择                     | 创建的文件                           |
| ------------------------ | ------------------------------------ |
| **只读对话 + PR Review** | `.github/workflows/dsh-review.yml`   |
| **@dsh Coding Commands** | `.github/workflows/dsh-commands.yml` |
| **Both**                 | 以上两个 workflow 文件               |
| **Automatic Session**    | `.github/workflows/dsh-session.yml`  |

CI 或其它非交互环境必须明确选择 mode。这一路径直接生成文件，保留已有文件，
不需要浏览器或读取 stdin：

```bash
npm create deepseek-harness-action@latest -- --mode both
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

省略 `--dsh-mode` 时默认 controlled；CI 或非交互环境缺少 `--mode` 时直接显示
用法错误。静态检查只确认配置结构；凭据有效性、在线权限/配额、Docker 与项目
验证仍需首个真实 Action 运行来确认。

Automatic Session 生成只读 starter，绑定相同的 key/run-name/concurrency，并以
`queue: max` 保留排队请求。提交到默认分支后，从默认分支 dispatch；为逻辑任务
选择小写 key，后续用同 key 和新 prompt 续接，无需 source run ID。
失败、过期、损坏或状态不明的历史须先协调解决。

```bash
npm create deepseek-harness-action@latest -- --mode session
```

安装器 `0.7.3` 面向正式 Action `v0.12.2`，两种 composition 都保持精确
DSH `0.2.1-rc.2`。只有 Action Tag、
GitHub Release 和 canary 身份一致后，打包才通过 `DSH_ACTION_RELEASE_SHA`
接收核验出的完整 commit。独立审查的安装器源码使用
`create-deepseek-harness-action-v0.7.3` Tag。源码模板保留受控 build token，
生成的 workflow 不包含该 token、candidate SHA、浮动 Tag 或分支。
源码 commit 不能提供自身尚未确定的未来身份。

安装成功后：

1. 在 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`。
2. 把 workflow commit/push 到默认分支；使用 Review 时，打开或更新非 draft PR。
3. 具有仓库 write 权限的协作者可以在 Issue 或 PR 中评论 `@dsh 帮我分析这个问题`。让提及从引用和代码之外的一行开始，无需固定子命令。Review 模式也支持 PR review 正文和行内评论；安装两个模板时，仅由 Commands 处理评论，避免重复回答。
4. 需要自然语言写入时，在高级 Commands 工作流中明确启用 `natural-language-write: "true"`，保留 `allow-write: "true"` 并配置项目验证命令，再使用 `@dsh 修复这个 Bug 并提交 PR` 这样的明确请求。默认 starter 仍只读，请求里写“修复”也不会改变权限。`task-access` 不会启用这个独立开关。
5. 原有命令和自动化用法见[使用指南](usage.zh-CN.md)。

本地只在运行安装器时需要 Node.js 和 npm；生成的 workflow 不会假定目标仓库是 Node.js 项目。

## 首次启动模型前检查配置

在经过审核的 Action 源码 checkout 中，用 Node.js 24 和已安装的锁定依赖，
复制 [`examples/config-check.json`](../examples/config-check.json)，把 `inputs`
改为 workflow 中的字面量输入名和值。凭据不要写进 JSON；`credentialEnv`
只指定保存 Controller 凭据的环境变量名称。

```bash
npm run check:config -- --config examples/config-check.json
```

检查器只读取明确选择的 JSON 文件（普通 UTF-8 文件，最多 256 KiB），复用
Action 的公开输入和扩展 schema，检查缺少凭据、DSH 精确版本、模式与隔离、
明确写任务的验证配置。它不启动模型、不执行仓库代码或验证命令、不联网、
不修改远端状态。JSON 输出的 `scope` 是 `static_configuration_only`；
`ok: true` 只表示静态配置通过。Docker/镜像可用性、凭据有效性、在线权限与
配额、当前事件/SHA 授权、文本文件内容和扩展激活都明确标记 `not_checked`。
允许写入的 `auto` 配置缺验证时只发警告，以保留只读路由；实际路由为写任务
时会在模型启动前拒绝。

实际运行时，凭据缺失、DSH 版本不支持或扩展格式错误在解析输入时失败。
明确或路由后的写任务会提前拒绝空验证、禁用测试和未替换的占位符；
有时间上限、无 Controller 凭据的 `docker info` 预检会在安装 runtime 前
报告 CLI/daemon 不可用。这些检查不授予权限，也不替代 Controller 的真实验证。

安装器 0.7.3 为 `commands` / `both` 提供显式 `--test-commands` JSON argv
和 `--container-image name@sha256:<64 位小写十六进制>`。维护者必须自行选择来源可信、经过审核、无凭据的验证命令。
安装器不会自动发现或执行脚本；省略选项仍保留安全失败的验证占位符。

## 手工安装

如果希望自己创建 workflow，请按以下步骤操作。

### 准备条件

- 你能在目标 GitHub 仓库中添加 Actions Secret 和 workflow。
- 一个 DeepSeek API key。
- GitHub 托管的 Ubuntu runner，或已经安装 Docker 的自托管 runner。
- 只有开发这个 Action 本身时才需要 Node.js 24；手工安装的 workflow 不需要单独安装 Node.js。

处理不可信 PR 数据、执行任何写入，以及使用任何 MCP、Bundle 或 Plugin 扩展时，都必须使用 Docker。可选的 host 执行路径没有操作系统隔离，只适合专用的受信任 runner。

### 1. 添加 API key

打开 **Settings → Secrets and variables → Actions → New repository secret**，创建：

```text
DEEPSEEK_API_KEY
```

只把它传给 `deepseek-api-key` 输入。不要通过 `env`、prompt、验证命令、MCP 配置或 Plugin 配置暴露它。Action 会把真实 key 留在 Controller 侧代理中，DSH worker 只会拿到临时代理令牌。

默认的 `github-token` 是 `${{ github.token }}`，也只由 Controller 使用。请禁用 checkout 凭据，避免仓库代码或 worker 继承 Git 凭据。

### 2. 选择 Action 版本

为了便于阅读，示例使用当前发布 Tag：

```yaml
uses: Lixiaoyiao/deepseek-harness-action@v0.12.2
```

生产环境应把 Tag 替换为从正式 `v0.12.2` 解析出的完整、不可变 commit SHA。
安装器 `0.7.3` 对应该 Action 身份，独立审查的 installer 源码 commit 是另一个身份。
生成的 workflow 使用核验后的正式 commit，源码模板通过发布构建接收该值。

必须分别核验 installer 源码 Tag 与 `DSH_ACTION_RELEASE_SHA` 打包输入；源码中的
迁移候选准备不能代替正式发布身份。

不要使用 `main`、`latest`、版本范围、candidate SHA 或其它浮动 ref。
`dsh-version` 必须保持为本版本审计过的精确值：

```yaml
with:
  dsh-version: 0.2.1-rc.2
```

只有新的 DSH package family、Profile 和工具面完成复核并随新版本发布后，Action 才会接受不同版本。

### 3. 添加只读对话和自动 PR Review

创建 `.github/workflows/dsh-review.yml`：

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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.12.2
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.2.1-rc.2
          permission-profile: strict
          isolation: docker
          natural-language-write: "false"
          allow-write: "false"
```

`pull_request_target` 可以访问 Secret 和权限较高的 token，因此 PR 事件只检出不可变、受信任的 base SHA。Issue/PR 讨论评论使用受信任的默认分支。Action 通过 GitHub API 获取 PR diff 和变更文件上下文，不检出或运行 fork revision。请保留 `persist-credentials: false`。Issue/PR 写 scope 用于发布评论，`contents: read` 和 `allow-write: "false"` 仍使仓库代码保持只读。

在 Issue/PR 评论 `@dsh 帮我分析这个问题`，检查 **Actions → DSH review** 和回复。打开非 draft PR 可测试自动审查。仅需审查的工作流见 [`examples/fork-review.yml`](../examples/fork-review.yml)。

### 4. 只授予入口真正需要的 GitHub 权限

Agent 权限档位不会授予 GitHub 权限。workflow token scope 只决定受信任 Controller 可以调用哪些 API。

| 场景                              | Workflow 权限                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| 自动或 fork PR 审查               | `contents: read`、`pull-requests: write`                                                    |
| 不需要 Issue/PR 评论的只读 task   | `contents: read`                                                                            |
| 需要 Issue/PR 结果评论的只读 task | `contents: read`，再增加对应的 `issues: write` 或 `pull-requests: write`                    |
| CI 诊断                           | `actions: read`、`checks: read`、`contents: read`、`issues: write`、`pull-requests: write`  |
| 允许 fix 或 implement 的命令      | `actions: read`、`checks: read`、`contents: write`、`issues: write`、`pull-requests: write` |
| CI 自动修复                       | 与上一行相同                                                                                |
| 创建分支和 PR 的自动化任务        | `contents: write`、`pull-requests: write`                                                   |
| 选中的 typed GitHub Tools         | 只增加对应的 `issues`、`pull-requests`、`checks` 或 `statuses` 读写 scope                   |

较宽的 workflow token 不能绕过 actor、事件、来源、SHA、受保护路径、验证或 Controller 策略。反过来，缺少必要 scope 也会让本来获准的结果无法发布。

### 5. 添加命令、CI 或自动化流程

按使用场景复制模板：

- [`examples/commands.yml`](../examples/commands.yml)：`@dsh` task、review、diagnose、fix 和 Issue 实现。
- [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml)：诊断失败的 CI，不修改代码。
- [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml)：带强制验证的受信任 CI 修复。
- [`examples/task-automation.yml`](../examples/task-automation.yml)：由维护者发起、可选只读或写入的 dispatch task。
- [`examples/github-integration.yml`](../examples/github-integration.yml)：自定义路由、安全分支命名、typed GitHub Tools 与结构化 task output。
- [`examples/controlled-extensions.yml`](../examples/controlled-extensions.yml)：高级 custom Profile、MCP 和 Bundle 配置。

对于 `issue_comment`、`workflow_run`、dispatch 和 schedule workflow，应从受信任的默认分支运行 workflow 定义。检出已经绑定的受信任分支或 SHA，始终设置 `persist-credentials: false`，并确保带权限含义的输入只使用字面值，或只从受信任 workflow 配置推导。

`prompt`、trigger/filter、branch、schema 与 tool inputs 都属于受信任的维护者配置。不要把 Issue 正文、PR 内容、评论、日志、仓库文件或模型输出插入其中。GitHub 会在 Action 启动前解析表达式，Action 无法恢复这些值原来的来源。

### 6. 谨慎启用写模式

写命令本身不会授权变更。有效的写 workflow 还必须通过 actor、事件、同仓库、分支、SHA、workspace 和工具策略检查，并配置由 Controller 执行的验证。启用写模式前，必须把下面的每个占位符替换为适合你项目的命令和固定到 digest 的容器镜像；这里特意不提供 npm 默认值：

```yaml
with:
  permission-profile: standard
  allow-write: "true"
  run-tests: "true"
  validation-integrity: strict
  test-commands: >-
    [
      ["REPLACE_WITH_YOUR_PROJECT_INSTALL_COMMAND"],
      ["REPLACE_WITH_YOUR_PROJECT_TEST_COMMAND"]
    ]
  container-image: REPLACE_WITH_YOUR_PROJECT_IMAGE@sha256:REPLACE_WITH_FULL_DIGEST
```

每条 validation command 都是固定 argv 数组，不会经过 shell 展开；每个参数都要写成独立字符串，并且所有命令都必须成功。占位符在替换前会安全失败。`run-tests: "false"` 会拒绝写入，不是跳过验证的开关。

Docker image 本身就是可执行的 worker code。写入和扩展必须使用完整 digest，不能只固定 Tag。启用前请阅读[写模式与验证](configuration.md#write-validation-and-integrity)。

### Checkout、超时与并发规则

- 固定每个 `actions/checkout` 版本，并设置 `persist-credentials: false`。
- 使用 `pull_request_target` 时，只检出 `github.event.pull_request.base.sha`，绝不运行 fork checkout。
- 按 PR、Issue、上游 run 或自动化目标设置 concurrency group。sticky marker 不包含 run/head 新鲜度信息，因此必须串行化，避免旧运行覆盖新状态。
- job 的 `timeout-minutes` 应比 Action 的同名输入多留几分钟，让 Action 有一个短且有上限的窗口停止 worker、写入 outputs，并尝试发布适用的取消状态。
- runner 被强制终止时可能完全跳过 cleanup。应以 Actions conclusion 为准，详见[评论一直显示 In progress](troubleshooting.md#cancellation-or-a-sticky-comment-remains-in-progress)。

### 验证接入结果

第一次运行后，确认：

1. Checkout 显示 `persist-credentials: false`，且检出的是预期受信任 SHA。
2. Action 把 `dsh-version` 解析为 `0.2.1-rc.2`。
3. 只读审查没有 workspace 写能力。
4. 只出现预期的 Controller-owned 汇总评论和行内问题。
5. step summary 与 `result-json` 中的 operation、权限档位、有效工具和网络路径符合预期。

接下来可阅读[使用指南](usage.zh-CN.md)了解命令，阅读[配置参考](configuration.md)了解全部输入、权限边界和输出。

## 导入本地 DSH 插件

在终端运行 `npm create deepseek-harness-action@latest -- --advanced --import-plugins`。安装器只读取 `DSH_HOME/profiles` 下的包元数据，默认目录是 `~/.dsh/profiles`。它会展示第三方包名称、已安装版本和对 DSH `0.2.1-rc.2` 的兼容情况，再询问要导入的编号并确认。其他目录可用 `--dsh-home` 指定。

Native 模式可按精确版本重新安装已启用的 npm DSH Bundle。Controlled 模式还需要填写实际的 `plugin__owner__tool` 工具名，只允许你选中的只读工具。使用其他工具命名的插件需要 Native 或手工配置。本地路径、npm 别名、已停用的 Bundle、不兼容版本和普通依赖包需要手工处理，列表会说明原因。没有声明兼容范围时会明确显示未验证。

确认后才会在工作流中启用插件安装。不会复制 `.env`、密钥、本地 Cordis 配置、兼容例外或插件设置。导入的插件使用包自带默认值，不额外申请网络或工作区写权限；现有工作流的权限和整个 worker 的挂载范围仍然适用；所需云端配置可通过已有扩展输入另外设置。Fork PR 审查继续使用不加载扩展的配置。

Native 的网页搜索和读取通过 Controller 代理调用新版 DeepSeek Search/Fetch API。Controlled 的搜索也使用 Search API；Fetch 需要在 custom 或 standard 权限档位中明确加入 `native.web-fetch`。`base-url` 同时决定这些 API 的上游，`web-search-base-url` 保留为旧 Messages 搜索路由。新版 Flash 使用的模型 ID 是 `deepseek-flash`。

Controlled 自动导入面向只读 Review 和 Session；Coding Commands 的插件需要手工声明各任务所需权限。选择同时安装时，插件只加入 Review，Commands 保持原样。Native Commands 保留原有信任检查，插件不能在不受信任的 fork 命令中运行。

显式自定义 `web-search-base-url` 时保留原有 Messages 搜索协议；默认地址使用新版 Search API。Fetch 始终使用独立授权和 `base-url`，也可以只开启 Fetch 而不启用搜索。
