/** A client-visible failure: HTTP status, error code, and any extra fields for the body. */
export class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const looksLikeId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
