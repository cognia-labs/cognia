import type { BestOfNGroup } from "@/types/best-of-n"
import type { AgentChangeset } from "@/lib/scm/types"
import type { ScmHost } from "@/lib/scm/host"
import { createScmRuntime } from "@/lib/scm/runtime"

/** Generic SCM review owns the exact-head checkout and its cleanup. */
export async function checkBestOfNHead(
  group: BestOfNGroup,
  changeset: AgentChangeset,
  projectId: string | null,
  host: ScmHost,
  signal: AbortSignal
) {
  signal.throwIfAborted()
  const pinnedHost: ScmHost = {
    ...host,
    async getChangeset(id) {
      const current = await host.getChangeset(id)
      if (!current || id !== changeset.changesetId || current.headSha !== changeset.headSha)
        throw new Error("Best-of-N changeset head changed before verification")
      return current
    },
  }
  return createScmRuntime({
    projectId,
    configRoot: group.sourceRoot,
    appSettings: null,
    host: pinnedHost,
  }).review(changeset.changesetId, signal)
}
