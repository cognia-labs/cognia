import {
  mergeMessageRenderContext,
  resolveMessageRenderProps,
  type MessageRenderContextValue,
} from "./message-render-context"

const display = { preset: "balanced" } as never
const otherDisplay = { preset: "inspector" } as never

describe("mergeMessageRenderContext", () => {
  it("lets the inner provider override the keys it sets and keeps the rest", () => {
    const onCopy = jest.fn()
    const merged = mergeMessageRenderContext(
      { onCopy, messageDisplay: display, projectRoot: "/repo" },
      { messageDisplay: otherDisplay, projectRoot: undefined }
    )
    expect(merged).toEqual({ onCopy, messageDisplay: otherDisplay, projectRoot: "/repo" })
  })

  it("narrows canMutate: every level must allow", () => {
    const merged = mergeMessageRenderContext(
      { canMutate: (id) => id !== "locked" },
      { canMutate: (_id, kind) => kind !== "regenerate" }
    )
    expect(merged.canMutate!("m", "edit")).toBe(true)
    expect(merged.canMutate!("m", "regenerate")).toBe(false)
    expect(merged.canMutate!("locked", "edit")).toBe(false)
  })

  it("keeps a single level's canMutate as it is", () => {
    const canMutate = () => false
    expect(mergeMessageRenderContext({ canMutate }, {}).canMutate).toBe(canMutate)
    expect(mergeMessageRenderContext({}, { canMutate }).canMutate).toBe(canMutate)
  })
})

describe("resolveMessageRenderProps", () => {
  const context: MessageRenderContextValue = {
    onCopy: jest.fn(),
    onRegenerate: jest.fn(),
    onEditResend: jest.fn(),
    projectRoot: "/repo",
    messageDisplay: display,
    actionSheet: () => null,
  }

  it("fills a row's unset props from the context", () => {
    const resolved = resolveMessageRenderProps({ message: { id: "m" } }, context)
    expect(resolved).toMatchObject({
      onCopy: context.onCopy,
      onRegenerate: context.onRegenerate,
      onEditResend: context.onEditResend,
      projectRoot: "/repo",
      messageDisplay: display,
      actionSheetHost: true,
    })
  })

  it("keeps the props the row was handed", () => {
    const onRegenerate = jest.fn()
    const resolved = resolveMessageRenderProps(
      { message: { id: "m" }, onRegenerate, projectRoot: null, actionSheetHost: false },
      context
    )
    expect(resolved.onRegenerate).toBe(onRegenerate)
    expect(resolved.projectRoot).toBeNull()
    expect(resolved.actionSheetHost).toBe(false)
  })

  it("offers the context's mutations only where canMutate allows", () => {
    const resolved = resolveMessageRenderProps(
      { message: { id: "m" } },
      { ...context, canMutate: (_id, kind) => kind === "edit" }
    )
    expect(resolved.onEditResend).toBe(context.onEditResend)
    expect(resolved.onRegenerate).toBeUndefined()
  })

  it("keeps a mutation handed to the row even where the context would refuse it", () => {
    const onEditResend = jest.fn()
    const resolved = resolveMessageRenderProps(
      { message: { id: "m" }, onEditResend },
      { canMutate: () => false }
    )
    expect(resolved.onEditResend).toBe(onEditResend)
  })
})
