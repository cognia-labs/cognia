/**
 * Unconfined Host file commands used by Skills and MCP import/export: read
 * and write a text file, create a directory and resolve the default export
 * directory. In-app writes into a workspace use the confined commands in
 * `lib/files/confined-ops.ts` instead.
 */
import { transport } from "@/lib/tauri"

export async function readTextFile(path: string): Promise<string> {
  return transport.call<string>("read_text_file", { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await transport.call("write_text_file", { path, content })
}

export async function ensureDir(path: string): Promise<void> {
  await transport.call("ensure_dir", { path })
}

export async function defaultExportDir(): Promise<string> {
  return transport.call<string>("default_export_dir")
}
