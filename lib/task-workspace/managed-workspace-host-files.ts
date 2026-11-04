import type { ManagedWorkspaceDeps } from "./managed-workspace"
import { callTaskWorkspaceOrigin, captureTaskWorkspaceOrigin } from "./origin"
import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"
import { isHeadlessHost } from "@/lib/platform/detect"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import type { RawWorkspaceEntry, RawWorkspaceStat, WorkspaceRoot } from "@/lib/files/types"

type HostFiles = Pick<
  ManagedWorkspaceDeps,
  | "managedBaseRoot"
  | "exists"
  | "mkdir"
  | "remove"
  | "rename"
  | "readDir"
  | "readFile"
  | "writeFile"
  | "registerAllowedRoot"
>

/** A paired client materializes files only under the Host's advertised writable root. */
export async function createHostManagedWorkspaceFiles(): Promise<HostFiles> {
  const origin = captureTaskWorkspaceOrigin()
  if (origin.kind === "local" && !isHeadlessHost()) {
    throw new Error("Managed workspace requires a connected Host")
  }
  const scope = getRuntimeTargetScopeKey()
  const assertCurrent = () => {
    if (scope !== getRuntimeTargetScopeKey()) throw new Error("Workspace Host connection changed")
  }
  const call = async <T>(command: string, args: Record<string, unknown>, mutation = false) => {
    assertCurrent()
    const result = await callTaskWorkspaceOrigin<T>(origin, command, args, mutation)
    assertCurrent()
    return result
  }
  const report = await call<{ roots: WorkspaceRoot[] }>("fs_workspace_roots", {})
  const roots = report.roots.filter((root) => root.source === "headless-workspaces-dir")
  if (roots.length !== 1) throw new Error("Host did not advertise one managed workspace root")
  const root = roots[0].path.replace(/\/+$/, "")
  if (!root.startsWith("/") || root.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Host advertised an invalid managed workspace root")
  }
  const base = `${root}/managed-workspaces`
  const relative = (path: string) => {
    assertCurrent()
    if (
      !(path === base || path.startsWith(`${base}/`)) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("Managed workspace path is outside its Host root")
    }
    return path.slice(root.length + 1)
  }
  return {
    managedBaseRoot: async () => {
      assertCurrent()
      return base
    },
    exists: async (path) =>
      (await call<RawWorkspaceStat>("fs_stat_workspace_file", { root, relPath: relative(path) }))
        .exists,
    mkdir: (path) => call("fs_create_workspace_dir", { root, relPath: relative(path) }, true),
    remove: (path) =>
      call("fs_delete_workspace_entry", { root, relPath: relative(path), recursive: true }, true),
    rename: (from, to) =>
      call(
        "fs_rename_workspace_entry",
        { root, fromRelPath: relative(from), toRelPath: relative(to) },
        true
      ),
    readDir: async (path) => {
      const entries = await call<RawWorkspaceEntry[]>("fs_list_workspace_dir", {
        root,
        relPath: relative(path),
        includeIgnored: true,
      })
      return Promise.all(
        entries.map(async (entry) => {
          const relPath = relative(entry.absolute_path)
          const stat = await call<RawWorkspaceStat>("fs_stat_workspace_file", { root, relPath })
          return {
            name: entry.absolute_path.slice(entry.absolute_path.lastIndexOf("/") + 1),
            isDirectory: stat.is_dir,
            isFile: stat.exists && !stat.is_dir && !stat.is_symlink,
            isSymlink: stat.is_symlink === true,
          }
        })
      )
    },
    readFile: async (path) =>
      decodeBase64(
        await call<string>("fs_read_workspace_file_base64", { root, relPath: relative(path) })
      ),
    writeFile: (path, bytes) =>
      call(
        "fs_write_workspace_file",
        { root, relPath: relative(path), content: encodeBase64(bytes), encoding: "base64" },
        true
      ),
    // Already confined to the root the Host advertised. Clients cannot register wider roots.
    registerAllowedRoot: async (path) => {
      relative(path)
    },
  }
}
