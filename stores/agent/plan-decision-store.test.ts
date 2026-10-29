/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import {
  usePlanDecisionOwner,
  usePlanDecisionStore,
  type PlanDecisionHandlers,
} from "./plan-decision-store"

function handlers(planId: string): PlanDecisionHandlers {
  return {
    planId,
    approve: jest.fn(),
    keepPlanning: jest.fn(),
    reject: jest.fn(),
    refine: jest.fn(),
    edit: jest.fn().mockResolvedValue(undefined),
    openEditor: jest.fn(),
  }
}

afterEach(() => act(() => usePlanDecisionStore.setState({ owners: {} })))

describe("plan decision store", () => {
  it("registers and unregisters one owner per session", () => {
    const h = handlers("p1")
    let unregister = () => {}
    act(() => {
      unregister = usePlanDecisionStore.getState().register("s1", h)
    })
    expect(usePlanDecisionStore.getState().owners.s1?.handlers).toBe(h)
    act(() => unregister())
    expect(usePlanDecisionStore.getState().owners.s1).toBeUndefined()
  })

  it("does not let a stale unregister drop a newer owner", () => {
    const first = handlers("p1")
    const second = handlers("p2")
    let dropFirst = () => {}
    act(() => {
      dropFirst = usePlanDecisionStore.getState().register("s1", first)
      usePlanDecisionStore.getState().register("s1", second)
    })
    act(() => dropFirst())
    expect(usePlanDecisionStore.getState().owners.s1?.handlers).toBe(second)
  })

  it("mirrors the owner's pending state and keeps it across re-registration", () => {
    act(() => {
      usePlanDecisionStore.getState().register("s1", handlers("p1"))
      usePlanDecisionStore.getState().setPending("s1", { busy: true, refining: true })
    })
    expect(usePlanDecisionStore.getState().owners.s1).toMatchObject({ busy: true, refining: true })
    act(() => {
      usePlanDecisionStore.getState().register("s1", handlers("p1"))
    })
    expect(usePlanDecisionStore.getState().owners.s1?.busy).toBe(true)
  })

  it("ignores pending updates for a session with no owner", () => {
    act(() => usePlanDecisionStore.getState().setPending("nobody", { busy: true, refining: false }))
    expect(usePlanDecisionStore.getState().owners.nobody).toBeUndefined()
  })

  it("resolves the owner only for the plan it decides", () => {
    act(() => {
      usePlanDecisionStore.getState().register("s1", handlers("p1"))
    })
    const { result: same } = renderHook(() => usePlanDecisionOwner("s1", "p1"))
    const { result: other } = renderHook(() => usePlanDecisionOwner("s1", "p2"))
    const { result: none } = renderHook(() => usePlanDecisionOwner(null, "p1"))
    expect(same.current?.handlers.planId).toBe("p1")
    expect(other.current).toBeNull()
    expect(none.current).toBeNull()
  })
})
