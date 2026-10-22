export const sections = [
  { id: "overview", label: "工作流", hint: "选择起点" },
  { id: "configuration", label: "基础配置", hint: "运行方式与模型" },
  { id: "plugins", label: "插件", hint: "按需添加能力" },
  { id: "advanced", label: "高级设置", hint: "全部输入与 YAML" },
  { id: "preview", label: "预览与保存", hint: "检查每一处变更" },
];

let fileSequence = 0;
export function makeFile(file) {
  return {
    ...file,
    localId: `file-${++fileSequence}`,
    baseSource: file.hash === null ? null : file.source,
    expectedHash: file.hash ?? null,
    steps: file.steps ?? [],
    pending: {},
    needsInspection: false,
    selectedStepId: file.steps?.[0]?.id ?? "",
  };
}

export function createState(data) {
  const files = (data.files ?? []).map(makeFile);
  return {
    ...data,
    files,
    selectedFileId: files[0]?.localId ?? "",
    section: data.initialSection ?? "overview",
    advancedTab: "inputs",
    inputSearch: "",
    inputGroup: "all",
    presetMode: data.initialDshMode ?? "controlled",
    presetKind: "review",
    presetPath: "",
    plugins: [],
    pluginWarnings: [],
    pluginScanMode: null,
    selections: [],
    manualPlugin: { name: "", version: "", id: "", kind: "plugin", tools: "" },
    preview: null,
    confirmed: false,
    busy: "",
    error: "",
    notice: "",
    saved: [],
    closed: false,
  };
}

export function activeFile(state) {
  return state.files.find((file) => file.localId === state.selectedFileId);
}
export function activeStep(state) {
  const file = activeFile(state);
  return file?.steps.find((step) => step.id === file.selectedStepId);
}
export function stepInputs(file, step) {
  return file?.pending[step?.id] ?? step?.inputs ?? {};
}
export function effectiveMode(state) {
  const file = activeFile(state);
  return stepInputs(file, activeStep(state))["dsh-mode"] || "controlled";
}
export function isDirty(file) {
  return file.baseSource !== file.source || Object.keys(file.pending).length > 0;
}
export function dirtyFiles(state) {
  return state.files.filter(isDirty);
}
export function invalidatePreview(state) {
  state.preview = null;
  state.confirmed = false;
  state.saved = [];
}
export function setInput(state, name, value, remove = false) {
  const file = activeFile(state);
  const step = activeStep(state);
  if (!file || !step) return;
  const values = { ...stepInputs(file, step) };
  if (remove) Reflect.deleteProperty(values, name);
  else values[name] = value;
  file.pending[step.id] = values;
  if (name === "dsh-mode") {
    state.plugins = [];
    state.selections = [];
    state.pluginScanMode = null;
  }
  invalidatePreview(state);
}
export function selectedChanges(state) {
  return dirtyFiles(state).map(({ path, source, expectedHash }) => ({
    path,
    source,
    expectedHash,
  }));
}
