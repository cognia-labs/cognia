/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import {
  compositionForSession,
  externalSessionLinkForSession,
  useExternalSessionLinkForSession,
  runtimeRefForSession,
  useAgentRuntimeStore,
} from "./agent-runtime-store"
import { BUILTIN_RUNTIME_REF } from "@/lib/ai/agent/runtime-catalog/types"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
// Touch the outer agent barrel so its `export *` lines are covered.
import * as outerAgentBarrel from "./"

it("outer agent barrel re-exports useAgentRuntimeStore", () => {
  expect(outerAgentBarrel.useAgentRuntimeStore).toBe(useAgentRuntimeStore)
})

describe("useAgentRuntimeStore", () => {
  beforeEach(() => {
    // Reset to documented defaults before each test
    useAgentRuntimeStore.setState({
      runtimeRef: BUILTIN_RUNTIME_REF,
      defaultComposition: { presetId: "standard" },
    })
  })

  it("has the documented defaults", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())
    expect(result.current.runtimeRef).toEqual({ kind: "builtin" })
    expect(result.current.defaultComposition).toEqual({ presetId: "standard" })
  })

  it("setRuntimeRef switches lanes", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setRuntimeRef({ kind: "external", agentId: "agent-42" }))
    expect(result.current.runtimeRef).toEqual({ kind: "external", agentId: "agent-42" })

    act(() => result.current.setRuntimeRef(BUILTIN_RUNTIME_REF))
    expect(result.current.runtimeRef).toEqual({ kind: "builtin" })
  })

  it("setModeId maps a flat mode id onto the default composition", () => {
    const { result } = renderHook(() => useAgentRuntimeStore())

    act(() => result.current.setModeId("research"))
    expect(result.current.defaultComposition.presetId).toBe("research")
  })

  it("persists the full host admission stamp", () => {
    const hostRef = {
      kind: "host",
      configId: "eac_1",
      revision: "eacr_1",
      lifecycleGeneration: 2,
      name: "Pi",
    } as const
    act(() => useAgentRuntimeStore.getState().setRuntimeRef(hostRef))
    const stored = JSON.parse(window.localStorage.getItem("cognia-next.agent-runtime") as string)
    expect(stored.state.runtimeRef).toEqual(hostRef)
  })

  it("persists under the documented localStorage key", () => {
    // Trigger a state change to flush the persist middleware
    act(() => useAgentRuntimeStore.getState().setModeId("research"))

    // The persist middleware writes synchronously to localStorage on set.
    const stored = window.localStorage.getItem("cognia-next.agent-runtime")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    expect(parsed.state.defaultComposition.presetId).toBe("research")
    expect(parsed.state).not.toHaveProperty("modeId")
    expect(parsed.version).toBe(3)
  })

  it("maps a legacy permission mode onto the authority axis", () => {
    act(() => useAgentRuntimeStore.getState().setModeId("build"))
    const composition = useAgentRuntimeStore.getState().defaultComposition
    expect(composition.presetId).toBe("standard")
    expect(composition.authority).toBe("acceptEdits")
  })

  it("keeps an axis mode's legacy id on the selection", () => {
    act(() => useAgentRuntimeStore.getState().setModeId("plan"))
    const composition = useAgentRuntimeStore.getState().defaultComposition
    expect(composition).toEqual({ presetId: "standard", authority: "plan", legacyModeId: "plan" })
  })

  it("never elevates an unknown legacy mode", () => {
    act(() => useAgentRuntimeStore.getState().setModeId("mystery-mode"))
    expect(useAgentRuntimeStore.getState().defaultComposition.authority).toBe("default")
  })

  // Regression: the known-id set used to be the built-in catalog only, so every
  // user-authored mode looked like an unrecognised legacy id and collapsed to
  // Standard. The composer showed the custom mode, the settings sheet showed
  // Standard, and the recorded composition agreed with neither.
  it("keeps a user's custom mode as the preset instead of degrading it", () => {
    useCustomModeStore.setState({
      customModes: {
        "my-reviewer": {
          id: "my-reviewer",
          type: "custom",
          name: "My Reviewer",
          description: "Reviews things",
          icon: "Sparkles",
          isBuiltIn: false,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      } as never,
    })

    act(() => useAgentRuntimeStore.getState().setModeId("my-reviewer"))

    expect(useAgentRuntimeStore.getState().defaultComposition.presetId).toBe("my-reviewer")

    useCustomModeStore.setState({ customModes: {} })
  })

  it("scopes a composition to one session without touching the default", () => {
    const store = useAgentRuntimeStore.getState()
    act(() => store.setDefaultComposition({ presetId: "standard" }))
    act(() => store.setSessionComposition("s1", { presetId: "minimal" }))

    expect(compositionForSession("s1").presetId).toBe("minimal")
    // The whole point of per-session scoping: another session is unaffected.
    expect(compositionForSession("s2").presetId).toBe("standard")
    expect(useAgentRuntimeStore.getState().defaultComposition.presetId).toBe("standard")
  })

  it("falls back to the default once a session selection is cleared", () => {
    const store = useAgentRuntimeStore.getState()
    act(() => store.setSessionComposition("s1", { presetId: "minimal" }))
    act(() => store.clearSessionComposition("s1"))
    expect(compositionForSession("s1").presetId).toBe(
      useAgentRuntimeStore.getState().defaultComposition.presetId
    )
  })

  it("treats an unknown session as the default", () => {
    expect(compositionForSession(undefined).presetId).toBe(
      useAgentRuntimeStore.getState().defaultComposition.presetId
    )
  })
})

