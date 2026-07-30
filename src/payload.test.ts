import { describe, expect, test } from "bun:test";

import { decodeExactUtf8 } from "./payload";

describe("opaque payload decoding", () => {
  test("preserves whitespace, escapes, shell syntax, BOM, and Unicode exactly", () => {
    const text = "\uFEFF  `$HOME` ${USER}\\n\nline  two 👁️  \n";
    expect(decodeExactUtf8(Buffer.from(text, "utf8"), "test payload")).toBe(text);
  });

  test("rejects empty input", () => {
    expect(() => decodeExactUtf8(new Uint8Array(), "test payload"))
      .toThrow("test payload is required on stdin");
  });

  test("rejects invalid UTF-8 rather than replacing bytes", () => {
    expect(() => decodeExactUtf8(Uint8Array.from([0xff]), "test payload"))
      .toThrow("test payload on stdin must be valid UTF-8");
  });
});
