/** Host file authority and parser bindings for the package-owned Pi snapshot. */
import { contentDigest } from "@cognia/agent"
import { parseFrontmatter } from "@/lib/claude/subagent-importers/_parse-helpers"
import { parsePiSource } from "@/lib/pi-packages/identity"
import { extractPiPackages } from "@/lib/pi-packages/settings-io"
import {
  resolvePiSubagents as resolveSnapshot,
  type PiConfig,
  type PiSubagentReadDeps,
} from "@cognia/agent-pi/subagent-snapshot"
export {
  piSubagentSupport,
  piSubagentModelBindings,
  piModelBinding,
} from "@cognia/agent-pi/subagent-snapshot"
export type { PiSubagentSnapshot, PiSubagentReadDeps } from "@cognia/agent-pi/subagent-snapshot"

function missing(error: unknown): boolean {
  return /ENOENT|not found|does not exist|no such file/i.test(String(error))
}
async function hostDeps(): Promise<PiSubagentReadDeps> {
  const { agentInvoke, agentReadTextFile, agentListFiles } = await import("../agent-transport")
  return {
    agentDir: async () =>
      (await agentInvoke<{ piAgentDir?: string }>("agent_vendor_roots", {})).piAgentDir ?? null,
    read: async (path) => {
      try {
        return await agentReadTextFile(path, [path.slice(0, path.lastIndexOf("/"))])
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
    directoryExists: async (path) => {
      try {
        await agentInvoke("fs_list_workspace_dir", {
          root: path,
          relPath: "",
          includeIgnored: true,
        })
        return true
      } catch (error) {
        if (missing(error)) return false
        throw error
      }
    },
    list: async (path, recursive) => {
      try {
        if (!recursive) return await agentListFiles(path, [path])
        const files: string[] = []
        let directories = 0
        const visit = async (directory: string, depth: number): Promise<void> => {
          if (depth > 8 || ++directories > 128) throw new Error("Pi agent directory limit exceeded")
          const entries = await agentInvoke<Array<{ absolute_path: string; is_dir: boolean }>>(
            "fs_list_workspace_dir",
            {
              root: path,
              relPath: directory.slice(path.length).replace(/^\//, ""),
              includeIgnored: true,
            }
          )
          for (const entry of entries) {
            if (!entry.absolute_path.startsWith(`${path}/`))
              throw new Error("Invalid Pi agent directory entry")
            if (entry.is_dir) await visit(entry.absolute_path, depth + 1)
            else files.push(entry.absolute_path)
          }
        }
        await visit(path, 0)
        return files
      } catch (error) {
        if (missing(error)) return []
        throw error
      }
    },
  }
}

export async function resolvePiSubagents<T extends PiConfig>(
  config: T,
  deps?: PiSubagentReadDeps
): Promise<T> {
  return resolveSnapshot(config, {
    ...(deps ?? (await hostDeps())),
    digest: contentDigest,
    parseFrontmatter,
    parseSource: parsePiSource,
    packages: (settings) => extractPiPackages(settings).packages,
  })
}
