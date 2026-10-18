# Images, binary files and Session attachments

[中文](zh-CN/file-support.md) · [Configuration](configuration.md) · [Session](session.md)

DSH owns image decoding, model input and attachment storage. The Action supplies
GitHub downloads, isolated file access and byte-preserving GitHub publication.
The existing Controller/Worker architecture and write validation remain in use.

## Supported behavior

| File or source                                     | Support                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Repository PNG, JPG/JPEG, WebP and GIF             | Official DSH `read_image` in an eligible repository workspace. GIF is read as a single frame; animation analysis is not promised.      |
| GitHub-uploaded images in PRs, Issues and comments | Automatic bounded download, then the same official `read_image` tool.                                                                  |
| Regular binary repository files                    | Exact bytes are preserved during materialization, workspace copies and Git Blob commits. This does not imply understanding the format. |
| PDF, Word and Excel                                | Opaque byte preservation. Content processing requires a maintainer-configured DSH extension and its dependencies.                      |
| Official Session image/file attachments            | Referenced bytes travel with the checkpoint and are restored through DSH's attachment store.                                           |
| `prompt-file` and `context-files`                  | UTF-8 text only; their existing path and size limits still apply.                                                                      |

## Use images

For a repository image, ask an eligible task to inspect its repository-relative
path, for example:

```text
@dsh task --read Inspect assets/screenshot.png and explain the layout problem.
```

For an uploaded image, paste it into an Issue, PR body or comment using GitHub's
upload UI and include the question. No new Action input is required. In an
eligible trusted Docker run, the Controller recognizes GitHub upload links from
inline Markdown, HTML `img` elements and bare upload URLs in the collected task
context. DSH receives the staged local path and calls its official `read_image`.
The default `deepseek-flash` model supports image input; a custom model or
endpoint must also support the image requests produced by DSH.

Image reading uses the existing `workspace.read` authority. A workflow that denies
that tool, uses host execution or handles an untrusted PR does not gain image
access automatically. Use the run's permission explanation to understand a denial.

Downloaded images are outside the repository, under `/dsh-home/github-images`,
on the existing read-only worker home mount. They are untrusted task data and do
not become repository changes. DSH may normalize an image for the model; this
does not rewrite the source repository file.

## Download scope and limits

The downloader accepts HTTPS GitHub upload URLs under
`github.com/user-attachments/assets/`, the older
`github.com/<owner>/<repo>/assets/<id>/` route, and numeric-user paths on
`user-images.githubusercontent.com` and `private-user-images.githubusercontent.com`.
Other hosts and repository `raw`/`blob` URLs are not downloaded. Use the repository
path for an image already committed to the repository.

| Boundary                               | Limit                                                                 |
| -------------------------------------- | --------------------------------------------------------------------- |
| GitHub image download                  | 8 attempts; 4 MiB per image; 16 MiB total successful bytes            |
| Per-image request chain                | 30 seconds, at most 3 redirects within supported GitHub image storage |
| Discovery                              | First 64 distinct detected image references from bounded task context |
| Official DSH source image              | 20 MiB encoded, 64 million pixels, 8,192 pixels per side              |
| Model proxy request body               | 32 MiB, including text and base64 image data                          |
| Repository materialization / workspace | 50,000 regular files; 1 GiB aggregate bytes                           |
| GitHub publication                     | 200 changed files; 10 MiB aggregate added/modified bytes              |

GitHub downloads require a PNG/JPEG/WebP/GIF response type. DSH validates and
decodes the raster. The Controller sends its GitHub token only to `github.com`;
redirects to GitHub image storage never receive that token. Failed downloads and
skipped references emit run warnings with their reason. Private or expired links
may return HTTP 403/404; upload the image again or commit it to an accessible
repository path. For size errors, use a smaller image. Unsupported formats and
DSH decoding errors are reported by the corresponding downloader or tool.

## Preserve and change binary files

GitHub blobs are decoded to bytes, copied as bytes and committed with Git Blob
base64 encoding. Binary files are not converted to UTF-8 for publication. PR text
context omits NUL-containing and invalid-UTF-8 blobs instead of presenting a
partial decoded source.

Generating or changing binary files requires a binary-capable command or
extension already authorized by the workflow. DSH text editing tools are not a
general binary editor. The existing `allow-write`, actor/repository checks,
protected-path restrictions and Controller validation apply before publication.

## PDF, Word and Excel extensions

The pinned DSH `0.2.1-rc.2` exposes attachment and Files APIs, SDK/ACP interfaces,
and official extension mechanisms. Those file transport interfaces do not provide
a built-in PDF/Office parser for this Action's Headless flow. Its official Office
Skill relies on separately installed tools such as Python and LibreOffice.

Use the existing [native Skill/Bundle/Plugin or MCP configuration](configuration.md#native-bundle-plugin-skill-subagent-and-workflow-loading)
to add a trusted document processor when needed. Pin its packages, provide its
documented dependencies in the selected worker image, and grant only the existing
capabilities it needs. File detection does not install it or grant shell/network
access. The Action does not convert Office/PDF files automatically or claim to
understand arbitrary binary formats. The [official-interface findings](dsh-file-support.md)
record the inspected upstream capabilities.

## Continue a Session with attachments

When Session mode is enabled, a settled official image/file reference is saved
with its actual attachment bytes. The raw DSH v4 JSONL log is unchanged. On
restore, DSH's public attachment store reconstructs the same reference and the
Controller checks its opaque reference identity, digest and byte count before
importing the Session. The official Worker checks image media type and dimensions
when it reads the attachment.

The checkpoint allows 20 unique references, 20 MiB per attachment and 50 MiB
total attachment bytes, in addition to the existing 4 MiB raw log and 16 KiB
manifest limits. Missing bytes, identity or digest mismatches and oversized
attachments fail explicitly. The checkpoint does not copy arbitrary workspace
files or re-download historical URLs. Merely mentioning a filename does not
create an attachment. Current permissions are recalculated and old GitHub writes
are not replayed. See [Session setup and recovery](session.md).
