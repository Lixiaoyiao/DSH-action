/** Stable JSON for unknown feedback and extension configuration values. */
export function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (Array.isArray(candidate)) return candidate.map((item) => normalize(item));
    if (typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}
