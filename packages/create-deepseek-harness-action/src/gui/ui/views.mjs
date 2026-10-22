import { badge, button, card, el, empty, field, inputField, select } from "./components.mjs";
import {
  activeFile,
  activeStep,
  dirtyFiles,
  effectiveMode,
  isDirty,
  sections,
  stepInputs,
} from "./state.mjs";

const presets = [
  ["review", "只读对话 + 自动 Review", "从 PR 审查开始，保留对话入口。", "推荐起点"],
  ["commands", "指令驱动", "使用明确指令触发审查、诊断和任务。", "按需运行"],
  ["session", "连续会话", "跨运行保留可验证的会话上下文。", "Session"],
  ["automation", "自动化任务", "从任务模板开始，按仓库需要调整触发方式。", "进阶"],
];
const titles = {
  overview: [
    "让仓库工作流，按你的方式运行。",
    "从一个安全的起点开始，也可以直接编辑已有工作流。所有改动先留在本页草稿中。",
  ],
  configuration: [
    "把常用配置，一次说明白。",
    "选择当前 Action 步骤的运行方式与模型。其余输入都可以在高级设置中调整。",
  ],
  plugins: [
    "只添加这次需要的能力。",
    "先选择运行模式，再扫描本机已安装的插件，或填写确切的包版本。",
  ],
  advanced: [
    "保留完整控制。",
    "全部 Action 输入与完整 Workflow YAML 都在这里。切换页面不会丢失草稿。",
  ],
  preview: ["看清变化，再写入文件。", "检查文件差异、配置诊断与权限影响，确认后保存到本地仓库。"],
};

function filePicker(state) {
  return el(
    "div",
    { className: "file-list" },
    el(
      "p",
      { className: "sidebar-caption", title: state.repositoryRoot },
      state.repository || "工作流文件",
    ),
    state.files.length === 0 && el("p", { className: "sidebar-empty" }, "尚未添加工作流"),
    state.files.map((file) =>
      el(
        "button",
        {
          type: "button",
          className: `file-item ${file.localId === state.selectedFileId ? "is-active" : ""}`,
          dataset: { action: "select-file", id: file.localId },
          title: file.path,
          "aria-current": file.localId === state.selectedFileId ? "true" : "false",
        },
        el("span", { className: "file-icon", "aria-hidden": "true" }, "▤"),
        el("span", {}, file.path.split("/").at(-1)),
        isDirty(file) && el("span", { className: "dirty-dot", title: "有未保存的更改" }, "●"),
      ),
    ),
    button("＋ 添加工作流", "navigate", { kind: "sidebar", data: { section: "overview" } }),
  );
}

function stepPicker(state) {
  const file = activeFile(state);
  if (!file) return null;
  return el(
    "div",
    { className: "context-bar" },
    el("div", { className: "context-path" }, el("span", {}, "正在编辑"), el("code", {}, file.path)),
    file.steps.length > 0 &&
      field(
        "Action 步骤",
        select(
          file.steps.map((step) => ({
            value: step.id,
            label: `${step.jobId} · ${step.index + 1}${step.editable === false ? "（仅 YAML）" : ""}`,
          })),
          file.selectedStepId,
          { field: "step" },
        ),
      ),
    badge(
      file.expectedHash === null ? "新增草稿" : isDirty(file) ? "已修改" : "已载入",
      isDirty(file) ? "warning" : "neutral",
    ),
  );
}

function overview(state) {
  return [
    el(
      "div",
      { className: "preset-grid" },
      presets.map(([kind, title, text, tag]) =>
        el(
          "label",
          { className: `preset-card ${state.presetKind === kind ? "is-selected" : ""}` },
          el("input", {
            type: "radio",
            name: "preset",
            value: kind,
            checked: state.presetKind === kind,
            dataset: { field: "preset-kind" },
          }),
          badge(tag, kind === "review" ? "accent" : "neutral"),
          el("h2", {}, title),
          el("p", {}, text),
        ),
      ),
    ),
    card(
      "创建工作流草稿",
      "已有文件不会被模板覆盖。添加多个模板时，请为每个文件选择不同的名称。",
      el(
        "div",
        { className: "form-grid" },
        field(
          "运行模式",
          select(["controlled", "native"], state.presetMode, { field: "preset-mode" }),
          "controlled 使用 Controller 管理的工具策略；native 使用 DSH 原生组合。",
        ),
        field(
          "新文件路径（可选）",
          el("input", {
            value: state.presetPath,
            placeholder: ".github/workflows/my-deepseek.yml",
            dataset: { field: "preset-path" },
            spellcheck: false,
          }),
          "留空使用模板文件名；已有同名文件时请填写新路径。",
        ),
      ),
      el(
        "div",
        { className: "card-actions" },
        button("创建草稿 →", "add-preset", { kind: "primary" }),
      ),
    ),
    state.files.length > 0 &&
      card(
        "继续已有工作流",
        "左侧列出仓库中已加载的工作流。自定义触发器、Job 与其他步骤保留在完整 YAML 中。",
        el(
          "div",
          { className: "inline-row" },
          badge(`${state.files.length} 个文件`),
          button("配置当前步骤 →", "navigate", { data: { section: "configuration" } }),
          button("打开 YAML", "open-yaml", { kind: "text" }),
        ),
      ),
  ];
}

