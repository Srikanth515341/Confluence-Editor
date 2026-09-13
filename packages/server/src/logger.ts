// Structured logger. One JSON line per event to stdout. Not engine code, so none of
// packages/engine's purity restrictions apply here — a wall-clock timestamp on a log line is
// exactly what it's for.
//
// Phase 37 (RFC §5 C-14, API Spec §5.1: "requestId appears in every server log line for that
// request") — `.child(fields)` returns a bound logger that merges `fields` into every
// subsequent call, so a caller doesn't have to manually repeat `sessionId`/`documentId` at
// every single `logger.info(...)` call site (error-prone — several pre-Phase-37 call sites in
// gateway.ts already had gaps, e.g. `ws.open` logging `sessionId` but not `documentId`, simply
// because `documentId` isn't known yet at that point in the connection lifecycle). A child
// logger is layered (`child({a}).child({b})` merges both), so `documentId` can be added once
// it becomes known (at HELLO) without re-threading `sessionId` again.

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a new logger that merges `fields` into every call it makes (including further `.child()` calls on the result). */
  child(fields: LogFields): Logger;
}

function emit(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }));
}

function makeLogger(baseFields: LogFields): Logger {
  return {
    info: (message, fields) => emit("info", message, { ...baseFields, ...fields }),
    warn: (message, fields) => emit("warn", message, { ...baseFields, ...fields }),
    error: (message, fields) => emit("error", message, { ...baseFields, ...fields }),
    child: (fields) => makeLogger({ ...baseFields, ...fields }),
  };
}

export const logger: Logger = makeLogger({});
