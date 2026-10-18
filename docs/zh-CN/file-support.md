# 图片、二进制文件与 Session 附件

[English](../file-support.md) · [配置](../configuration.md) · [Session](session.md)

图片解码、模型输入和附件存储由 DSH 官方能力负责。Action 负责 GitHub 下载、
隔离文件访问和保持字节完整的 GitHub 发布，继续使用现有 Controller/Worker
架构和写入验证。

## 支持范围

| 文件或来源                          | 支持方式                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| 仓库 PNG、JPG/JPEG、WebP、GIF       | 在符合权限条件的仓库工作区调用 DSH 官方 `read_image`。GIF 读取单帧，不承诺分析动画。 |
| PR、Issue、评论中上传的 GitHub 图片 | 自动限量下载，再交给同一个官方 `read_image` 工具。                                   |
| 普通二进制仓库文件                  | 在仓库物化、工作区复制和 Git Blob 提交中保持原始字节，不代表理解文件格式。           |
| PDF、Word、Excel                    | 原样保存字节；理解或处理内容需要维护者配置 DSH 扩展及其依赖。                        |
| 官方 Session 图片/文件附件          | 检查点携带引用对应的字节，并通过 DSH 附件存储恢复。                                  |
| `prompt-file`、`context-files`      | 仍只接受 UTF-8 文本，沿用现有路径和大小限制。                                        |

## 使用图片

读取仓库图片时，给出仓库相对路径，例如：

```text
@dsh task --read 请检查 assets/screenshot.png，解释布局问题。
```

读取上传图片时，通过 GitHub 上传界面把图片放进 Issue、PR 正文或评论，并附上
问题，无需新增 Action 配置。符合现有信任条件的 Docker 运行会从已收集的任务
上下文识别内联 Markdown、HTML `img` 和裸 GitHub 上传链接。Controller 下载后
提供本地路径，DSH 通过官方 `read_image` 读取。默认 `deepseek-flash` 支持图片；
自定义模型或端点也须支持 DSH 生成的图片请求。

图片读取沿用 `workspace.read` 权限。显式拒绝该工具、使用 host 执行或处理
不可信 PR 时，不会因出现图片自动扩大权限；拒绝原因见运行的权限说明。

下载文件位于仓库之外的 `/dsh-home/github-images`，使用现有 worker home
只读挂载。图片始终是非可信任务数据，不会自动成为仓库改动。DSH 可以为模型
规范化图片，但不会因此重写仓库中的原文件。

## 下载范围与限制

只接受 HTTPS GitHub 上传地址：`github.com/user-attachments/assets/`、旧版
`github.com/<owner>/<repo>/assets/<id>/`，以及
`user-images.githubusercontent.com`、`private-user-images.githubusercontent.com`
上的数字用户路径。其他主机和仓库 `raw`/`blob` URL 不会下载；已经提交到仓库的
图片应使用仓库路径。

| 边界             | 限制                                               |
| ---------------- | -------------------------------------------------- |
| GitHub 图片下载  | 最多尝试 8 张；每张 4 MiB；成功下载字节合计 16 MiB |
| 单张请求链       | 30 秒，最多 3 次受支持 GitHub 图片存储内的重定向   |
| 链接发现         | 有界任务上下文中前 64 个不同的图片引用             |
| DSH 官方源图片   | 编码后 20 MiB、6,400 万像素、单边 8,192 像素       |
| 模型代理请求体   | 32 MiB，包含文本和图片 base64 数据                 |
| 仓库物化及工作区 | 最多 50,000 个普通文件、合计 1 GiB                 |
| GitHub 发布      | 最多 200 个改动文件；新增和修改字节合计 10 MiB     |

下载响应类型必须是 PNG/JPEG/WebP/GIF，由 DSH 验证并解码实际图片。Controller
只向 `github.com` 发送 GitHub token，重定向后的图片存储主机不会收到该 token。
跳过和下载失败会输出带原因的运行警告。私有或过期链接可能返回 HTTP 403/404；
可以重新上传，或把图片提交到可访问的仓库路径。超出大小限制时使用更小图片。
不支持的格式和解码错误由下载器或官方工具给出对应诊断。

## 保存与修改二进制文件

GitHub blob 解码为字节，工作区直接复制字节，提交使用 Git Blob base64 编码，
不会在发布时转成 UTF-8。PR 文本上下文省略含 NUL 或非法 UTF-8 的 blob，
避免提供截断的伪文本源内容。

生成或修改二进制文件需要工作流已经授权的二进制处理命令或扩展。DSH 文本编辑
工具不是通用二进制编辑器。发布前仍须通过 `allow-write`、操作者及仓库授权、
受保护路径限制和 Controller 验证。

## PDF、Word 和 Excel 扩展

固定的 DSH `0.2.1-rc.2` 提供 Attachment、Files API、SDK/ACP 和官方扩展机制，
但这些文件传输接口没有为本 Action 的 Headless 流程提供内置 PDF/Office 解析器。
官方 Office Skill 依赖另外安装的 Python、LibreOffice 等工具。

需要文档处理时，使用已有的 [native Skill/Bundle/Plugin 或 MCP 配置](../configuration.md#native-bundle-plugin-skill-subagent-and-workflow-loading)，
选择受信任的处理器，锁定包版本，在指定 worker 镜像中提供其文档要求的依赖，
并只授予它所需的现有能力。检测到文件不会自动安装扩展或授予 shell/网络权限。
Action 不自动转换 Office/PDF，也不承诺理解任意二进制格式。
[官方接口调查](../dsh-file-support.md)记录了检查过的上游能力。

## 带附件续接 Session

启用 Session 后，已结算的官方图片/文件引用与实际附件字节一起保存，原始 DSH
v4 JSONL 日志保持不变。恢复时通过 DSH 公开附件存储重建同一个引用，Controller
在导入 Session 前核对不透明引用标识、摘要和字节数。官方 Worker 在读取图片时
校验媒体类型和尺寸。

检查点最多携带 20 个不同引用，每个附件 20 MiB、合计 50 MiB；原始日志仍为
4 MiB、manifest 为 16 KiB。缺失字节、引用标识或摘要不符、附件超限都会明确失败。
检查点不复制任意工作区文件，也不会重新下载历史 URL；仅在文本中提到文件名
不会生成附件。当前权限重新计算，旧 GitHub 写入不重放。配置和恢复方式见
[Session 文档](session.md)。
