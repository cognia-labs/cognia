/**
 * @jest-environment jsdom
 */

import { DEFAULT_TEAM_CONFIG } from "@/types/agent/agent-team"

jest.mock("@cognia/logging", () => {
  // Namespace-agnostic on purpose. These mocks used to list the handful of
  // `loggers.*` names the suite happened to reach, so the day an import chain
  // grew a new one the whole suite died at load with
  // "Cannot read properties of undefined (reading 'child')" and zero tests ran.
  // A Proxy answers for any namespace, so graph growth cannot go dark here.
  const child: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  }
  child.child = () => child
  return {
    createLogger: () => child,
    logger: child,
    loggers: new Proxy({} as Record<string, unknown>, { get: () => child }),
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

import {
  activateAgentTeamAccountStorage,
  clearAgentTeamAccountStorage,
  partializeAgentTeamState,
  purgeAgentTeamAccountStorage,
  useAgentTeamStore,
} from "./store"
import { initialState } from "./initial-state"
import { purgeProjectBuckets } from "@/lib/project/project-bucket-purge"

function persistedTeam(id: string, name: string) {
  return {
    id,
    name,
    task: "task",
    config: DEFAULT_TEAM_CONFIG,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

beforeEach(() => {
  localStorage.clear()
  clearAgentTeamAccountStorage()
})

it("registers the live agent-team store with project bucket purge", () => {
  const purge = jest
    .spyOn(useAgentTeamStore.getState(), "purgeProject")
    .mockImplementation(() => {})
  purgeProjectBuckets("project-1")
  expect(purge).toHaveBeenCalledWith("project-1")
  purge.mockRestore()
})

describe("partializeAgentTeamState", () => {
  it("persists only durable team state", () => {
    const state = {
      ...initialState,
      teams: { team_a: persistedTeam("team_a", "Alpha") },
      teammates: { mate_a: { id: "mate_a" } },
      tasks: { task_a: { id: "task_a" } },
      messages: { team_a: [{ id: "msg_a" }] },
      events: { team_a: [{ id: "evt_a" }] },
    } as never

    expect(partializeAgentTeamState(state)).toEqual({
      templates: initialState.templates,
      defaultConfig: initialState.defaultConfig,
      displayMode: initialState.displayMode,
      workspaceTab: initialState.workspaceTab,
      tasksView: initialState.tasksView,
      lastAdapterSyncVersion: initialState.lastAdapterSyncVersion,
    })
  })

  /**
   * Squads, roster and tasks are Dexie's from persist v8 on
   * (`dexie-bridge.ts`). Keeping a copy here as well would leave the subsystem
   * with two durable stores and no rule for which wins, and the localStorage
   * one can be neither workspace-scoped nor synced to a paired device.
   */
  it("leaves the definitions to Dexie rather than keeping a second copy", () => {
    const persisted = partializeAgentTeamState({
      ...initialState,
      teams: { team_a: persistedTeam("team_a", "Alpha") },
      teammates: { mate_a: { id: "mate_a" } },
      tasks: { task_a: { id: "task_a" } },
    } as never)
    expect(persisted).not.toHaveProperty("teams")
    expect(persisted).not.toHaveProperty("teammates")
    expect(persisted).not.toHaveProperty("tasks")
  })
})

describe("agent-team account storage buckets", () => {
  it("activates account-local snapshots without leaking the previous account", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { workspaceTab: "tasks" }, version: 9 })
    )
    localStorage.setItem(
      "cognia-agent-teams:acct_b",
      JSON.stringify({ state: { workspaceTab: "members" }, version: 9 })
    )

    activateAgentTeamAccountStorage("acct_a")
    expect(useAgentTeamStore.getState().workspaceTab).toBe("tasks")

    activateAgentTeamAccountStorage("acct_b")
    expect(useAgentTeamStore.getState().workspaceTab).toBe("members")
  })

  it("clears memory without deleting the active account bucket", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({ state: { workspaceTab: "tasks" }, version: 9 })
    )

    activateAgentTeamAccountStorage("acct_a")
    clearAgentTeamAccountStorage()

    expect(useAgentTeamStore.getState().workspaceTab).toBe(initialState.workspaceTab)
    // The bucket survives. It no longer holds the squads themselves (Dexie does
    // from persist v8), so what proves it was not deleted is that the key is
    // still there with the preferences that remain in it.
    expect(localStorage.getItem("cognia-agent-teams:acct_a")).toContain("defaultConfig")
  })

  it("never reads teams, or a blob written under another version", () => {
    localStorage.setItem(
      "cognia-agent-teams:acct_a",
      JSON.stringify({
        state: { teams: { team_a: persistedTeam("team_a", "Alpha") }, workspaceTab: "tasks" },
        version: 9,
      })
    )
    activateAgentTeamAccountStorage("acct_a")
    expect(useAgentTeamStore.getState().teams).toEqual({})
    expect(useAgentTeamStore.getState().workspaceTab).toBe("tasks")

    localStorage.setItem(
      "cognia-agent-teams:acct_b",
      JSON.stringify({ state: { workspaceTab: "members" }, version: 6 })
    )
    activateAgentTeamAccountStorage("acct_b")
    expect(useAgentTeamStore.getState().workspaceTab).toBe(initialState.workspaceTab)
  })
})

