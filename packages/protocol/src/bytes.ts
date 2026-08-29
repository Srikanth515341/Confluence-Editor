import { ProtocolDecodeError } from "./errors.js";

/**
 * Minimal growable byte sink. Every encoder in this package writes through
 * one of these rather than concatenating intermediate Uint8Arrays, so a
 * multi-field message (API Spec §3.5) costs one final copy, not one per
 * field.
 */
export class ByteWriter {
  private bytes: number[] = [];

  writeByte(b: number): void {
    this.bytes.push(b & 0xff);
  }

  writeBytes(chunk: Uint8Array): void {
    for (const b of chunk) {
      this.bytes.push(b);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Cursor over a decoded frame. Every read is bounds-checked and throws a
 * {@link ProtocolDecodeError} (reason `TRUNCATED_FRAME`) rather than letting
 * a truncated/malformed peer frame crash the reader with an out-of-bounds
 * access — API Spec §3.2's framing must degrade to a rejected frame, never
 * a process crash.
 */
export class ByteReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new ProtocolDecodeError("TRUNCATED_FRAME", "unexpected end of frame reading one byte");
    }
    return this.bytes[this.offset++]!;
  }

  readBytes(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) {
      throw new ProtocolDecodeError(
        "TRUNCATED_FRAME",
        `unexpected end of frame reading ${n} bytes (${this.remaining} remaining)`,
      );
    }
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  /** True iff every remaining byte has been consumed. Used to reject trailing garbage after a payload. */
  atEnd(): boolean {
    return this.offset === this.bytes.length;
  }
}
