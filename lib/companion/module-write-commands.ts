/**
 * The paired-device write commands feature modules answer on the host
 * (ADR-0250 §14 `hostWriteCommands`). A module declares the commands in its
 * manifest, with the file that holds their handlers; the generated registry
 * (`lib/modules/generated/host-write-commands.ts`) lists the commands and one
 * lazy import per module, so the host's write dispatcher
 * (`./desktop-write-source.ts`) knows every owner without loading any feature
 * code, and loads the owner's file when one of its commands first arrives.
 *
 * A file loads once per module; one that fails to load is tried again on the
 * next command. A declared command the file does not provide throws a named
 * error rather than falling through to the dispatcher's own arms. An
 * `experimental` module answers nothing.
 */

import type {
  HostWriteHandler,
  ModuleHostWriteCommandsEntry,
  ModuleHostWriteCommandsModule,
} from "@/lib/modules/manifest-types"
import { MODULE_HOST_WRITE_COMMANDS } from "@/lib/modules/generated/host-write-commands"

type Handlers = ModuleHostWriteCommandsModule["hostWriteCommands"]

let entries: readonly ModuleHostWriteCommandsEntry[] = MODULE_HOST_WRITE_COMMANDS
const loads = new Map<string, Promise<Handlers>>()

function ownerOf(command: string): ModuleHostWriteCommandsEntry | undefined {
  return entries.find((entry) => entry.stage !== "experimental" && entry.commands.includes(command))
}

function loadEntry(entry: ModuleHostWriteCommandsEntry): Promise<Handlers> {
  const pending = loads.get(entry.module)
  if (pending) return pending
  const load = entry
    .load()
    .then(({ hostWriteCommands }) => hostWriteCommands)
    .catch((error: unknown) => {
      loads.delete(entry.module)
      throw error
    })
  loads.set(entry.module, load)
  return load
}

/** Whether an active module answers `command`. */
export function isModuleHostWriteCommand(command: string): boolean {
  return ownerOf(command) !== undefined
}

/**
 * The handler of a module-owned write command, or `undefined` when no active
 * module answers it (the dispatcher's own arms do).
 */
export async function moduleHostWriteHandler(
  command: string
): Promise<HostWriteHandler | undefined> {
  const entry = ownerOf(command)
  if (!entry) return undefined
  const handler = (await loadEntry(entry))[command]
  if (!handler)
    throw new Error(
      `desktop-write command ${command} is declared by ${entry.module} but not provided`
    )
  return handler
}

/** Replace the registry and forget what was loaded. */
export function __setModuleHostWriteCommandsForTesting(
  next: readonly ModuleHostWriteCommandsEntry[] = MODULE_HOST_WRITE_COMMANDS
): void {
  entries = next
  loads.clear()
}