describe("agent-team persisted state", () => {
  it("has no migrate step, so an older version falls back to the defaults", async () => {
    expect(useAgentTeamStore.persist.getOptions().migrate).toBeUndefined()
    localStorage.setItem(
      "cognia-agent-teams",
      JSON.stringify({ version: 6, state: { workspaceTab: "tasks" } })
    )
    await useAgentTeamStore.persist.rehydrate()
    expect(useAgentTeamStore.getState().workspaceTab).toBe(initialState.workspaceTab)
  })

  it("rehydrates without throwing when there is no persisted state", async () => {
    localStorage.clear()
    await expect(useAgentTeamStore.persist.rehydrate()).resolves.not.toThrow()
  })

  it("purges only the requested account bucket", () => {
    localStorage.setItem("cognia-agent-teams:acct_a", "A")
    localStorage.setItem("cognia-agent-teams:acct_b", "B")

    purgeAgentTeamAccountStorage("acct_a")

    expect(localStorage.getItem("cognia-agent-teams:acct_a")).toBeNull()
    expect(localStorage.getItem("cognia-agent-teams:acct_b")).toBe("B")
  })

  it("never adopts the signed-out bucket into an account", () => {
    localStorage.setItem(
      "cognia-agent-teams",
      JSON.stringify({ state: { teams: { signed_out: persistedTeam("signed_out", "Out") } } })
    )

    activateAgentTeamAccountStorage("acct_new")

    expect(localStorage.getItem("cognia-agent-teams")).toContain("signed_out")
    expect(useAgentTeamStore.getState().teams).toEqual({})
    expect(localStorage.getItem("cognia-agent-teams:acct_new")).not.toContain("signed_out")
  })

  it("falls back to empty state for missing and malformed account snapshots", () => {
    activateAgentTeamAccountStorage("acct_empty")
    expect(useAgentTeamStore.getState().teams).toEqual({})

    localStorage.setItem("cognia-agent-teams:acct_bad", "{")
    activateAgentTeamAccountStorage("acct_bad")
    expect(useAgentTeamStore.getState().teams).toEqual({})

    localStorage.setItem("cognia-agent-teams:acct_null", JSON.stringify({ state: null }))
    activateAgentTeamAccountStorage("acct_null")
    expect(useAgentTeamStore.getState().teams).toEqual({})
  })
})

describe("stacked delivery consent (ADR-0239 phase 2)", () => {
  const on = {
    enabled: true,
    stackedPullRequests: true,
    minLayers: 2,
    maxLayers: 10,
    mergeMode: "approved-bottom-up" as const,
  }
  const forged = {
    ...on,
    consent: { by: "local-user" as const, at: 1, repositoryPaths: ["/forged"] },
  }
  const store = () => useAgentTeamStore.getState()

  function team(config: Record<string, unknown>) {
    return store().createTeam({ name: "T", task: "t", config: config as never })
  }

  it("never takes consent from a created team's config", () => {
    const created = team({ workingDir: "/work", githubDeliveryPolicy: forged })
    expect(store().teams[created.id]!.config.githubDeliveryPolicy).toEqual(on)
  })

  it("records a person's consent for the paths bound now, and keeps it through edits", () => {
    const created = team({ workingDir: "/work", githubDeliveryPolicy: on })
    store().consentToStackedDelivery(created.id)
    const consent = store().teams[created.id]!.config.githubDeliveryPolicy?.consent
    expect(consent).toMatchObject({ by: "local-user", repositoryPaths: ["/work"] })

    // An edit carrying another consent keeps the stored one.
    const config = store().teams[created.id]!.config
    store().updateTeamConfig(created.id, { ...config, githubDeliveryPolicy: forged })
    expect(store().teams[created.id]!.config.githubDeliveryPolicy?.consent).toEqual(consent)
    store().updateTeam(created.id, { config: { ...config, maxRetries: 3 } })
    expect(store().teams[created.id]!.config.githubDeliveryPolicy?.consent).toEqual(consent)
    store().upsertTeam({ ...store().teams[created.id]!, name: "Renamed" })
    expect(store().teams[created.id]!.config.githubDeliveryPolicy?.consent).toEqual(consent)

    // Turning it off drops it; a copy starts without it.
    const copy = store().duplicateSquad(created.id, { name: "Copy" })
    expect(copy?.config.githubDeliveryPolicy?.consent).toBeUndefined()
    store().updateTeamConfig(created.id, {
      ...config,
      githubDeliveryPolicy: { ...on, enabled: false },
    })
    expect(store().teams[created.id]!.config.githubDeliveryPolicy?.consent).toBeUndefined()
  })

  it("records nothing while stacked delivery is off, or for a team it does not hold", () => {
    const created = team({ workingDir: "/work" })
    store().consentToStackedDelivery(created.id)
    expect(store().teams[created.id]!.config.githubDeliveryPolicy).toBeUndefined()
    expect(() => store().consentToStackedDelivery("missing")).not.toThrow()
    store().upsertTeam({
      ...store().teams[created.id]!,
      id: "fresh",
      config: { ...store().teams[created.id]!.config, githubDeliveryPolicy: forged },
    })
    expect(store().teams.fresh!.config.githubDeliveryPolicy?.consent).toBeUndefined()
  })
})
