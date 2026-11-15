/** @jest-environment jsdom */

import {
  DEFAULT_DETAIL_WIDTH,
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  INCIDENT_STATE_FILTERS,
  resolveLogWorkspaceView,
  resolveTraceSubView,
  useLogWorkspaceStore,
} from "./log-workspace-store"

beforeEach(() => {
  useLogWorkspaceStore.getState().resetWorkspace()
})

describe("log-workspace-store", () => {
  it("opens on the logs channel — the page's actual subject", () => {
    const state = useLogWorkspaceStore.getState()
    expect(state.activeView).toBe("logs")
    expect(state.density).toBe("comfortable")
    expect(state.receiptsOnly).toBe(false)
    expect(state.traceSubView).toBe("explore")
  })

  it("clamps the incident detail pane width", () => {
    useLogWorkspaceStore.getState().setDetailWidth(9999)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(DETAIL_WIDTH_MAX)
    useLogWorkspaceStore.getState().setDetailWidth(1)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(DETAIL_WIDTH_MIN)
  })

  it("updates every channel and filter setter", () => {
    const state = useLogWorkspaceStore.getState()
    state.setActiveView("traces")
    state.setActiveSource("mobile")
    state.setIncidentStateFilter("accepted")
    state.setReceiptsOnly(true)
    state.setDensity("compact")
    state.setTraceSubView("dashboard")
    state.setTraceErrorsOnly(true)

    expect(useLogWorkspaceStore.getState()).toMatchObject({
      activeView: "traces",
      activeSource: "mobile",
      incidentStateFilter: "accepted",
      receiptsOnly: true,
      density: "compact",
      traceSubView: "dashboard",
      traceErrorsOnly: true,
    })
  })

  it("resets all device-local workspace preferences", () => {
    const state = useLogWorkspaceStore.getState()
    state.setActiveView("incidents")
    state.setDetailWidth(600)
    state.setReceiptsOnly(true)
    state.setTraceErrorsOnly(true)
    state.resetWorkspace()

    expect(useLogWorkspaceStore.getState()).toMatchObject({
      activeView: "logs",
      detailWidth: 384,
      receiptsOnly: false,
      activeSource: "all",
      incidentStateFilter: "all",
      traceSubView: "explore",
      traceErrorsOnly: false,
    })
  })
})

describe("resolveLogWorkspaceView", () => {
  it("accepts every channel and rejects anything else", () => {
    expect(resolveLogWorkspaceView("traces")).toBe("traces")
    expect(resolveLogWorkspaceView("diagnostics")).toBe("diagnostics")
    expect(resolveLogWorkspaceView("incidents")).toBe("incidents")
    expect(resolveLogWorkspaceView("health")).toBe("logs")
    expect(resolveLogWorkspaceView(null)).toBe("logs")
    expect(resolveLogWorkspaceView("incidents", "traces")).toBe("incidents")
  })
})

describe("resolveTraceSubView", () => {
  it("accepts the two sub-views and rejects anything else", () => {
    expect(resolveTraceSubView("dashboard")).toBe("dashboard")
    expect(resolveTraceSubView("explore")).toBe("explore")
    expect(resolveTraceSubView("nope")).toBe("explore")
    expect(resolveTraceSubView(null)).toBe("explore")
    expect(resolveTraceSubView(undefined, "dashboard")).toBe("dashboard")
  })
})

describe("incident state vocabulary", () => {
  it("speaks the service's snake_case lifecycle, packaged included", () => {
    expect(INCIDENT_STATE_FILTERS[0]).toBe("all")
    expect(INCIDENT_STATE_FILTERS).toContain("awaiting_consent")
    expect(INCIDENT_STATE_FILTERS).toContain("packaged")
    expect(INCIDENT_STATE_FILTERS).not.toContain("awaitingConsent")
  })
})

describe("errors channel filters", () => {
  it("keeps the filters in the store so a channel switch does not reset them", () => {
    const state = useLogWorkspaceStore.getState()
    state.setCrashSource("persisted")
    state.setCrashLevel("fatal")
    state.setCrashSearch("chunk")
    state.setActiveView("logs")
    state.setActiveView("diagnostics")
    expect(useLogWorkspaceStore.getState()).toMatchObject({
      crashSource: "persisted",
      crashLevel: "fatal",
      crashSearch: "chunk",
    })
    state.resetWorkspace()
    expect(useLogWorkspaceStore.getState()).toMatchObject({
      crashSource: "all",
      crashLevel: "all",
      crashSearch: "",
    })
  })

  it("never persists the search text", () => {
    useLogWorkspaceStore.getState().setCrashSearch("secret-ish query")
    const raw = localStorage.getItem("cognia-log-workspace-v1")
    expect(raw).not.toBeNull()
    expect(raw).not.toContain("secret-ish query")
    expect(JSON.parse(raw as string).version).toBe(4)
  })

  it("exports the shared detail-pane bounds", () => {
    expect(DETAIL_WIDTH_MIN).toBeLessThan(DEFAULT_DETAIL_WIDTH)
    expect(DEFAULT_DETAIL_WIDTH).toBeLessThan(DETAIL_WIDTH_MAX)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(DEFAULT_DETAIL_WIDTH)
  })
})
