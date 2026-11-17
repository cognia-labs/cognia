/** @jest-environment jsdom */
import type { ComposerMemoryTarget } from "@/lib/chat/memory-target"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  runComposerMemorySubmit,
  runComposerShellSubmit,
  runComposerSlashCommand,
  runComposerTurn,
} from "./composer-turn-handlers"

const toast = { error: jest.fn(), success: jest.fn() }
jest.mock("sonner", () => ({
  toast: { error: (m: string) => toast.error(m), success: (m: string) => toast.success(m) },
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: jest.fn(async () => undefined),
}))
const rememberFact = jest.fn()
jest.mock("@/lib/memory/write/remember-fact", () => ({
  rememberFact: (...args: unknown[]) => rememberFact(...args),
}))
const sendManualMessageToConversation = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/inbox/manual-send", () => ({
  UnsupportedPlatformAttachmentsError: class extends Error {},
  sendManualMessageToConversation: (...args: unknown[]) => sendManualMessageToConversation(...args),
}))

const t = ((key: string) => key) as never
type SlashCtx = Parameters<typeof runComposerSlashCommand>[0]

function slashContext(extra: Partial<SlashCtx> = {}): SlashCtx {
  return {
    session: { id: "s1", kind: "direct" } as ChatSession,
    onStartNewSession: jest.fn(),
    onOpenSettings: jest.fn(),
    tCommands: t,
    tBestOfN: t,
    status: "ready",
    setPermissionMode: jest.fn(),
    pushSystemMessage: jest.fn(),
    runPluginCommand: jest.fn(async () => true),
    requestBestOfN: jest.fn(async () => true),
    isMobileShell: false,
    ...extra,
  } as unknown as SlashCtx
}

beforeEach(() => jest.clearAllMocks())

describe("runComposerSlashCommand", () => {
  it("runs a command's handler with this conversation's context", async () => {
    const handler = jest.fn(async () => undefined)
    const ctx = slashContext()

    await expect(
      runComposerSlashCommand(ctx, { name: "compact", handler } as unknown as SlashCommand, "now")
    ).resolves.toBe(true)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ args: "now", activeSessionId: "s1", isAside: false })
    )
  })

  it("hands a plugin command to the plugin runner", async () => {
    const ctx = slashContext()
    const cmd = { name: "lint", scope: "plugin", handler: jest.fn() } as unknown as SlashCommand

    await expect(runComposerSlashCommand(ctx, cmd, "")).resolves.toBe(true)
    expect(ctx.runPluginCommand).toHaveBeenCalledWith(cmd, expect.objectContaining({ args: "" }))
    expect(cmd.handler).not.toHaveBeenCalled()
  })

  it("refuses best-of-N with attachments, and reports a failed handler", async () => {
    const ctx = slashContext()
    const bestOfN = { name: "best-of-n", handler: jest.fn() } as unknown as SlashCommand
    await expect(
      runComposerSlashCommand(ctx, bestOfN, "", {
        files: [{ id: "f", url: "u", mediaType: "" }],
        consume: jest.fn(),
      })
    ).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith("textOnly")

    const failing = {
      name: "boom",
      handler: jest.fn(async () => {
        throw new Error("nope")
      }),
    } as unknown as SlashCommand
    await expect(runComposerSlashCommand(ctx, failing, "")).resolves.toBe(true)
    expect(toast.error).toHaveBeenLastCalledWith("nope")
  })
})

describe("runComposerShellSubmit", () => {
  it("needs a line and a working directory", async () => {
    const ctx = {
      session: null,
      tShell: t,
      shellJobCopy: {},
      shell: { availability: "full", shell: { path: "/bin/zsh" } },
      cwd: null,
      pushSystemMessage: jest.fn(),
    } as unknown as Parameters<typeof runComposerShellSubmit>[0]

    await expect(runComposerShellSubmit(ctx, "   ")).resolves.toBe(false)
    await expect(runComposerShellSubmit(ctx, "ls")).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith("needsCwd")
  })
})

describe("runComposerMemorySubmit", () => {
  const ctx = { session: { id: "s1" }, tMemory: t, cwd: "/repo" } as unknown as Parameters<
    typeof runComposerMemorySubmit
  >[0]
  const store = { target: "store", scope: "global" } as ComposerMemoryTarget

  it("remembers a fact in the store", async () => {
    rememberFact.mockResolvedValue({ ok: true })
    await expect(runComposerMemorySubmit(ctx, store, "use pnpm")).resolves.toBe(true)
    expect(rememberFact).toHaveBeenCalledWith({
      text: "use pnpm",
      scope: "global",
      sessionId: "s1",
    })
    expect(toast.success).toHaveBeenCalledWith("storedInMemory")
  })

  it("says why the store refused", async () => {
    rememberFact.mockResolvedValue({ ok: false, reason: "duplicate" })
    await expect(runComposerMemorySubmit(ctx, store, "use pnpm")).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith("storeError.duplicate")
  })
})

describe("runComposerTurn", () => {
  type TurnCtx = Parameters<typeof runComposerTurn>[0]
  function turnContext(extra: Partial<TurnCtx>): TurnCtx {
    return {
      session: { id: "s1", kind: "direct" },
      bestOfNCount: null,
      requestBestOfN: jest.fn(async () => true),
      setBestOfNChoice: jest.fn(),
      tBestOfN: t,
      ...extra,
    } as unknown as TurnCtx
  }

  it("starts best-of-N from text only and clears the choice once started", async () => {
    const ctx = turnContext({ bestOfNCount: 3 })
    await expect(runComposerTurn(ctx, " compare these ", [])).resolves.toBe(true)
    expect(ctx.requestBestOfN).toHaveBeenCalledWith("compare these", 3)
    expect(ctx.setBestOfNChoice).toHaveBeenCalledWith(null)

    const withFile = turnContext({ bestOfNCount: 2 })
    await expect(runComposerTurn(withFile, "x", [{} as never])).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith("textOnly")
  })

  it("posts into the IM conversation a session is bound to", async () => {
    const session = { id: "s1", kind: "direct", platformBinding: { platform: "lark" } }
    const ctx = turnContext({ session: session as unknown as ChatSession })

    await runComposerTurn(ctx, "hello there", [])

    expect(sendManualMessageToConversation).toHaveBeenCalledWith(
      expect.objectContaining({ session, text: "hello there", files: [] })
    )
  })

  it("sends nothing to an IM conversation for an empty submit", async () => {
    const session = { id: "s1", platformBinding: { platform: "lark" } }
    const ctx = turnContext({ session: session as unknown as ChatSession })
    await expect(runComposerTurn(ctx, "  ", [])).resolves.toBe(false)
    expect(sendManualMessageToConversation).not.toHaveBeenCalled()
  })
})
