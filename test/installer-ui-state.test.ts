import { describe, expect, it } from "vitest";
import {
  editWorkflow,
  inspectWorkflow,
} from "../packages/create-deepseek-harness-action/src/gui/workflows.mjs";
import {
  activeFile,
  activeStep,
  applyDraft,
  createState,
  dirtyFiles,
  selectedChanges,
  setInput,
  setSource,
  stepInputs,
  transitionView,
  type DraftState,
  type DraftTransport,
} from "../packages/create-deepseek-harness-action/src/gui/ui/state.mjs";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const transport: DraftTransport = {
  inspect: (source) => Promise.resolve(inspectWorkflow(source)),
  edit: (options) => Promise.resolve(editWorkflow(options, releaseSha)),
};
const original = `name: Custom workflow
on: workflow_dispatch
jobs:
  task:
    runs-on: ubuntu-latest
    steps:
      - uses: Lixiaoyiao/deepseek-harness-action@${releaseSha}
        with:
          model: original-model
          prompt: Original prompt
`;
function fixture() {
  const state = createState({
    files: ["a", "b"].map((name) => ({
      path: `.github/workflows/${name}.yml`,
      source: original,
      hash: `initial-${name}`,
      ...inspectWorkflow(original),
    })),
  });
  const [a, b] = state.files;
  if (!a || !b) throw new Error("Expected two fixture workflows");
  return { state, a, b };
}
function source(state: DraftState): string {
  const value = activeFile(state)?.source;
  if (value === undefined) throw new Error("Expected a source draft");
  return value;
}
function inputValues(state: DraftState) {
  return stepInputs(activeFile(state), activeStep(state));
}
async function previewChanges(state: DraftState) {
  for (const file of dirtyFiles(state)) await applyDraft(file, transport);
  return selectedChanges(state);
}

describe("GUI draft transitions through actual workflow editing", () => {
  it("applies form edits before returning to that file in the YAML editor, preserving the later YAML edit", async () => {
    const { state, a, b } = fixture();
    await transitionView(state, { section: "configuration" }, transport);
    setInput(state, "model", "form-model");
    await transitionView(state, { fileId: b.localId }, transport);
    await transitionView(state, { section: "advanced", advancedTab: "yaml" }, transport);
    await transitionView(state, { fileId: a.localId }, transport);
    expect(source(state)).toContain("model: form-model");
    setSource(state, source(state).replace("model: form-model", "model: yaml-model"));
    const changes = await previewChanges(state);
    expect(changes[0]?.source).toContain("model: yaml-model");
    expect(changes[0]?.source).not.toContain("model: form-model");
    expect(a.pending).toEqual({});
    expect(b.source).toBe(original);
  });

  it.each(["configuration", "plugins", "advanced"] as const)(
    "refreshes raw YAML before returning through another file to %s",
    async (section) => {
      const { state, a, b } = fixture();
      await transitionView(state, { section: "advanced", advancedTab: "yaml" }, transport);
      setSource(state, source(state).replace("model: original-model", "model: yaml-model"));
      await transitionView(state, { fileId: b.localId }, transport);
      await transitionView(state, { section, advancedTab: "inputs" }, transport);
      await transitionView(state, { fileId: a.localId }, transport);
      expect(inputValues(state).model).toBe("yaml-model");
      setInput(state, "prompt", "New prompt from the form");
      const changes = await previewChanges(state);
      expect(changes[0]?.source).toContain("model: yaml-model");
      expect(changes[0]?.source).toContain("prompt: New prompt from the form");
      expect(b.source).toBe(original);
    },
  );

  it("keeps invalid YAML available for repair instead of displaying stale form inputs", async () => {
    const { state, a, b } = fixture();
    await transitionView(state, { section: "advanced", advancedTab: "yaml" }, transport);
    const invalid = `${original}broken: [\n`;
    setSource(state, invalid);
    await transitionView(state, { fileId: b.localId }, transport);
    await transitionView(state, { section: "configuration" }, transport);
    await expect(transitionView(state, { fileId: a.localId }, transport)).rejects.toThrow(
      "invalid",
    );
    expect(state.selectedFileId).toBe(a.localId);
    expect(state.section).toBe("advanced");
    expect(state.advancedTab).toBe("yaml");
    expect(source(state)).toBe(invalid);
    setSource(state, original.replace("original-model", "repaired-model"));
    await transitionView(state, { section: "configuration" }, transport);
    expect(inputValues(state).model).toBe("repaired-model");
  });
});
