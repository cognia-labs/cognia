import {
  messageActionCommandsAt,
  ACTION_BUTTON_REM,
  ACTION_FOLD_RESERVE_REM,
  BAR_FOLD_HIDE_CLASS,
  barFoldHideClass,
  barFoldNeeds,
  barFoldThresholdRem,
  foldedBarCommandIds,
  resolveMessageActionCommands,
  splitSheetCommands,
  type MessageActionCommand,
  type MessageActionCommandContext,
} from "./message-action-commands"

describe("resolveMessageActionCommands", () => {
  it("produces the same capability-based set independently of the UI surface", () => {
    const commands = resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      canRegenerate: true,
      canReadAloud: true,
      streaming: true,
    })

    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(["copy", "share", "copyLink", "branch", "regenerate", "readAloud"])
    )
    expect(commands.find((command) => command.id === "branch")?.disabled).toBe(true)
    expect(commands.find((command) => command.id === "truncate")?.destructive).toBe(true)
  })

  it("offers reply only with a conversation to answer into and words to quote", () => {
    const ids = (context: Parameters<typeof resolveMessageActionCommands>[0]) =>
      resolveMessageActionCommands(context).map((command) => command.id)
    expect(ids({ role: "assistant", hasContent: true, hasSession: true })).toContain("reply")
    expect(ids({ role: "user", hasContent: true, hasSession: true })).toContain("reply")
    expect(ids({ role: "assistant", hasContent: false, hasSession: true })).not.toContain("reply")
    expect(ids({ role: "assistant", hasContent: true, hasSession: false })).not.toContain("reply")
  })

  it("does not invent content or session actions", () => {
    expect(
      resolveMessageActionCommands({ role: "user", hasContent: false, hasSession: false })
    ).toEqual([{ id: "bookmark", placement: "menu" }])
  })

  it("includes role and host capabilities with their safety flags", () => {
    const user = resolveMessageActionCommands({
      role: "user",
      hasContent: true,
      hasSession: true,
      canEdit: true,
      canBringBack: true,
      canDelete: true,
      streaming: false,
    })
    expect(user.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["edit", "bringBack", "delete", "branch", "truncate"])
    )
    expect(user.find(({ id }) => id === "delete")?.destructive).toBe(true)
    expect(user.find(({ id }) => id === "branch")?.disabled).toBe(false)

    const assistant = resolveMessageActionCommands({
      role: "assistant",
      hasContent: false,
      hasSession: false,
      canRegenerate: true,
      streaming: false,
    })
    expect(assistant).toContainEqual({ id: "regenerate", placement: "bar", disabled: false })
    expect(assistant.some(({ id }) => id === "edit")).toBe(false)
  })
})

describe("resend", () => {
  const base = { role: "user" as const, hasContent: true, hasSession: true }

  it("is offered next to edit on a user turn that can replay", () => {
    const ids = resolveMessageActionCommands({ ...base, canEdit: true }).map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(["edit", "resend"]))
  })

  it("is absent without the edit capability or on an assistant turn", () => {
    expect(resolveMessageActionCommands(base).map((c) => c.id)).not.toContain("resend")
    expect(
      resolveMessageActionCommands({ ...base, role: "assistant", canEdit: true }).map((c) => c.id)
    ).not.toContain("resend")
  })

  // A replay mid-turn would clobber the running stream — and both paths call
  // the same editAndResend, whose branch tag a steer never consumes.
  it("is disabled while a turn is in flight", () => {
    const commands = resolveMessageActionCommands({
      ...base,
      canEdit: true,
      streaming: true,
    })
    expect(commands.find((c) => c.id === "resend")?.disabled).toBe(true)
    expect(commands.find((c) => c.id === "edit")?.disabled).toBe(true)
  })
})