describe("the lane belongs to the session", () => {
  // The defect this fixes is the one ADR-0117 fixed for the mode and left on
  // the runtime: a single global value retargeted every other conversation,
  // including one mid-turn.
  beforeEach(() => {
    useAgentRuntimeStore.setState({ sessionRuntimeRefs: {} })
    useAgentRuntimeStore.getState().setRuntimeRef(BUILTIN_RUNTIME_REF)
  })

  it("falls back to the app default for a session that never chose", () => {
    expect(runtimeRefForSession("never-chose")).toEqual({ kind: "builtin" })
    expect(runtimeRefForSession(undefined)).toEqual({ kind: "builtin" })
  })

  it("scopes a choice to one session without touching the default or its peers", () => {
    useAgentRuntimeStore.getState().setSessionRuntimeRef("s1", { kind: "external", agentId: "a1" })
    expect(runtimeRefForSession("s1")).toEqual({ kind: "external", agentId: "a1" })
    expect(runtimeRefForSession("s2")).toEqual({ kind: "builtin" })
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual({ kind: "builtin" })
  })

  it("seeds a new session from the default without freezing it there", () => {
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "a1" })
    expect(runtimeRefForSession("fresh")).toEqual({ kind: "external", agentId: "a1" })
    useAgentRuntimeStore.getState().setSessionRuntimeRef("fresh", BUILTIN_RUNTIME_REF)
    expect(runtimeRefForSession("fresh")).toEqual({ kind: "builtin" })
    expect(runtimeRefForSession("other")).toEqual({ kind: "external", agentId: "a1" })
  })

  it("clears an override back to the default", () => {
    useAgentRuntimeStore.getState().setSessionRuntimeRef("s1", { kind: "external", agentId: "a1" })
    useAgentRuntimeStore.getState().clearSessionRuntimeRef("s1")
    expect(runtimeRefForSession("s1")).toEqual({ kind: "builtin" })
  })

  it("leaves the state alone when clearing a session that never chose", () => {
    const before = useAgentRuntimeStore.getState().sessionRuntimeRefs
    useAgentRuntimeStore.getState().clearSessionRuntimeRef("never-chose")
    expect(useAgentRuntimeStore.getState().sessionRuntimeRefs).toBe(before)
  })
})

describe("persisted state from an older version", () => {
  it("has no migrate step, so an older version falls back to the defaults", () => {
    expect(useAgentRuntimeStore.persist.getOptions().migrate).toBeUndefined()
  })
})

