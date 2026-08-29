// Minimal structured logger. One JSON line per event to stdout — enough to
// satisfy this phase's DoD ("Server logs connect/disconnect with document
// and session ids") without pulling in a logging framework this early.
// Not engine code, so none of packages/engine's purity restrictions apply
// here — a wall-clock timestamp on a log line is exactly what it's for.

export type LogFields = Readonly<Record<string, unknown>>;

function emit(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }));
}

export const logger = {
  info: (message: string, fields?: LogFields): void => emit("info", message, fields),
  warn: (message: string, fields?: LogFields): void => emit("warn", message, fields),
  error: (message: string, fields?: LogFields): void => emit("error", message, fields),
};