describe("rerunTemplate", () => {
  const base = { role: "user" as const, hasContent: true, hasSession: true }

  it("is offered on a user turn that recorded its parameters", () => {
    const ids = resolveMessageActionCommands({ ...base, canRerunTemplate: true }).map((c) => c.id)
    expect(ids).toContain("rerunTemplate")
  })

  it("is absent on a turn with nothing recorded", () => {
    expect(resolveMessageActionCommands(base).map((c) => c.id)).not.toContain("rerunTemplate")
  })

  // On the answer it would read as "regenerate", which is a different command.
  it("is absent on an assistant turn", () => {
    const ids = resolveMessageActionCommands({
      ...base,
      role: "assistant",
      canRerunTemplate: true,
    }).map((c) => c.id)
    expect(ids).not.toContain("rerunTemplate")
  })

  it("is disabled while the turn is streaming", () => {
    const command = resolveMessageActionCommands({
      ...base,
      canRerunTemplate: true,
      streaming: true,
    }).find((c) => c.id === "rerunTemplate")
    expect(command?.disabled).toBe(true)
  })
})

describe("saveAsIssue", () => {
  const base = { role: "assistant" as const, hasContent: true, hasSession: true }
  const ids = (over = {}) => resolveMessageActionCommands({ ...base, ...over }).map((c) => c.id)

  it("is offered on an assistant turn with content, never on the user's own", () => {
    expect(ids({ canSaveAsIssue: true })).toContain("saveAsIssue")
    expect(ids()).not.toContain("saveAsIssue")
    expect(ids({ role: "user", canSaveAsIssue: true })).not.toContain("saveAsIssue")
    expect(ids({ hasContent: false, canSaveAsIssue: true })).not.toContain("saveAsIssue")
  })

  it("is disabled mid-stream", () => {
    const command = resolveMessageActionCommands({
      ...base,
      canSaveAsIssue: true,
      streaming: true,
    }).find((c) => c.id === "saveAsIssue")
    expect(command?.disabled).toBe(true)
  })
})

describe("saveAsMemory", () => {
  const base = { role: "assistant" as const, hasContent: true, hasSession: true }
  const ids = (over = {}) => resolveMessageActionCommands({ ...base, ...over }).map((c) => c.id)

  it("is offered on an assistant turn that can be saved", () => {
    expect(ids({ canSaveAsMemory: true })).toContain("saveAsMemory")
  })

  it("is absent without the capability", () => {
    expect(ids()).not.toContain("saveAsMemory")
  })

  // A user's own message is already theirs to save with `/remember`; what had
  // no path is the thing the AGENT worked out.
  it("is never offered on the user's own turn", () => {
    expect(ids({ role: "user", canSaveAsMemory: true })).not.toContain("saveAsMemory")
  })

  it("is absent for a turn with nothing in it", () => {
    expect(ids({ hasContent: false, canSaveAsMemory: true })).not.toContain("saveAsMemory")
  })

  it("is disabled mid-stream", () => {
    const command = resolveMessageActionCommands({
      ...base,
      canSaveAsMemory: true,
      streaming: true,
    }).find((c) => c.id === "saveAsMemory")
    expect(command?.disabled).toBe(true)
  })
})

describe("select", () => {
  const ids = (over: Partial<Parameters<typeof resolveMessageActionCommands>[0]> = {}) =>
    resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      ...over,
    }).map((c) => c.id)

  it("is offered by a surface that mounts selection mode, on either role", () => {
    expect(ids({ canSelect: true })).toContain("select")
    expect(ids({ role: "user", canSelect: true })).toContain("select")
  })

  // A read-only transcript does not pass the capability, so it offers no row
  // that would open nothing.
  it("is absent without the capability", () => {
    expect(ids()).not.toContain("select")
  })

  it("needs a conversation to act on, not words", () => {
    expect(ids({ hasSession: false, canSelect: true })).not.toContain("select")
    expect(ids({ hasContent: false, canSelect: true })).toContain("select")
  })
})

