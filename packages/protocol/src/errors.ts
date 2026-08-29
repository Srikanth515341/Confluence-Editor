/**
 * A decode failure with a stable machine-readable `reason` code, distinct
 * from a crash (TypeError/RangeError from indexing past a buffer, etc.).
 * Every decode path in this package throws this class specifically so a
 * caller — the future Phase 8 socket gateway included — can tell "the
 * peer sent garbage" apart from "our own code has a bug" (API Spec §3.2).
 */
export class ProtocolDecodeError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
    this.reason = reason;
  }
}