function requireStep(state, content) {
  const file = activeFile(state);
  const step = activeStep(state);
  if (!file)
    return empty(
      "先选择一个工作流",
      "创建模板草稿，或从左侧选择已有文件。",
      button("选择工作流", "navigate", { data: { section: "overview" }, kind: "primary" }),
    );
  if (!step || step.editable === false)
    return empty(
      "这个文件需要通过 YAML 编辑",
      step?.reason || file.reason || "未找到可直接编辑输入的 DeepSeek Harness Action 步骤。",
      button("打开完整 YAML", "open-yaml", { kind: "primary" }),
    );
  return content(file, step, stepInputs(file, step));
}

function fields(state, names, inputs) {
  return names.flatMap((name) => {
    const contract = state.inputs.find((entry) => entry.name === name);
    return contract ? [inputField(name, contract, inputs)] : [];
  });
}

function configuration(state) {
  return requireStep(state, (_file, step, inputs) => [
    card(
      "运行与模型",
      "空值使用固定 DSH 版本的默认配置；也可以直接填写模型标识。",
      el(
        "div",
        { className: "form-grid" },
        fields(state, ["dsh-mode", "model", "reasoning-effort", "isolation"], inputs),
      ),
    ),
    card(
      "身份与访问",
      "密钥引用保存在 Workflow 中，实际 Secret 请在 GitHub 仓库设置中配置。",
      el(
        "div",
        { className: "form-grid" },
        fields(
          state,
          ["deepseek-api-key", "github-token", "permission-profile", "allow-write"],
          inputs,
        ),
      ),
    ),
    card(
      "任务与验证",
      "写入任务需要配置相应验证。具体错误和权限影响会在预览中列出。",
      el(
        "div",
        { className: "form-grid" },
        fields(state, ["command", "task-access", "prompt", "run-tests", "test-commands"], inputs),
      ),
    ),
    card(
      "Action 版本",
      "保留已有引用，或明确升级为此安装器携带的固定提交。",
      el("code", { className: "reference" }, step.uses),
      button(`升级为 ${state.releaseSha?.slice(0, 12) || "安装器固定版本"}`, "upgrade", {
        kind: "secondary",
      }),
    ),
  ]);
}

