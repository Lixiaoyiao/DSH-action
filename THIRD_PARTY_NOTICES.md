# Third-party notices

Parts of the GitHub integration architecture and selected utility code are
derived from [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
at commit `dc33e8a15b19e2109ac3fa8329058842f63780dc`.

The v0.11.0 GitHub image downloader and binary text detection also reference
the MIT-licensed `image-downloader.ts`, `binary-detection.ts` and Git Blob
Base64 flow at Anthropic commit `f27be6b65a4652f08a2ba3cff79114829b588967`.
The image tool, attachment storage and Session codecs remain official DSH
`0.2.1-rc.2` implementations; no Claude Agent runtime is included.

The v0.3 controller loop and its then-proposed extension design were also
reviewed against upstream commit
`d721746d683d812e669ce117cebe55a85fbd9c3e`. No Claude SDK, MCP server, plugin
runtime or session token implementation is bundled by that reference.

The v0.4 controlled-extension work continues to use those MIT-licensed GitHub
workflow trust patterns, but its MCP client, Profile, Bundle, Cordis, and
ToolRuntime integration uses DeepSeek Harness rather than Claude extension
runtime code.

The interoperability fixtures in `test/mcp-official.test.ts` and
`test/fixtures/mcp-server.mjs` are adapted from the DeepSeek Harness
`dsh-v0.1.0-rc.8` MCP client tests at commit
`141eb6fef83422698aef7a981029e843e8161534`, principally
`packages/mcp/mcp-client/tests/mcp-client.e2e.ts` and
`packages/mcp/mcp-client/tests/fixture-server.ts`.

The v0.9.0 runtime migration consumes the published DeepSeek Harness
`0.1.7-rc.2` package family at upstream release commit
`477b4f420553e8a52c2fbccc464d7561b239c443`. The worker runtime is installed from
the committed lockfile. Controller imports of DSH boot helpers and their
dependencies are separately included in the static NCC bundle and listed in
[`BUNDLED_DEPENDENCIES.md`](BUNDLED_DEPENDENCIES.md).
The exact dependency graph, upstream contract changes, and residual dependency
advisory are documented in
[`docs/dsh-0.1.7-rc.2-migration.md`](docs/dsh-0.1.7-rc.2-migration.md).

Regenerate the static notices with `npm run generate:bundled-notices` after a
normal build. The complete check verifies the result without rewriting it.
Package license files and complete README grants are preferred. The reviewed
offline supplements in `assets/licenses/supplemental-notices.json` bind each
exception to its exact package version, lockfile integrity, source and text
checksum. A declaration-only package is identified as such; no missing grant
or copyright text is invented. Unused supplements must be removed.

## Claude Code Action

MIT License

Copyright (c) 2025 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DeepSeek Harness MCP test fixtures

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
