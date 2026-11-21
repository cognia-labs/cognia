import { renderHook, act } from "@testing-library/react"
import { usePetBubbles } from "./use-pet-bubbles"
import {
  getPetEventBus,
  emitPetEvent,
  __resetPetEventBusForTesting,
} from "@/lib/pet/events/pet-event-bus"
import { sayAsPet } from "@/lib/pet/bubbles/say"
import { __resetSpeakLimiterForTesting } from "@/lib/pet/bubbles/speak-limiter"
import { __resetProactiveClaims, claimKinds } from "@/lib/pet/llm/proactive/claim-registry"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"

beforeEach(() => {
  jest.useFakeTimers()
  __resetPetEventBusForTesting()
  __resetSpeakLimiterForTesting()
  usePetStore.setState({ bubble: null })
  useSettingsStore.setState({ settings: { petSettings: {} } } as never)
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
  __resetProactiveClaims()
})

describe("usePetBubbles", () => {
  it("shows a bubble for a templated event then clears it", () => {
    renderHook(() => usePetBubbles(true))
    act(() => emitPetEvent({ source: "user", kind: "fed", at: 5 }))
    expect(usePetStore.getState().bubble).not.toBeNull()
    act(() => jest.advanceTimersByTime(4000))
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("ignores silent kinds", () => {
    renderHook(() => usePetBubbles(true))
    act(() => emitPetEvent({ source: "system", kind: "idle", at: 1 }))
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("does nothing when disabled", () => {
    renderHook(() => usePetBubbles(false))
    act(() => emitPetEvent({ source: "user", kind: "fed", at: 1 }))
    expect(usePetStore.getState().bubble).toBeNull()
    expect(getPetEventBus()).toBeDefined()
  })

  it("stays silent for kinds claimed by the proactive engine", () => {
    renderHook(() => usePetBubbles(true))
    claimKinds(["levelUp"])
    act(() => emitPetEvent({ source: "system", kind: "levelUp", at: 9 }))
    expect(usePetStore.getState().bubble).toBeNull()
    // Unclaimed kinds still bubble exactly as before.
    act(() => emitPetEvent({ source: "system", kind: "evolved", at: 9 }))
    expect(usePetStore.getState().bubble).not.toBeNull()
  })

  it("substitutes a user catchphrase for the template on a matching seed", () => {
    useSettingsStore.setState({
      settings: { petSettings: { customBubbles: ["meow meow"] } },
    } as never)
    renderHook(() => usePetBubbles(true))
    // at=6 → 6 % 3 === 0 → the custom phrase is chosen over the template.
    act(() => emitPetEvent({ source: "user", kind: "fed", at: 6 }))
    expect(usePetStore.getState().bubble?.text).toBe("meow meow")
  })

  it("never clears a newer authored bubble when an earlier template timer expires (F29)", () => {
    renderHook(() => usePetBubbles(true))
    act(() => emitPetEvent({ source: "user", kind: "fed", at: 5 }))
    expect(usePetStore.getState().bubble?.origin).toBe("template")

    // 1s later, an authored 6s bubble replaces the template bubble.
    act(() => jest.advanceTimersByTime(1000))
    act(() => {
      sayAsPet("Build succeeded!", { durationMs: 6000 })
    })
    expect(usePetStore.getState().bubble?.text).toBe("Build succeeded!")

    // At t=4s the old template timer fires — must NOT cut short the new 6s bubble.
    act(() => jest.advanceTimersByTime(3000))
    expect(usePetStore.getState().bubble?.text).toBe("Build succeeded!")

    // At t=7s (full 6s after authored bubble) it clears cleanly.
    act(() => jest.advanceTimersByTime(3000))
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("attaches an open-attention action to attention waiting bubbles (F6)", () => {
    renderHook(() => usePetBubbles(true))
    act(() =>
      emitPetEvent({
        source: "attention",
        kind: "waiting",
        at: 10,
        meta: {
          pendingCount: 1,
          attentionTarget: { source: "chat", sessionId: "session-99" },
        },
      })
    )
    expect(usePetStore.getState().bubble?.action).toEqual({
      kind: "open-attention",
      source: "chat",
      sessionId: "session-99",
    })
  })
})
