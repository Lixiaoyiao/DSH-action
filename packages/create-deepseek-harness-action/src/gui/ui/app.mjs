/* global document, window */
import { request } from "./api.mjs";
import { render } from "./views.mjs";
import {
  acceptInspection,
  applyDraft,
  inspectDraft,
  setSource,
  transitionView,
  activeFile,
  activeStep,
  createState,
  dirtyFiles,
  effectiveMode,
  invalidatePreview,
  makeFile,
  selectedChanges,
  setInput,
  stepInputs,
} from "./state.mjs";

const root = document.getElementById("app");
let state = createState({ inputs: [], groups: [], files: [] });

function draw() {
  root.replaceChildren(render(state));
}
function markDraft() {
  const label = document.getElementById("draft-status");
  if (label) label.textContent = `${dirtyFiles(state).length} 个未保存草稿`;
}
async function work(label, task) {
  if (state.busy || state.closed) return;
  const previousSection = state.section;
  state.busy = label;
  state.error = "";
  state.notice = "";
  draw();
  try {
    await task();
  } catch (error) {
    state.error = error.message || String(error);
  } finally {
    state.busy = "";
    draw();
    if (state.section !== previousSection) window.scrollTo(0, 0);
  }
}
const draftTransport = {
  inspect: (source) => request("inspect", { source }),
  edit: (options) => request("edit", options),
};
const inspect = (file) => inspectDraft(file, draftTransport);
const apply = (file) => applyDraft(file, draftTransport);
async function navigate(section, tab) {
  await transitionView(state, { section, advancedTab: tab ?? state.advancedTab }, draftTransport);
  if (state.pluginScanMode !== null && state.pluginScanMode !== effectiveMode(state))
    resetPluginSelection();
  window.scrollTo(0, 0);
}
function resetPluginSelection() {
  state.plugins = [];
  state.pluginScanMode = null;
  state.selections = [];
  state.pluginWarnings = [];
}

const actions = {
  navigate: async (data) => navigate(data.section),
  "open-yaml": async () => navigate("advanced", "yaml"),
  "advanced-tab": async (data) => navigate("advanced", data.tab),
  "select-file": async (data) => {
    await transitionView(state, { fileId: data.id }, draftTransport);
    resetPluginSelection();
  },
  "dismiss-error": async () => {
    state.error = "";
  },
  "add-preset": async () => {
    const file = await request("preset", { kind: state.presetKind, dshMode: state.presetMode });
    if (state.presetPath.trim()) file.path = state.presetPath.trim();
    if (!/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(file.path))
      throw new Error("请使用 .github/workflows/文件名.yml 路径。");
    if (state.files.some((existing) => existing.path.toLowerCase() === file.path.toLowerCase()))
      throw new Error(
        `${file.path} 已存在于文件列表中。请填写不同的新文件路径，或选择已有文件编辑。`,
      );
    const draft = makeFile(file);
    state.files.push(draft);
    state.selectedFileId = draft.localId;
    state.presetPath = "";
    invalidatePreview(state);
    resetPluginSelection();
    state.section = "configuration";
    state.notice = "工作流草稿已创建，尚未写入磁盘。";
  },
  "remove-input": async (data) => setInput(state, data.name, "", true),
  inspect: async () => {
    const file = activeFile(state);
    file.needsInspection = true;
    await inspect(file);
    state.notice = `YAML 已解析，找到 ${file.steps.length} 个 Action 步骤。`;
  },
  upgrade: async () => {
    const file = activeFile(state);
    await apply(file);
    const step = activeStep(state);
    const result = await request("edit", {
      source: file.source,
      stepId: step.id,
      inputs: step.inputs,
      upgradeAction: true,
    });
    file.source = result.source;
    acceptInspection(file, result);
    invalidatePreview(state);
    state.notice = "已在草稿中升级 Action 固定引用。请在保存前检查差异。";
  },
  "scan-plugins": async () => {
    const mode = effectiveMode(state);
    const result = await request("plugins", { dshMode: mode });
    state.plugins = result.plugins ?? [];
    state.pluginWarnings = result.warnings ?? [];
    state.pluginScanMode = mode;
  },
  "add-plugin": async () => {
    const plugin = state.manualPlugin;
    if (!plugin.name.trim() || !plugin.version.trim() || !plugin.id.trim())
      throw new Error("请填写 npm 包名、确切版本和标识 ID。");
    if (state.selections.some((entry) => entry.name === plugin.name.trim()))
      throw new Error("这个包已经在待选列表中。");
    state.selections.push({
      name: plugin.name.trim(),
      version: plugin.version.trim(),
      id: plugin.id.trim(),
      kind: plugin.kind,
      tools: [],
    });
    state.manualPlugin = { name: "", version: "", id: "", kind: "plugin", tools: "" };
  },
  "remove-plugin": async (data) => {
    state.selections.splice(Number(data.index), 1);
  },
  "apply-plugins": async () => {
    const file = activeFile(state);
    const step = activeStep(state);
    const result = await request("plugin-inputs", {
      source: file.source,
      dshMode: effectiveMode(state),
      inputs: stepInputs(file, step),
      selections: state.selections,
    });
    file.pending[step.id] = result.inputs;
    invalidatePreview(state);
    state.pluginWarnings = result.warnings ?? [];
    state.selections = [];
    state.notice = "已选插件已加入当前步骤草稿；已有配置保留。请检查预览后保存。";
  },
  preview: async () => {
    for (const file of dirtyFiles(state)) await apply(file);
    const result = await request("preview", { changes: selectedChanges(state) });
    state.preview = result;
    state.confirmed = false;
    state.section = "preview";
  },
  save: async () => {
    if (!state.preview?.ok || !state.confirmed) throw new Error("请先检查有效预览并勾选保存确认。");
    const result = await request("save", { previewId: state.preview.id, confirm: true });
    state.saved = result.saved;
    state.notice = (result.warnings ?? []).join("\n");
    state.preview = null;
    state.confirmed = false;
    state.section = "preview";
    const selectedPath = activeFile(state)?.path;
    // Save acknowledgement is retained even if the subsequent reload fails.
    for (const file of state.files)
      if (result.saved.includes(file.path)) {
        file.baseSource = file.source;
        file.pending = {};
      }
    try {
      const fresh = await request("state");
      state.files = fresh.files.map(makeFile);
      state.selectedFileId =
        state.files.find((file) => file.path === selectedPath)?.localId ??
        state.files[0]?.localId ??
        "";
    } catch (error) {
      state.error = `文件已保存，但刷新状态失败：${error.message}。重新加载页面后再继续编辑。`;
    }
  },
  shutdown: async () => {
    await request("shutdown", {});
    state.closed = true;
  },
};