function plugins(state) {
  return requireStep(state, (_file, _step, inputs) => [
    card(
      "运行模式",
      "切换模式后，请重新扫描并选择插件。扫描只读取本机包信息，不安装软件。",
      el("div", { className: "compact-field" }, fields(state, ["dsh-mode"], inputs)),
      el(
        "div",
        { className: "card-actions" },
        badge(effectiveMode(state), "accent"),
        button("扫描本机插件", "scan-plugins", { kind: "primary" }),
      ),
    ),
    ...state.pluginWarnings.map((warning) =>
      el("div", { className: "callout callout--warning" }, warning),
    ),
    state.pluginScanMode !== null &&
      card(
        "扫描结果",
        "扫描结果不会自动授予权限。勾选后仍需填写工具名称，并应用到当前步骤。",
        state.plugins.length === 0
          ? empty("未发现可用插件", "可以在下方手动添加一个确切版本的 npm 包。")
          : el(
              "div",
              { className: "plugin-list" },
              state.plugins.map((plugin, index) => {
                const selected = state.selections.some(
                  (item) => item.name === plugin.name && item.version === plugin.version,
                );
                return el(
                  "label",
                  { className: "plugin-row" },
                  el("input", {
                    type: "checkbox",
                    checked: selected,
                    disabled: !plugin.compatible || Boolean(plugin.reason),
                    dataset: { field: "plugin-select", index },
                  }),
                  el(
                    "span",
                    { className: "plugin-details" },
                    el("strong", {}, plugin.name),
                    el("code", {}, plugin.version),
                    el("small", {}, plugin.reason || plugin.compatibility || ""),
                  ),
                  badge(
                    plugin.reason ? "需手动配置" : plugin.compatible ? "可选择" : "不兼容",
                    plugin.compatible && !plugin.reason ? "success" : "warning",
                  ),
                );
              }),
            ),
      ),
    card(
      "手动添加",
      "指定包名与完整版本号。插件是否适合当前模式仍由配置校验决定。",
      el(
        "div",
        { className: "form-grid" },
        field(
          "npm 包名",
          el("input", {
            value: state.manualPlugin.name,
            placeholder: "@scope/my-dsh-plugin",
            dataset: { field: "manual-plugin", name: "name" },
          }),
        ),
        field(
          "确切版本",
          el("input", {
            value: state.manualPlugin.version,
            placeholder: "1.2.3",
            dataset: { field: "manual-plugin", name: "version" },
          }),
        ),
        field(
          "标识 ID",
          el("input", {
            value: state.manualPlugin.id,
            placeholder: "my-plugin",
            dataset: { field: "manual-plugin", name: "id" },
          }),
        ),
        field(
          "类型",
          select(["plugin", "bundle"], state.manualPlugin.kind, {
            field: "manual-plugin",
            name: "kind",
          }),
        ),
      ),
      button("添加到待选列表", "add-plugin"),
    ),
    state.selections.length > 0 &&
      card(
        "待应用的插件",
        "只把明确选择的包加入配置。controlled 模式请填写实际工具名称，每行一个。",
        state.selections.map((plugin, index) =>
          el(
            "div",
            { className: "selected-plugin" },
            el(
              "div",
              { className: "inline-row" },
              el("strong", {}, plugin.name),
              badge(plugin.version),
              button("移除", "remove-plugin", { kind: "text", data: { index } }),
            ),
            el(
              "div",
              { className: "form-grid" },
              field(
                "标识 ID",
                el("input", {
                  value: plugin.id,
                  dataset: { field: "selection", index, name: "id" },
                }),
              ),
              field(
                "类型",
                select(["plugin", "bundle"], plugin.kind, {
                  field: "selection",
                  index,
                  name: "kind",
                }),
              ),
            ),
            effectiveMode(state) === "controlled" &&
              field(
                "工具名称",
                el("textarea", {
                  value: plugin.tools.join("\n"),
                  rows: 2,
                  placeholder: "实际注册的工具名称，每行一个",
                  dataset: { field: "selection", index, name: "tools" },
                  spellcheck: false,
                }),
              ),
          ),
        ),
        button("应用已选插件到当前步骤", "apply-plugins", { kind: "primary" }),
      ),
  ]);
}

function advanced(state) {
  const file = activeFile(state);
  if (!file) return requireStep(state, () => []);
  if (typeof file.source !== "string")
    return empty(
      "此文件暂不能在页面内编辑",
      file.reason || "文件内容不可用。请在本地编辑器中处理后重新打开配置工具。",
    );
  const tabs = el(
    "div",
    { className: "tabs", role: "tablist", "aria-label": "高级编辑方式" },
    [
      ["inputs", "全部 Action 输入"],
      ["yaml", "完整 Workflow YAML"],
    ].map(([tab, label]) =>
      button(label, "advanced-tab", {
        kind: state.advancedTab === tab ? "tab-active" : "tab",
        data: { tab },
        role: "tab",
        "aria-selected": String(state.advancedTab === tab),
      }),
    ),
  );
  if (state.advancedTab === "yaml")
    return [
      tabs,
      card(
        "完整 Workflow YAML",
        "触发器、permissions、runs-on、Job 与其他步骤都可在这里编辑。解析失败时草稿仍会保留。",
        file.expectedHash === null &&
          field(
            "新文件路径",
            el("input", { value: file.path, dataset: { field: "file-path" }, spellcheck: false }),
          ),
        el("label", { className: "sr-only", htmlFor: "workflow-source" }, "Workflow YAML 源码"),
        el("textarea", {
          id: "workflow-source",
          className: "yaml-editor",
          value: file.source,
          dataset: { field: "yaml" },
          spellcheck: false,
          autocapitalize: "off",
          autocomplete: "off",
          rows: 28,
        }),
        el(
          "div",
          { className: "card-actions" },
          el("span", { className: "muted" }, "原始内容只在本页内编辑"),
          button("解析并刷新步骤", "inspect"),
        ),
      ),
    ];
  return [
    tabs,
    requireStep(state, (_file, _step, inputs) => {
      const query = state.inputSearch.trim().toLowerCase();
      const contracts = state.inputs.filter(
        (contract) =>
          (state.inputGroup === "all" || contract.docsGroup === state.inputGroup) &&
          (!query || `${contract.name} ${contract.description}`.toLowerCase().includes(query)),
      );
      return card(
        "全部配置项",
        `${state.inputs.length} 个公开 Action 输入。移除显式值后使用 Action 默认行为。`,
        el(
          "div",
          { className: "search-row" },
          el("input", {
            type: "search",
            value: state.inputSearch,
            placeholder: "搜索输入名称或说明…",
            dataset: { field: "input-search" },
            "aria-label": "搜索 Action 输入",
          }),
          select(
            [
              { value: "all", label: "所有分组" },
              ...(state.groups ?? []).map((group) => ({ value: group.id, label: group.title })),
            ],
            state.inputGroup,
            { field: "input-group" },
            { "aria-label": "输入分组" },
          ),
        ),
        el(
          "div",
          { className: "advanced-fields" },
          contracts.map((contract) => inputField(contract.name, contract, inputs)),
        ),
        contracts.length === 0 && empty("没有匹配的输入", "尝试其他关键词或切换分组。"),
      );
    }),
  ];
}