describe("selectText", () => {
  const ids = (over: Partial<Parameters<typeof resolveMessageActionCommands>[0]> = {}) =>
    resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      ...over,
    }).map((c) => c.id)

  it("is offered by a touch surface, on either role", () => {
    expect(ids({ canSelectText: true })).toContain("selectText")
    expect(ids({ role: "user", canSelectText: true })).toContain("selectText")
  })

  // Where text is selected in place, a sheet for it would be a second way to do
  // the same thing.
  it("is absent without the capability", () => {
    expect(ids()).not.toContain("selectText")
    expect(ids({ canSelect: true })).not.toContain("selectText")
  })

  // The sheet shows words to select from, and stages what is chosen into a
  // conversation.
  it("needs words and a conversation", () => {
    expect(ids({ hasContent: false, canSelectText: true })).not.toContain("selectText")
    expect(ids({ hasSession: false, canSelectText: true })).not.toContain("selectText")
  })
})

describe("restorePoint", () => {
  const command = (over: Partial<Parameters<typeof resolveMessageActionCommands>[0]> = {}) =>
    resolveMessageActionCommands({
      role: "user",
      hasContent: true,
      hasSession: true,
      ...over,
    }).find((c) => c.id === "restorePoint")

  it("is offered on the user's own turn in a conversation", () => {
    expect(command()).toEqual({ id: "restorePoint", placement: "menu", disabled: undefined })
  })

  it("is absent on a reply or outside a conversation", () => {
    expect(command({ role: "assistant" })).toBeUndefined()
    expect(command({ hasSession: false })).toBeUndefined()
  })

  it("is disabled while the conversation is mid-turn", () => {
    expect(command({ streaming: true })?.disabled).toBe(true)
  })
})

describe("placement (D10)", () => {
  const everything: MessageActionCommandContext = {
    role: "assistant",
    hasContent: true,
    hasSession: true,
    canRegenerate: true,
    canReadAloud: true,
    canSaveAsMemory: true,
    canSaveAsIssue: true,
    canSelect: true,
    canSelectText: true,
    canBringBack: true,
    canSendToMain: true,
    canDelete: true,
  }

  it("puts every command in exactly one place, the bar's first", () => {
    const commands = resolveMessageActionCommands(everything)
    const ids = commands.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
    const firstMenu = commands.findIndex((command) => command.placement === "menu")
    expect(commands.slice(firstMenu).every((command) => command.placement === "menu")).toBe(true)
    expect(messageActionCommandsAt(commands, "bar").map((command) => command.id)).toEqual([
      "copy",
      "reply",
      "saveAsMemory",
      "saveAsIssue",
      "regenerate",
      "readAloud",
    ])
    expect(messageActionCommandsAt(commands, "menu").map((command) => command.id)).toEqual([
      "share",
      "quote",
      "copyLink",
      "shareCard",
      "bookmark",
      "select",
      "selectText",
      "branch",
      "truncate",
      "sendToMain",
      "bringBack",
      "delete",
    ])
  })

  it("draws reply once, on the bar", () => {
    const reply = resolveMessageActionCommands(everything).filter(({ id }) => id === "reply")
    expect(reply).toEqual([{ id: "reply", placement: "bar" }])
  })

  it("keeps the user's own turn's commands on the bar in reading order", () => {
    const bar = messageActionCommandsAt(
      resolveMessageActionCommands({
        role: "user",
        hasContent: true,
        hasSession: true,
        canEdit: true,
        canRerunTemplate: true,
      }),
      "bar"
    ).map(({ id }) => id)
    expect(bar).toEqual(["copy", "edit", "resend", "reply", "rerunTemplate"])
  })

  it("offers send to main only from a side chat, with words to send", () => {
    const ids = (over: Partial<MessageActionCommandContext>) =>
      resolveMessageActionCommands({ ...everything, ...over }).map(({ id }) => id)
    expect(ids({ canSendToMain: false })).not.toContain("sendToMain")
    expect(ids({ hasContent: false })).not.toContain("sendToMain")
  })

  it("keeps only what the surface allows", () => {
    const commands = resolveMessageActionCommands({
      ...everything,
      allowed: new Set(["copy", "bookmark", "branch"]),
    })
    expect(commands.map(({ id }) => id)).toEqual(["copy", "bookmark", "branch"])
  })
})