describe("device-local external session links", () => {
  beforeEach(() =>
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "builtin" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
  )

  it("publishes native and gateway identities reactively without persisting host-owned ids", () => {
    const store = useAgentRuntimeStore.getState()
    store.setSessionRuntimeRef("chat", { kind: "external", agentId: "pi" })
    const { result } = renderHook(() => useExternalSessionLinkForSession("chat"))
    act(() => store.setSessionExternalLink("chat", { agentId: "pi", sessionId: "native-1" }))
    expect(result.current).toEqual({ agentId: "pi", sessionId: "native-1" })
    act(() =>
      store.setSessionExternalLink("chat", {
        agentId: "pi",
        sessionId: "cognia-gateway:task:session",
      })
    )
    expect(result.current?.sessionId).toBe("cognia-gateway:task:session")
    const saved = JSON.parse(window.localStorage.getItem("cognia-next.agent-runtime")!)
    expect(saved.state).not.toHaveProperty("sessionExternalLinks")
    expect(JSON.stringify(saved)).not.toContain("native-1")
  })

  it("refuses late old-runtime events and clears the link on lane changes", () => {
    const store = useAgentRuntimeStore.getState()
    store.setSessionRuntimeRef("chat", { kind: "external", agentId: "pi" })
    store.setSessionExternalLink("chat", { agentId: "pi", sessionId: "native-1" })
    store.setSessionRuntimeRef("chat", { kind: "external", agentId: "codex" })
    store.setSessionExternalLink("chat", { agentId: "pi", sessionId: "late-pi" })
    expect(externalSessionLinkForSession("chat")).toBeUndefined()
    expect(useAgentRuntimeStore.getState().sessionExternalLinks).toEqual({})
  })

  it("retargets default conversations without touching an explicitly bound conversation", () => {
    const store = useAgentRuntimeStore.getState()
    store.setRuntimeRef({ kind: "external", agentId: "pi" })
    store.setSessionRuntimeRef("pinned", { kind: "external", agentId: "pi" })
    store.setSessionExternalLink("pinned", { agentId: "pi", sessionId: "pinned-native" })
    store.setSessionExternalLink("default", { agentId: "pi", sessionId: "default-native" })
    store.setRuntimeRef({ kind: "external", agentId: "codex" })
    expect(externalSessionLinkForSession("default")).toBeUndefined()
    expect(externalSessionLinkForSession("pinned")?.sessionId).toBe("pinned-native")
    store.clearSessionRuntimeRef("pinned")
    expect(externalSessionLinkForSession("pinned")).toBeUndefined()
  })

  it("does not hydrate another device's accidentally supplied live link", () => {
    const options = useAgentRuntimeStore.persist.getOptions()
    const merged = options.merge?.(
      { sessionExternalLinks: { chat: { agentId: "pi", sessionId: "foreign" } } },
      useAgentRuntimeStore.getState()
    )
    expect(merged?.sessionExternalLinks).toEqual({})
  })
})

it("binds paired-host native links to exact configuration lifecycle without persisting them", () => {
  const store = useAgentRuntimeStore.getState()
  const stamp = { configId: "host-pi", revision: "revision-1", lifecycleGeneration: 1 }
  store.setSessionRuntimeRef("remote-chat", { kind: "host", ...stamp, name: "Pi" })
  store.setSessionExternalLink("remote-chat", {
    agentId: stamp.configId,
    sessionId: "remote-native",
    host: stamp,
  })
  expect(externalSessionLinkForSession("remote-chat")?.sessionId).toBe("remote-native")
  store.setSessionRuntimeRef("remote-chat", {
    kind: "host",
    ...stamp,
    lifecycleGeneration: 2,
    name: "Pi",
  })
  expect(externalSessionLinkForSession("remote-chat")).toBeUndefined()
  store.setSessionExternalLink("remote-chat", {
    agentId: stamp.configId,
    sessionId: "late",
    host: stamp,
  })
  expect(externalSessionLinkForSession("remote-chat")).toBeUndefined()
})
