/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import {
  useComposerCameraRecovery,
  type ComposerCameraRecoveryInput,
} from "./use-composer-camera-recovery"

type Handler = (result: unknown, isCurrent: () => boolean) => Promise<boolean>
const useCameraRecovery = jest.fn((_target: unknown, _handler: Handler) => undefined)
jest.mock("@/hooks/use-camera-recovery", () => ({
  useCameraRecovery: (target: unknown, handler: Handler) => useCameraRecovery(target, handler),
}))

const file = new File(["x"], "photo.jpeg")

function input(extra: Partial<ComposerCameraRecoveryInput> = {}): ComposerCameraRecoveryInput {
  return {
    attachmentToFiles: jest.fn(async () => [file]),
    sessionId: "s1",
    persistDrafts: true,
    draftHydratedFor: "s1",
    acceptFiles: jest.fn(async (files: File[]) => files) as never,
    ...extra,
  }
}

const lastTarget = () => useCameraRecovery.mock.calls.at(-1)?.[0]
const lastHandler = () => useCameraRecovery.mock.calls.at(-1)?.[1] as Handler

beforeEach(() => useCameraRecovery.mockClear())

it("listens for this conversation only once its draft has hydrated", () => {
  renderHook(() => useComposerCameraRecovery(input()))
  expect(lastTarget()).toEqual({ kind: "chat", id: "s1" })

  renderHook(() => useComposerCameraRecovery(input({ draftHydratedFor: null })))
  expect(lastTarget()).toBeNull()

  renderHook(() =>
    useComposerCameraRecovery(input({ draftHydratedFor: null, persistDrafts: false }))
  )
  expect(lastTarget()).toEqual({ kind: "chat", id: "s1" })
})

it("stages recovered photos through the intake gate", async () => {
  const deps = input()
  renderHook(() => useComposerCameraRecovery(deps))

  await expect(
    lastHandler()({ kind: "photos", photos: [{ uri: "u1", format: "jpeg" }] }, () => true)
  ).resolves.toBe(true)
  expect(deps.attachmentToFiles).toHaveBeenCalledWith({
    kind: "photos",
    items: [{ uri: "u1", mime: "image/jpeg" }],
  })
  expect(deps.acceptFiles).toHaveBeenCalledWith([file], expect.anything())

  await lastHandler()({ kind: "photo", photo: { uri: "u2", format: "png" } }, () => true)
  expect(deps.attachmentToFiles).toHaveBeenLastCalledWith({
    kind: "photo",
    uri: "u2",
    format: "png",
    mime: "image/png",
  })
})

it("drops a recovery that is no longer current", async () => {
  const deps = input()
  renderHook(() => useComposerCameraRecovery(deps))
  await expect(
    lastHandler()({ kind: "photo", photo: { uri: "u", format: "png" } }, () => false)
  ).resolves.toBe(false)
  expect(deps.acceptFiles).not.toHaveBeenCalled()
})
