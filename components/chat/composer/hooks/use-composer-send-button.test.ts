/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { AttachmentsContext } from "@/components/ai-elements/prompt-input"
import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerSendButton, type ComposerSendButtonInput } from "./use-composer-send-button"

const resolveSendButton = jest.fn((..._args: unknown[]) => ({ mode: "send" }))
jest.mock("../send-button-mode", () => ({
  resolveSendButton: (...args: unknown[]) => resolveSendButton(...args),
}))

function input(extra: Partial<ComposerSendButtonInput> = {}): ComposerSendButtonInput {
  return {
    outboundBlocked: false,
    textValue: "",
    attachments: { files: [] } as unknown as AttachmentsContext,
    turnInFlight: false,
    followUpInFlight: false,
    isPreparingAttachments: false,
    props: { status: "ready", session: { id: "s1" } as ChatSession },
    ...extra,
  }
}

const lastCall = () => resolveSendButton.mock.calls.at(-1)?.[0] as Record<string, unknown>

beforeEach(() => resolveSendButton.mockClear())

it("counts a fresh turn's dispatch as sending only until the turn is live", () => {
  renderHook(() => useComposerSendButton(input({ turnInFlight: true, textValue: "hi" })))
  expect(lastCall()).toEqual(expect.objectContaining({ isSending: true, hasContent: true }))

  const live = renderHook(() =>
    useComposerSendButton(
      input({ turnInFlight: true, props: { status: "streaming", session: null } })
    )
  )
  expect(lastCall()).toEqual(expect.objectContaining({ isSending: false, status: "streaming" }))
  expect(live.result.current.isStreaming).toBe(true)
})

it("shows a running plugin command as streaming and an IM chat as always ready", () => {
  renderHook(() =>
    useComposerSendButton(
      input({ textValue: "x", props: { status: "ready", commandRunning: true, session: null } })
    )
  )
  expect(lastCall()).toEqual(
    expect.objectContaining({ status: "streaming", isSending: false, hasContent: false })
  )

  const bound = { id: "s1", platformBinding: { platform: "lark" } } as unknown as ChatSession
  renderHook(() => useComposerSendButton(input({ props: { status: "streaming", session: bound } })))
  expect(lastCall()).toEqual(expect.objectContaining({ status: "ready" }))
})
