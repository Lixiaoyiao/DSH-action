import { z } from "zod";

export const operationSchema = z.enum(["task", "review", "diagnose", "fix", "implement"]);
export type Operation = z.infer<typeof operationSchema>;
export type RequestedAccess = "read" | "write";

export interface ParsedCommand {
  readonly operation: Operation;
  readonly instructions: string;
  readonly requestedAccess: RequestedAccess;
}

interface ParseOptions {
  readonly naturalLanguageWrite?: boolean;
  readonly allowNaturalLanguage?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Mask examples only for routing; the original comment remains task context. */
function visibleLines(lines: readonly string[]): string[] {
  const closingTicks = new Map<number, Set<number>>();
  const laterTickLengths = new Set<number>();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") laterTickLengths.clear();
    const positions = new Set<number>();
    for (const match of [...line.matchAll(/`+/gu)].reverse()) {
      if (laterTickLengths.has(match[0].length)) positions.add(match.index);
      laterTickLengths.add(match[0].length);
    }
    closingTicks.set(index, positions);
  }
  let fence: string | undefined;
  let htmlEnd: string | undefined;
  let inlineTicks = "";
  let nestedParagraph = false;
  return lines.map((line, lineIndex) => {
    const lowerLine = line.toLowerCase();
    if (fence !== undefined) {
      if (new RegExp(`^ {0,3}${fence.charAt(0)}{${String(fence.length)},}\\s*$`, "u").test(line)) {
        fence = undefined;
      }
      return "";
    }
    if (line.trim() === "") {
      nestedParagraph = false;
      inlineTicks = "";
      return "";
    }
    if (htmlEnd === undefined && inlineTicks === "") {
      if (nestedParagraph || /^ {0,3}(?:>|(?:[-+*]|\d+[.)])(?:[\t ]+|$))/u.test(line)) {
        nestedParagraph = true;
        return "";
      }
      if (/^(?: {4}|\t)/u.test(line)) return "";
      const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (openingFence && !(openingFence[1]?.startsWith("`") && openingFence[2]?.includes("`"))) {
        fence = openingFence[1];
        return "";
      }
    }
    let visible = "";
    for (let cursor = 0; cursor < line.length;) {
      if (htmlEnd !== undefined) {
        const end = lowerLine.indexOf(htmlEnd, cursor);
        if (end === -1) return visible;
        visible += " ".repeat(end + htmlEnd.length - cursor);
        cursor = end + htmlEnd.length;
        htmlEnd = undefined;
        continue;
      }
      const rest = line.slice(cursor);
      const ticks = /^`+/u.exec(rest)?.[0];
      if (inlineTicks !== "") {
        if (ticks === inlineTicks) inlineTicks = "";
        const length = ticks?.length ?? 1;
        visible += " ".repeat(length);
        cursor += length;
        continue;
      }
      const html = /^(<!--|<(pre|code|blockquote)(?:\s[^>]*|)>)/iu.exec(rest);
      if (html) {
        htmlEnd = html[1] === "<!--" ? "-->" : `</${html[2]?.toLowerCase() ?? ""}>`;
        visible += " ".repeat(html[0].length);
        cursor += html[0].length;
        continue;
      }
      if (ticks !== undefined) {
        let slashes = 0;
        while (line[cursor - slashes - 1] === "\\") slashes += 1;
        const escaped = slashes % 2 !== 0;
        if (!escaped && closingTicks.get(lineIndex)?.has(cursor)) {
          inlineTicks = ticks;
          visible += " ".repeat(ticks.length);
          cursor += ticks.length;
          continue;
        }
      }
      visible += line[cursor] ?? "";
      cursor += 1;
    }
    return visible;
  });
}

/** A workflow opt-in admits direct requests, never intent quoted as context. */
function naturalAccess(request: string, following: readonly string[]): RequestedAccess {
  const unquote = (text: string): string =>
    text
      .replace(
        /"[^"\n]*"|(?<![\p{L}\p{N}_])'(?:[^'\n]|(?<=[\p{L}\p{N}_])'(?=[\p{L}\p{N}_]))*'(?![\p{L}\p{N}_])|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/gu,
        " ",
      )
      .trim();
  const text = unquote(request);
  const constraints = [text, ...following.map(unquote)].join("\n");
  if (
    /\b(?:without|(?:do\s+not|don't|never))\s+(?:actually\s+)?(?:changing|modifying|editing|writing|change|modify|edit|write)\s+(?:(?:any|the)\s+)?(?:files|code)\b|\b(?:only|just)\s+(?:analy[sz]e|explain|discuss|review|describe)\b/iu.test(
      constraints,
    ) ||
    /(?:不要|不用|无需|不必|禁止|别)(?:实际)?(?:修改|改动|更改|编辑|写入)(?:任何)?(?:代码|文件)|只(?:需|要)?(?:分析|解释|讨论|审查|给出|提供方案)/u.test(
      constraints,
    ) ||
    /(?:方案|方法|思路|步骤|过程|能力|机制)(?:是|有|为|如何|怎么|什么|能否)|(?:是|有)什么(?:方案|方法)|(?:如何|怎么)修复/u.test(
      text,
    )
  )
    return "read";
  const english = text.replace(
    /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?)/iu,
    "",
  );
  if (
    /^(?:fix|repair|implement|update|change|edit|add|remove|delete|refactor|replace|rename)\b\s+\S/iu.test(
      english,
    ) ||
    /^(?:commit|push)\b(?:\s|$)/iu.test(english) ||
    /^(?:create|open|submit|raise)\s+(?:(?:a|the)\s+)?(?:pr|pull\s+request)\b/iu.test(english)
  )
    return "write";
  const chinese = text.replace(
    /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|(?:能不能|能否|能|可不可以|可以)(?:请)?(?:你)?(?:帮我)?|帮我)\s*/u,
    "",
  );
  return /^(?:(?:修复|实现|修改|更新|添加|新增|删除|移除|重构|调整|替换|更改)\s*\S|(?:将|把).+(?:改为|改成|修改为|设为|设置为)\s*\S|(?:提交|推送)(?:代码|更改|修改|变更)|(?:提交|创建|发起)\s*(?:一个\s*)?(?:PR\b|pull\s+request\b|拉取请求))/iu.test(
    chinese,
  )
    ? "write"
    : "read";
}

