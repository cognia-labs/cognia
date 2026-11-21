import { renderHook, act, waitFor } from "@testing-library/react"

import { usePetChat } from "./use-pet-chat"
import { usePetStore } from "@/stores/pet/pet-store"
import { bumpPetConversationGeneration } from "@/lib/pet/runtime/pet-scope"
import type { PetChatResult } from "@/lib/pet/chat/respond"

// Transcript is incidental to the send logic under test — stub the live query.
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("next-intl", () => ({ useLocale: () => "en" }))

const args = { profile: undefined, view: undefined, activeCharacterId: null }

describe("usePetChat", () => {
  beforeEach(() => usePetStore.setState({ oneShotQueue: [] }))

  it("echoes the pending text, clears it on ok, and plays the emotion one-shot", async () => {
    const respond = jest.fn().mockResolvedValue({
      status: "ok",
      reply: "hi",
      emotion: "love",
    } satisfies PetChatResult)
    const { result } = renderHook(() => usePetChat(args, { respond, now: () => 42 }))

    await act(async () => {
      await result.current.send("  hello  ")
    })

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "hello", at: 42 }),
      expect.anything()
    )
    expect(result.current.pending).toBeNull()
    expect(result.current.degradeReason).toBeNull()
    expect(usePetStore.getState().oneShotQueue).toContain("love")
  })

  it("keeps the pending message and exposes the reason on a degrade", async () => {
    const respond = jest
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "rateLimited" } satisfies PetChatResult)
    const { result } = renderHook(() => usePetChat(args, { respond }))

    await act(async () => {
      await result.current.send("later")
    })

    expect(result.current.pending).toBe("later")
    expect(result.current.degradeReason).toBe("rateLimited")
  })

  it("ignores empty sends and guards against concurrent sends", async () => {
    let resolveFirst: (r: PetChatResult) => void = () => {}
    const respond = jest
      .fn()
      .mockImplementationOnce(() => new Promise<PetChatResult>((res) => (resolveFirst = res)))
    const { result } = renderHook(() => usePetChat(args, { respond }))

    await act(async () => {
      await result.current.send("   ") // empty → no call
    })
    expect(respond).not.toHaveBeenCalled()

    act(() => {
      void result.current.send("first")
    })
    await waitFor(() => expect(result.current.inFlight).toBe(true))

    await act(async () => {
      await result.current.send("second") // ignored while in flight
      resolveFirst({ status: "degraded", reason: "empty" })
    })
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it("retains successful replies ephemerally when memory is off or append fails and clears on clear (F1, F4)", async () => {
    const respond = jest.fn().mockResolvedValue({
      status: "ok",
      reply: "ephemeral hello",
      persisted: false,
    } satisfies PetChatResult)
    const { result } = renderHook(() => usePetChat(args, { respond, now: () => 500 }))

    await act(async () => {
      await result.current.send("hello")
    })
    expect(result.current.pending).toBeNull()
    expect(result.current.turns).toEqual([
      expect.objectContaining({ userText: "hello", reply: "ephemeral hello", at: 500 }),
    ])

    act(() => {
      bumpPetConversationGeneration()
    })
    expect(result.current.turns).toEqual([])
  })

  it("drops a late reply and releases inFlight when cleared mid-send (F4)", async () => {
    let resolveTurn!: (r: PetChatResult) => void
    const respond = jest
      .fn()
      .mockImplementationOnce(() => new Promise<PetChatResult>((r) => (resolveTurn = r)))
    const { result } = renderHook(() => usePetChat(args, { respond }))

    act(() => {
      void result.current.send("in flight")
    })
    await waitFor(() => expect(result.current.inFlight).toBe(true))

    act(() => {
      bumpPetConversationGeneration()
    })
    await act(async () => {
      resolveTurn({ status: "ok", reply: "late ghost", persisted: false })
    })
    expect(result.current.turns).toEqual([])
    expect(result.current.pending).toBeNull()
    expect(result.current.inFlight).toBe(false)
  })
})