root.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled || state.busy) return;
  const action = actions[button.dataset.action];
  if (!action) return;
  const labels = {
    "scan-plugins": "正在读取本机插件…",
    preview: "正在生成差异和诊断…",
    save: "正在保存工作流…",
  };
  void work(labels[button.dataset.action] || "正在更新草稿…", () => action(button.dataset));
});

function updateField(target) {
  const { field, name, index } = target.dataset;
  const value = target.value;
  if (field === "action-input")
    setInput(state, name, value, target.dataset.defaultOption === "true" && value === "");
  else if (field === "preset-mode") state.presetMode = value;
  else if (field === "preset-kind") state.presetKind = value;
  else if (field === "preset-path") state.presetPath = value;
  else if (field === "manual-plugin") state.manualPlugin[name] = value;
  else if (field === "selection")
    state.selections[Number(index)][name] =
      name === "tools"
        ? value
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
        : value;
  else if (field === "input-search") state.inputSearch = value;
  else if (field === "input-group") state.inputGroup = value;
  else if (field === "step") {
    activeFile(state).selectedStepId = value;
    resetPluginSelection();
  } else if (field === "yaml") {
    setSource(state, value);
  } else if (field === "file-path") {
    activeFile(state).path = value;
    invalidatePreview(state);
  } else if (field === "confirm") state.confirmed = target.checked;
  else if (field === "plugin-select") {
    const plugin = state.plugins[Number(index)];
    if (target.checked && plugin.compatible && !plugin.reason) {
      const id = plugin.name
        .split("/")
        .at(-1)
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 32);
      state.selections.push({
        name: plugin.name,
        version: plugin.version,
        id,
        kind: "bundle",
        tools: [],
      });
    } else
      state.selections = state.selections.filter(
        (item) => !(item.name === plugin.name && item.version === plugin.version),
      );
  }
  markDraft();
}
root.addEventListener("input", (event) => {
  const target = event.target;
  if (
    !target.dataset.field ||
    state.busy ||
    ["SELECT"].includes(target.tagName) ||
    ["checkbox", "radio"].includes(target.type)
  )
    return;
  updateField(target);
  if (target.dataset.field === "input-search") {
    const position = target.selectionStart;
    draw();
    const search = root.querySelector('[data-field="input-search"]');
    search.focus();
    search.setSelectionRange(position, position);
  }
});
root.addEventListener("change", (event) => {
  const target = event.target;
  if (!target.dataset.field || state.busy) return;
  if (target.tagName === "SELECT" || ["checkbox", "radio"].includes(target.type)) {
    updateField(target);
    draw();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirtyFiles(state).length > 0) {
    event.preventDefault();
    event.returnValue = "";
  }
});

try {
  const data = await request("state");
  state = createState(data);
} catch (error) {
  state.error = error.message;
}
draw();