/** Parse one direct request from the triggering comment, never repository text. */
export function parseCommand(
  content: string,
  triggerPhrase = "@dsh",
  options: ParseOptions = {},
): ParsedCommand | null {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const mention = new RegExp(`^ {0,3}${escapeRegExp(triggerPhrase)}(?:[\\t ]+(.*)|[\\t ]*)$`, "iu");
  const visible = visibleLines(lines);
  const candidates = visible.flatMap((line, index) => {
    const visible = mention.exec(line);
    const original = mention.exec(lines[index] ?? "");
    return visible && original
      ? [{ index, request: original[1]?.trim() ?? "", visible: visible[1]?.trim() ?? "" }]
      : [];
  });
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (candidate === undefined || candidate.request === "") return null;
  const legacy = /^(task|review|diagnose|fix|implement)(?:\s+(.*))?$/iu.exec(candidate.request);
  if (
    legacy === null &&
    (options.allowNaturalLanguage === false || candidate.request.startsWith("--"))
  )
    return null;
  const operation = legacy === null ? "task" : operationSchema.parse(legacy[1]?.toLowerCase());
  let firstInstructions = legacy === null ? candidate.request : (legacy[2]?.trim() ?? "");
  let requestedAccess: RequestedAccess =
    legacy === null
      ? options.naturalLanguageWrite === true
        ? naturalAccess(candidate.visible, visible.slice(candidate.index + 1))
        : "read"
      : operation === "fix" || operation === "implement"
        ? "write"
        : "read";
  if (legacy !== null && operation === "task") {
    const access = /^--(read|write)(?:\s+|$)/iu.exec(firstInstructions);
    if (access !== null) {
      requestedAccess = access[1]?.toLowerCase() === "write" ? "write" : "read";
      firstInstructions = firstInstructions.slice(access[0].length).trim();
    } else if (firstInstructions.startsWith("--")) return null;
  }
  const instructions = lines
    .map((line, index) => (index === candidate.index ? firstInstructions : line))
    .join("\n")
    .trim();
  if (operation === "task" && instructions === "") return null;
  return { operation, instructions, requestedAccess };
}
