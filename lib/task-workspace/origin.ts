import { isHeadlessHost, isTauri } from "@/lib/platform/detect"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { openRemoteHostTarget, retainRunAccountAuthority } from "@/lib/remote-host/target-transport"
import {
  acquireManagementChannel,
  closeManagementChannel,
} from "@/lib/remote-host/management-channel"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"
import type { Transport } from "@/lib/tauri/transport-types"
import type { TaskWorkspaceOrigin } from "./types"

export interface TaskWorkspaceAuthority {
  origin: TaskWorkspaceOrigin
  transport: Pick<Transport, "call">
  host?: RemoteHost
  assertCurrent(): void
  close(): void
}

export function sameTaskWorkspaceOrigin(a: TaskWorkspaceOrigin, b: TaskWorkspaceOrigin): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "local" ||
      (b.kind === "remote" && a.hostId === b.hostId && a.accountId === b.accountId))
  )
}

/** Open once for a gesture or turn and retain the same authority across awaits. */
export async function openTaskWorkspaceOrigin(
  origin: TaskWorkspaceOrigin,
  options: { retainedRun?: boolean } = {}
): Promise<TaskWorkspaceAuthority & { transport: Transport }> {
  if (origin.kind === "local") {
    if (!isTauri() && !isHeadlessHost()) throw new Error("Local workspace Host is unavailable")
    return { origin, transport: taskWorkspaceHostTransport(), assertCurrent() {}, close() {} }
  }
  const initial = getActiveRuntimeTargetContext()
  if (origin.accountId && initial?.accountId !== origin.accountId)
    throw new Error("Workspace run belongs to another account")
  const paired = origin.hostId.startsWith("companion:")
  const authorization =
    options.retainedRun && !paired
      ? retainRunAccountAuthority(origin.accountId, () => closeManagementChannel(origin.hostId))
      : undefined
  const assertCurrent = () => {
    const current = getActiveRuntimeTargetContext()
    if (origin.accountId && current?.accountId !== origin.accountId)
      throw new Error("Workspace run belongs to another account")
    authorization?.assertCurrent()
    if (
      paired &&
      !options.retainedRun &&
      (current?.targetId !== origin.hostId.slice("companion:".length) ||
        current?.accountId !== initial?.accountId ||
        current?.routingGeneration !== initial?.routingGeneration)
    ) {
      throw new Error("Workspace Host connection changed")
    }
  }
  let opened = false
  try {
    assertCurrent()
    const target =
      options.retainedRun && !paired
        ? await acquireManagementChannel(origin.hostId).then((lease) => ({
            ...lease,
            close: lease.release,
            assertCurrent: undefined,
          }))
        : options.retainedRun
          ? await openRemoteHostTarget(origin.hostId, { mode: "retained-run" })
          : await openRemoteHostTarget(origin.hostId)
    try {
      assertCurrent()
      target.assertCurrent?.()
    } catch (error) {
      target.close()
      throw error
    }
    opened = true
    return {
      origin,
      host: target.host,
      transport: target.transport,
      assertCurrent() {
        assertCurrent()
        target.assertCurrent?.()
      },
      close() {
        authorization?.close()
        target.close()
      },
    }
  } finally {
    if (!opened) authorization?.close()
  }
}

/** Capture at acquisition, never infer ownership when someone opens history. */
export function captureTaskWorkspaceOrigin(): TaskWorkspaceOrigin {
  if (isHeadlessHost()) return { kind: "local" }
  const remoteId = useRemoteHostStore.getState().activeHostId
  const account = getActiveRuntimeTargetContext()?.accountId
  if (remoteId)
    return { kind: "remote", hostId: remoteId, ...(account ? { accountId: account } : {}) }
  const target = getRuntimeSnapshot().target
  if (target?.kind === "companion") {
    return {
      kind: "remote",
      hostId: `companion:${target.id}`,
      ...(account ? { accountId: account } : {}),
    }
  }
  return { kind: "local" }
}

/** A host process must never follow the desktop's selected remote route. */
export function taskWorkspaceHostTransport(): Transport {
  return isTauri() ? localTransport : transport
}

/** Retained reads and user mutations stay on their original execution authority. */
export async function callTaskWorkspaceOrigin<T>(
  origin: TaskWorkspaceOrigin,
  command: string,
  args: Record<string, unknown>,
  mutation = false
): Promise<T> {
  const target = await openTaskWorkspaceOrigin(origin)
  try {
    target.assertCurrent()
    const lease =
      mutation && origin.kind === "remote"
        ? await issueHostAdminLease([command], 120, target.transport)
        : null
    target.assertCurrent()
    const result = await target.transport.call<T>(command, {
      ...args,
      ...(lease ? { adminLease: lease.token } : {}),
    })
    target.assertCurrent()
    return result
  } finally {
    target.close()
  }
}
