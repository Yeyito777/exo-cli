import { readFile } from "node:fs/promises";

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export function decodeExactUtf8(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength === 0) {
    throw new Error(`${label} is required on stdin`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} on stdin must be valid UTF-8`);
  }
}

export async function readExactStdin(label: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return decodeExactUtf8(Buffer.concat(chunks), label);
}

export async function readExactUtf8File(path: string, label: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${label} file '${path}': ${detail}`);
  }
  if (bytes.byteLength === 0) {
    throw new Error(`${label} file '${path}' is empty`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} file '${path}' must contain valid UTF-8`);
  }
}