function preview(state) {
  if (state.saved.length > 0)
    return card(
      "工作流已保存到本地",
      "接下来在 GitHub 配置 Secret，并自行提交、推送这些文件。",
      el(
        "div",
        { className: "success-banner" },
        el("span", { "aria-hidden": "true" }, "✓"),
        el("strong", {}, "保存完成"),
      ),
      el(
        "ul",
        { className: "saved-files" },
        state.saved.map((path) => el("li", {}, el("code", {}, path))),
      ),
      el(
        "ol",
        { className: "next-steps" },
        el("li", {}, "在仓库 Settings → Secrets and variables → Actions 添加 DEEPSEEK_API_KEY。"),
        el("li", {}, "检查本地变更，然后手动 commit / push。"),
        el("li", {}, "在 GitHub Actions 查看首次工作流运行与配置诊断。"),
      ),
      button("完成并关闭本地服务", "shutdown", { kind: "primary" }),
    );
  const pending = dirtyFiles(state);
  if (!state.preview)
    return card(
      "生成保存预览",
      "预览会解析最终 YAML 并运行离线配置检查；不会执行工作流，也不会连接模型。",
      badge(`${pending.length} 个待保存文件`, pending.length ? "accent" : "neutral"),
      el(
        "ul",
        { className: "saved-files" },
        pending.map((file) => el("li", {}, el("code", {}, file.path))),
      ),
      button("生成差异与诊断", "preview", { kind: "primary", disabled: pending.length === 0 }),
    );
  const result = state.preview;
  const statusNames = { passed: "通过", failed: "失败", warning: "提示", not_checked: "未检查" };
  return [
    card(
      "配置诊断",
      "通过离线检查不代表 GitHub 运行或模型请求已经验证。",
      el(
        "div",
        { className: "diagnostics" },
        result.diagnostics.map((entry) =>
          el(
            "div",
            { className: "diagnostic" },
            badge(
              statusNames[entry.status] || entry.status,
              entry.status === "passed"
                ? "success"
                : entry.status === "failed"
                  ? "danger"
                  : "warning",
            ),
            el("span", {}, entry.message),
          ),
        ),
      ),
    ),
    card(
      "权限与注意事项",
      "这些项目反映本次配置需要的实际能力。",
      result.risks.length
        ? el(
            "ul",
            { className: "risk-list" },
            result.risks.map((risk) => el("li", {}, risk)),
          )
        : el("p", { className: "muted" }, "检查未报告额外风险提示。"),
    ),
    ...result.changes.map((change) =>
      card(
        change.path,
        "最终写入差异",
        el(
          "pre",
          { className: "diff", tabIndex: 0, "aria-label": `${change.path} 的文件差异` },
          String(change.diff)
            .split("\n")
            .map((line) =>
              el(
                "span",
                {
                  className: line.startsWith("+")
                    ? "diff-add"
                    : line.startsWith("-")
                      ? "diff-remove"
                      : line.startsWith("@@")
                        ? "diff-hunk"
                        : "",
                },
                `${line}\n`,
              ),
            ),
        ),
      ),
    ),
    card(
      "确认保存",
      "只写入上方列出的本地工作流文件。此工具不执行 commit 或 push。",
      el(
        "label",
        { className: "confirmation" },
        el("input", {
          type: "checkbox",
          checked: state.confirmed,
          disabled: !result.ok,
          dataset: { field: "confirm" },
        }),
        el("span", {}, "我已检查差异、诊断和权限，确认保存这些文件。"),
      ),
      !result.ok && el("p", { className: "error-text" }, "请先修复失败的诊断，然后重新生成预览。"),
      el(
        "div",
        { className: "card-actions" },
        button("重新生成预览", "preview"),
        button("确认保存到本地", "save", {
          kind: "primary",
          disabled: !result.ok || !state.confirmed,
        }),
      ),
    ),
  ];
}