describe("splitSheetCommands (D15)", () => {
  const ids = (commands: MessageActionCommand[]) => commands.map(({ id }) => id)

  it("puts the commands a thumb reaches for first in the strip, in that order", () => {
    const commands = resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      canRegenerate: true,
      canReadAloud: true,
    })
    const { primary, rest } = splitSheetCommands(commands)
    expect(ids(primary)).toEqual(["copy", "regenerate", "reply", "share"])
    expect(rest.map(({ id }) => id)).not.toContain("copy")
    // Everything else keeps its resolved order, the bar's first.
    expect(ids(rest)).toEqual(
      ids(commands).filter((id) => !["copy", "regenerate", "reply", "share"].includes(id))
    )
  })

  it("leads with edit on the user's own turn", () => {
    const commands = resolveMessageActionCommands({
      role: "user",
      hasContent: true,
      hasSession: true,
      canEdit: true,
    })
    expect(ids(splitSheetCommands(commands).primary)).toEqual(["copy", "edit", "reply", "share"])
  })

  it("never makes a destructive command primary, and keeps every command once", () => {
    const commands: MessageActionCommand[] = [
      { id: "delete", placement: "menu", destructive: true },
      { id: "copy", placement: "bar" },
    ]
    const { primary, rest } = splitSheetCommands(commands)
    expect(ids(primary)).toEqual(["copy"])
    expect(ids(rest)).toEqual(["delete"])
  })

  it("draws no more than the strip holds", () => {
    const commands = resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      canRegenerate: true,
    })
    expect(splitSheetCommands(commands, 2).primary).toHaveLength(2)
  })
})

describe("folding the bar by row width", () => {
  const assistantBar = () =>
    messageActionCommandsAt(
      resolveMessageActionCommands({
        role: "assistant",
        hasContent: true,
        hasSession: true,
        canRegenerate: true,
        canReadAloud: true,
        canSaveAsMemory: true,
        canSaveAsIssue: true,
      }),
      "bar"
    )

  it("spells each hide class from the threshold it encodes", () => {
    BAR_FOLD_HIDE_CLASS.forEach((cls, n) => {
      if (n === 0) return expect(cls).toBe("")
      const rem = ACTION_FOLD_RESERVE_REM + n * ACTION_BUTTON_REM
      expect(barFoldThresholdRem(n)).toBe(rem)
      expect(cls).toBe(`@max-[${rem}rem]/msgrow:hidden`)
    })
  })

  it("never folds copy or read-aloud, and folds regenerate last", () => {
    const needs = barFoldNeeds(assistantBar())
    expect(needs.has("copy")).toBe(false)
    expect(needs.has("readAloud")).toBe(false)
    expect(barFoldHideClass(needs, "copy")).toBe("")
    // copy + readAloud + reaction picker + "…" = 4 fixed; 4 foldable.
    expect(needs.get("regenerate")).toBe(5)
    expect(needs.get("reply")).toBe(6)
    expect(needs.get("saveAsMemory")).toBe(7)
    expect(needs.get("saveAsIssue")).toBe(8)
  })

  it("folds from the least used command as the row narrows", () => {
    const bar = assistantBar()
    expect(foldedBarCommandIds(bar, 800)).toEqual([])
    // 28rem = 448px: needs 8 → saveAsIssue folds (28rem) but 7 (25.75rem) fits.
    expect(foldedBarCommandIds(bar, 440)).toEqual(["saveAsIssue"])
    expect(foldedBarCommandIds(bar, 300)).toEqual([
      "reply",
      "saveAsMemory",
      "saveAsIssue",
      "regenerate",
    ])
  })

  it("folds nothing on a row that has not been laid out", () => {
    expect(foldedBarCommandIds(assistantBar(), 0)).toEqual([])
  })
})
