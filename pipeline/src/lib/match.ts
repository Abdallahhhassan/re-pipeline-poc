/** True when `actual` contains everything in `expected` (objects compared by the keys expected names). "<any>" matches anything present. */
export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === "<any>") return actual !== undefined;
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => partialMatch(e, actual[i]));
  }
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => partialMatch(v, (actual as any)[k]));
}

/** Replaces volatile fields (ids, timestamps) with a placeholder, at any depth. */
export function mask(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => mask(v, fields));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fields.includes(k) && v != null ? "<masked>" : mask(v, fields)]),
    );
  }
  return value;
}

/** Lists differences as dotted paths: "body.fee: 1 vs \"1.00\"". */
export function diff(a: unknown, b: unknown, at = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const bothObjects = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
  if (!bothObjects) return [`${at || "(root)"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
  return keys.flatMap((k) => diff((a as any)[k], (b as any)[k], at ? `${at}.${k}` : k));
}
