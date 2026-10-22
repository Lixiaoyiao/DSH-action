/* global document */
export function el(tag, properties = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("aria-") || key === "role") node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

export function button(label, action, { kind = "secondary", data = {}, ...props } = {}) {
  return el(
    "button",
    {
      type: "button",
      className: `button button--${kind}`,
      dataset: { action, ...data },
      ...props,
    },
    label,
  );
}
export function badge(text, tone = "neutral") {
  return el("span", { className: `badge badge--${tone}` }, text);
}
export function card(title, description, ...content) {
  return el(
    "section",
    { className: "card" },
    el(
      "div",
      { className: "card-heading" },
      el("h2", {}, title),
      description && el("p", {}, description),
    ),
    ...content,
  );
}
export function field(label, control, hint) {
  return el(
    "label",
    { className: "field" },
    el("span", { className: "field-label" }, label),
    control,
    hint && el("span", { className: "field-hint" }, hint),
  );
}
export function select(options, value, data, properties = {}) {
  const control = el(
    "select",
    { dataset: data, ...properties },
    options.map((option) => {
      const item = typeof option === "string" ? { value: option, label: option } : option;
      return el("option", { value: item.value }, item.label);
    }),
  );
  control.value = value ?? "";
  return control;
}
export function inputField(name, contract, inputs, disabled = false) {
  const present = Object.hasOwn(inputs, name);
  const value = present ? String(inputs[name] ?? "") : "";
  const defaultValue = contract.default ?? contract.defaultValue ?? "";
  const options =
    {
      "dsh-mode": ["controlled", "native"],
      "reasoning-effort": ["off", "low", "high", "max"],
      isolation: ["docker", "none"],
      "permission-profile": ["strict", "standard", "custom"],
      "session-mode": ["off", "auto", "resume", "save"],
      "task-access": ["read", "write"],
      "validation-integrity": ["strict", "warn", "off"],
    }[name] ?? (["true", "false"].includes(String(defaultValue)) ? ["true", "false"] : undefined);
  const data = { field: "action-input", name };
  const supportsSelection = options && (!present || options.includes(value));
  const multiline =
    /config|commands|actors|bots|tools|comments-by-actor|context-files|^prompt$|output-schema/.test(
      name,
    );
  let control;
  if (supportsSelection) {
    control = select(
      [
        {
          value: "",
          label: `默认${defaultValue === "" ? "（由 Action 决定）" : `：${defaultValue}`}`,
        },
        ...options,
      ],
      value,
      data,
      { disabled },
    );
    control.dataset.defaultOption = "true";
  } else {
    control = el(multiline ? "textarea" : "input", {
      value,
      disabled,
      rows: multiline ? 3 : undefined,
      placeholder: String(defaultValue || "未设置"),
      dataset: data,
      spellcheck: false,
      className: multiline ? "code-input" : "",
    });
  }
  if (name === "model") control.setAttribute("list", "model-suggestions");
  return el(
    "div",
    { className: "input-field" },
    el(
      "div",
      { className: "input-heading" },
      el("label", { htmlFor: `input-${name}` }, name),
      contract.required && badge("必填"),
      present && button("移除显式值", "remove-input", { kind: "text", data: { name }, disabled }),
    ),
    Object.assign(control, { id: `input-${name}` }),
    name === "model" &&
      el(
        "datalist",
        { id: "model-suggestions" },
        el("option", { value: "deepseek-flash" }, "V4.1 Flash · DSH 默认"),
        el("option", { value: "deepseek-v4-pro" }, "V4 Pro"),
      ),
    contract.description && el("p", { className: "field-hint" }, contract.description),
  );
}
export function empty(title, description, action) {
  return el(
    "div",
    { className: "empty-state" },
    el("span", { className: "empty-mark", "aria-hidden": "true" }, "◇"),
    el("h3", {}, title),
    el("p", {}, description),
    action,
  );
}
