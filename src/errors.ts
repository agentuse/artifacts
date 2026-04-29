export type ErrorCode =
  | "GENERIC"
  | "INVALID_INPUT"
  | "LOCK_TIMEOUT"
  | "CORRUPT_MANIFEST"
  | "IO_ERROR";

const EXIT: Record<ErrorCode, number> = {
  GENERIC: 1,
  INVALID_INPUT: 2,
  LOCK_TIMEOUT: 5,
  CORRUPT_MANIFEST: 6,
  IO_ERROR: 7,
};

export class CliError extends Error {
  code: ErrorCode;
  detail?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function exitCodeFor(code: ErrorCode): number {
  return EXIT[code];
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; detail?: Record<string, unknown> };
}

export function envelope(err: unknown): ErrorEnvelope {
  if (err instanceof CliError) {
    return { error: { code: err.code, message: err.message, detail: err.detail } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "GENERIC", message } };
}
