export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Money arrives as a JSON number with at most 2 decimals. */
export function parseAmount(value: unknown, field = "amount"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, "VALIDATION_ERROR", { field });
  }
  if (Math.round(value * 100) !== value * 100) {
    throw new ApiError(400, "VALIDATION_ERROR", { field, reason: "max 2 decimals" });
  }
  return value;
}
