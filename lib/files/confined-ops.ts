/**
 * Confined write/mkdir backend.
 *
 * Thin wrapper over the authoritative Rust `*_confined` commands (see
 * `crates/cognia-files/src/files.rs`). Kept as its own
 * module so callers stay runtime-agnostic and tests can inject a fake backend
 * without a Tauri host. Web mode (no Rust) rejects — there is no safe confined
 * write target in the browser, and its consumers run inside the desktop shell.
 */

import { isTauri, transport } from "@/lib/tauri"

/** The on-disk-confined mutations a caller delegates to. */
export interface ConfinedOps {
  writeText(path: string, content: string, allowedRoots: string[]): Promise<void>
  mkdir(path: string, allowedRoots: string[]): Promise<void>
}

/** Default backend — calls the Rust host; throws in web mode. */
export const confinedOps: ConfinedOps = {
  async writeText(path, content, allowedRoots) {
    if (!isTauri()) {
      throw new Error("Confined file writes are only available in the desktop app.")
    }
    await writeTextFileConfined(path, content, allowedRoots)
  },
  async mkdir(path, allowedRoots) {
    if (!isTauri()) {
      throw new Error("Confined directory creation is only available in the desktop app.")
    }
    await ensureDirConfined(path, allowedRoots)
  },
}

/**
 * Write a text file confined to `allowedRoots` (the active workspace roots).
 * The authoritative on-disk counterpart to the unconfined `writeTextFile`
 * (`lib/file/host-file-commands.ts`): the Rust host
 * canonicalizes and rejects writes that escape the roots — including via a
 * symlink the lexical TS pre-flight can't see. Prefer this for in-app writes.
 */
export async function writeTextFileConfined(
  path: string,
  content: string,
  allowedRoots: string[]
): Promise<void> {
  await transport.call("write_text_file_confined", { path, content, allowedRoots })
}

/** Ensure a directory exists, confined to `allowedRoots` (see {@link writeTextFileConfined}). */
export async function ensureDirConfined(path: string, allowedRoots: string[]): Promise<void> {
  await transport.call("ensure_dir_confined", { path, allowedRoots })
}
