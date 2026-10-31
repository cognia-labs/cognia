import {
  requestConnectionPrompt,
  resolveConnectionPrompt,
  subscribeConnectionPrompts,
  type ConnectionPromptState,
} from "./connection-prompts"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"

it("dismisses immediately with no prompt surface", async () => {
  await expect(
    requestConnectionPrompt({ kind: "picker", pluginId: "p", pluginName: "P", candidates: [] })
  ).resolves.toEqual({ kind: "dismissed" })
})

it("queues, rejects answers to a queued prompt and dismisses everything on unmount", async () => {
  let state!: ConnectionPromptState
  const dispose = subscribeConnectionPrompts((value) => {
    state = value
  })
  const request = { kind: "picker" as const, pluginId: "p", pluginName: "P", candidates: [] }
  const first = requestConnectionPrompt(request)
  const second = requestConnectionPrompt(request)
  expect(state.queue).toHaveLength(1)
  const id = state.current!.id
  resolveConnectionPrompt(state.queue[0].id, { kind: "dismissed" })
  expect(state.current!.id).toBe(id)
  resolveConnectionPrompt(id, { kind: "selected", ref: "forged" as AuthConnectionRef })
  expect(state.current!.id).toBe(id)
  resolveConnectionPrompt(id, { kind: "approved" })
  expect(state.current!.id).toBe(id)
  resolveConnectionPrompt(id, { kind: "dismissed" })
  await expect(first).resolves.toEqual({ kind: "dismissed" })
  expect(state.current!.id).not.toBe(id)
  dispose()
  await expect(second).resolves.toEqual({ kind: "dismissed" })
})