export function render(state) {
  const section = sections.find((item) => item.id === state.section);
  const [title, description] = titles[state.section];
  const content = { overview, configuration, plugins, advanced, preview }[state.section](state);
  return el(
    "div",
    { className: "shell" },
    el(
      "aside",
      { className: "sidebar" },
      el(
        "div",
        { className: "brand" },
        el("span", { className: "brand-mark", "aria-hidden": "true" }, "D"),
        el(
          "div",
          {},
          el("strong", {}, "DeepSeek Harness"),
          el("span", {}, "GITHUB WORKFLOW STUDIO"),
        ),
      ),
      el(
        "nav",
        { "aria-label": "配置步骤", className: "section-nav" },
        sections.map((item, index) =>
          el(
            "button",
            {
              type: "button",
              className: `nav-item ${item.id === state.section ? "is-active" : ""}`,
              dataset: { action: "navigate", section: item.id },
              "aria-current": item.id === state.section ? "step" : "false",
            },
            el("span", { className: "nav-number" }, String(index + 1).padStart(2, "0")),
            el("span", {}, el("strong", {}, item.label), el("small", {}, item.hint)),
          ),
        ),
      ),
      filePicker(state),
      el(
        "div",
        { className: "sidebar-footer" },
        el("span", { className: "local-dot" }),
        el("span", {}, "仅在本机运行"),
        el("code", {}, state.releaseSha?.slice(0, 8) || ""),
      ),
    ),
    el(
      "main",
      { className: "main" },
      el(
        "header",
        { className: "topbar" },
        el(
          "div",
          { className: "breadcrumb" },
          "工作流配置",
          el("span", {}, "/"),
          el("strong", {}, section.label),
        ),
        el(
          "div",
          { className: "inline-row" },
          el(
            "span",
            { id: "draft-status", className: "draft-status" },
            `${dirtyFiles(state).length} 个未保存草稿`,
          ),
          button("预览更改", "navigate", { data: { section: "preview" } }),
        ),
      ),
      el(
        "div",
        { className: "content" },
        el(
          "div",
          { className: "page-heading" },
          el(
            "p",
            { className: "eyebrow" },
            `STEP ${String(sections.indexOf(section) + 1).padStart(2, "0")} / LOCAL WORKSPACE`,
          ),
          el("h1", {}, title),
          el("p", {}, description),
        ),
        state.error &&
          el(
            "div",
            { className: "callout callout--error", role: "alert" },
            el("strong", {}, "未完成操作"),
            el("p", {}, state.error),
            button("收起", "dismiss-error", { kind: "text" }),
          ),
        state.notice &&
          el("div", { className: "callout callout--success", role: "status" }, state.notice),
        state.busy &&
          el(
            "div",
            { className: "busy-status", role: "status" },
            el("span", { className: "spinner", "aria-hidden": "true" }),
            state.busy,
          ),
        state.closed
          ? empty("本地服务已关闭", "文件已保存在仓库中，可以关闭这个页面。")
          : el(
              "fieldset",
              { className: "view-content", disabled: Boolean(state.busy) },
              state.section !== "overview" && state.section !== "preview" && stepPicker(state),
              content,
              !["overview", "preview"].includes(state.section) &&
                el(
                  "footer",
                  { className: "page-actions" },
                  el("span", { className: "muted" }, "草稿保留在本页 · 尚未写入磁盘"),
                  button("检查并预览 →", "navigate", {
                    kind: "primary",
                    data: { section: "preview" },
                  }),
                ),
            ),
      ),
    ),
  );
}
