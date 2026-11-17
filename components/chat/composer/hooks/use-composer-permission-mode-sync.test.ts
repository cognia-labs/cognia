/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { PermissionMode } from "@/stores/chat/chat-store"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  useComposerPermissionModeSync,
  type ComposerPermissionModeSyncInput,
} from "./use-composer-permission-mode-sync"

const session = (id: string, permissionMode?: PermissionMode) =>
  ({ id, permissionMode }) as ChatSession

function setup(initial: ComposerPermissionModeSyncInput) {
  return renderHook((p: ComposerPermissionModeSyncInput) => useComposerPermissionModeSync(p), {
    initialProps: initial,
  })
}

it("hydrates the store from the row, then writes only later changes back", () => {
  const setPermissionMode = jest.fn()
  const updateSession = jest.fn(async () => undefined)
  const row = session("s1", "plan" as PermissionMode)
  const hook = setup({
    setPermissionMode,
    permissionMode: null,
    updateSession,
    props: { session: row },
  })
  expect(setPermissionMode).toHaveBeenCalledWith("plan", "s1")
  expect(updateSession).not.toHaveBeenCalled()

  // The store catches up with the row: the hydration commits, nothing is written.
  hook.rerender({
    setPermissionMode,
    permissionMode: "plan" as PermissionMode,
    updateSession,
    props: { session: row },
  })
  expect(updateSession).not.toHaveBeenCalled()

  // A later change is persisted.
  hook.rerender({
    setPermissionMode,
    permissionMode: "acceptEdits" as PermissionMode,
    updateSession,
    props: { session: row },
  })
  expect(updateSession).toHaveBeenCalledWith("s1", { permissionMode: "acceptEdits" })
})

it("does not loop on an absent row value against a null store value", () => {
  const updateSession = jest.fn(async () => undefined)
  const row = session("s1")
  const hook = setup({
    setPermissionMode: jest.fn(),
    permissionMode: null,
    updateSession,
    props: { session: row },
  })
  hook.rerender({
    setPermissionMode: jest.fn(),
    permissionMode: null,
    updateSession,
    props: { session: { ...row } as ChatSession },
  })
  expect(updateSession).not.toHaveBeenCalled()
})

it("does nothing without a conversation", () => {
  const setPermissionMode = jest.fn()
  setup({
    setPermissionMode,
    permissionMode: null,
    updateSession: jest.fn(),
    props: { session: null },
  })
  expect(setPermissionMode).not.toHaveBeenCalled()
})
