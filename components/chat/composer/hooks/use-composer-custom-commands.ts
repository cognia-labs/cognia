"use client"

import { resolveMemoryFilesAccess } from "@/lib/chat/memory-target"
import { type SlashCommand } from "@/lib/slash-commands/builtin"
import { loadCustomSlashCommands } from "@/lib/slash-commands/custom"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { type ChatSession } from "@cognia/agent-config-types"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"

/** Stable empty list, so a pending custom-command scan does not re-derive the picker. */
const NO_CUSTOM_COMMANDS: SlashCommand[] = []

export interface ComposerCustomCommandsInput {
  isDesktop: boolean
  cwd: string | null
  props: {
    session?: ChatSession | null
  }
}

/**
 * The `/` commands this conversation's workspace defines, read from the Host
 * it is bound to (or the one the desktop drives), and whether `#` file memory
 * can reach that Host's instruction files.
 */
export function useComposerCustomCommands(input: ComposerCustomCommandsInput) {
  const { isDesktop, cwd, props } = input

  // --- Per-cwd custom slash commands ------------------------------------
  // A conversation bound to a Host reads that Host's commands, whichever one
  // the desktop drives now. An unbound one follows the active route, so it is
  // re-read when the desktop switches Hosts, not only when the path changes:
  // two Hosts can share a path and hold different commands.
  // Keyed by the scan they answer (workspace + Host), so a list never outlives
  // the workspace it was read from: until the next scan lands the picker shows
  // no custom commands rather than the previous project's.
  const [customCommandScan, setCustomCommandScan] = useState<{
    key: unknown
    list: SlashCommand[]
  } | null>(null)
  const activeRemoteHost = useSyncExternalStore(
    subscribeActiveRemoteTransport,
    getActiveRemoteTransport,
    () => null
  )
  const hostBinding = props.session?.hostBinding
  const boundOrigin = hostBinding?.origin
  const boundHostId = boundOrigin?.kind === "remote" ? boundOrigin.hostId : null
  const boundAccountId = boundOrigin?.kind === "remote" ? boundOrigin.accountId : undefined
  const boundRoot = hostBinding?.workspaceRoot
  const hasBinding = boundOrigin !== undefined
  const customCommandKey = useMemo(
    () => ({
      cwd,
      host: hasBinding ? null : activeRemoteHost,
      binding: !hasBinding
        ? null
        : {
            origin: boundHostId
              ? {
                  kind: "remote" as const,
                  hostId: boundHostId,
                  ...(boundAccountId ? { accountId: boundAccountId } : {}),
                }
              : { kind: "local" as const },
            ...(boundRoot ? { workspaceRoot: boundRoot } : {}),
          },
    }),
    [cwd, activeRemoteHost, hasBinding, boundHostId, boundAccountId, boundRoot]
  )
  // `#` file memory writes the instruction files this conversation's turns
  // load, which this window reaches only when those turns run here.
  const memoryFilesAccess = resolveMemoryFilesAccess({
    isDesktop,
    boundOrigin: customCommandKey.binding?.origin,
    drivingRemoteHost: activeRemoteHost !== null,
  })
  useEffect(() => {
    let cancelled = false
    void loadCustomSlashCommands(customCommandKey.cwd, customCommandKey.binding).then((list) => {
      if (!cancelled) setCustomCommandScan({ key: customCommandKey, list })
    })
    return () => {
      cancelled = true
    }
  }, [customCommandKey])
  const customCommands = useMemo(
    () =>
      customCommandScan?.key === customCommandKey ? customCommandScan.list : NO_CUSTOM_COMMANDS,
    [customCommandScan, customCommandKey]
  )
  return { customCommands, memoryFilesAccess }
}
