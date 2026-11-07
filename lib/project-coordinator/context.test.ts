import type { ChatSession } from "@cognia/agent-config-types"
import type { ContextTurnContext } from "@/lib/modules/manifest-types"
import type { Project } from "@/types"
import { contributions, resolveCoordinatorTurnSection, type CoordinatorStatusDeps } from "./context"
import { projectRoleToolsApply } from "./config"

// The status contribution reads threads and their pull requests through the
// default deps; the cases that pass their own deps never reach these.
jest.mock("./thread-runtime", () => ({
  listProjectThreads: jest.fn(async () => [
    { id: "t9", title: "Ship docs", createdAt: 1, updatedAt: 1, projectRole: "thread" },
  ]),
}))
jest.mock("@/lib/db/session-pr-observations", () => ({
  listSessionPrObservationsByProject: async () => [],
}))

const deps: CoordinatorStatusDeps = {
  listThreads: jest.fn(async () => [
    { id: "t1", title: "Fix login", createdAt: 1, updatedAt: 1 } as ChatSession,
  ]),
  prStatuses: async () => new Map([["t1", "ci_failed" as const]]),
  threadInput: (thread) => ({ thread, status: "streaming", pendingApprovals: 0 }),
  now: () => 5,
  listSchedules: jest.fn(async () => []),
  markSetupOffered: jest.fn(),
}
// Setup already offered, so these cases see only the status digest.
const on = { coordinator: { enabled: true, setupOfferedAt: 1 } }

describe("projectRoleToolsApply", () => {
  it("needs a role and coordination switched on", () => {
    expect(projectRoleToolsApply({ projectRole: "thread" }, on)).toBe(true)
    expect(projectRoleToolsApply({}, on)).toBe(false)
    expect(
      projectRoleToolsApply({ projectRole: "coordinator" }, { coordinator: { enabled: false } })
    ).toBe(false)
  })
})

describe("resolveCoordinatorTurnSection", () => {
  it("gives the coordinator the live project status", async () => {
    const section = await resolveCoordinatorTurnSection(
      { id: "c", projectRole: "coordinator" },
      on,
      deps
    )
    expect(section).toContain("## Project status")
    expect(section).toContain("- Fix login (t1) — working")
    expect(section).not.toContain("## Project coordinator")
    expect(deps.listThreads).toHaveBeenCalledWith("c")
  })

  it("adds nothing to a thread, an ordinary session or with coordination off", async () => {
    await expect(
      resolveCoordinatorTurnSection({ id: "t", projectRole: "thread" }, on, deps)
    ).resolves.toBeUndefined()
    await expect(resolveCoordinatorTurnSection({ id: "s" }, on, deps)).resolves.toBeUndefined()
    await expect(
      resolveCoordinatorTurnSection({ id: "c", projectRole: "coordinator" }, {}, deps)
    ).resolves.toBeUndefined()
  })

  it("offers setup once, on a new project's first coordinator turn", async () => {
    const fresh = {
      coordinator: { enabled: true },
      roots: [{ id: "r1", path: "/src/app", isPrimary: true }],
    }
    const empty: CoordinatorStatusDeps = {
      ...deps,
      listThreads: jest.fn(async () => []),
      listSchedules: jest.fn(async () => [
        { name: "Nightly deps", status: "active" },
      ]) as unknown as CoordinatorStatusDeps["listSchedules"],
      markSetupOffered: jest.fn(),
    }
    const section = await resolveCoordinatorTurnSection(
      { id: "c", projectRole: "coordinator", projectId: "p1" },
      fresh,
      empty
    )
    expect(section).toContain("## Project status")
    expect(section).toContain("## Project setup (first turn only)")
    expect(section).toContain("- Nightly deps (active)")
    expect(empty.markSetupOffered).toHaveBeenCalledWith("p1", 5)
  })

  it("does not offer setup once threads exist, or when schedules cannot be read", async () => {
    const markSetupOffered = jest.fn()
    const section = await resolveCoordinatorTurnSection(
      { id: "c", projectRole: "coordinator", projectId: "p1" },
      { coordinator: { enabled: true } },
      { ...deps, markSetupOffered }
    )
    expect(section).not.toContain("Project setup")
    expect(markSetupOffered).not.toHaveBeenCalled()

    const failing = await resolveCoordinatorTurnSection(
      { id: "c", projectRole: "coordinator", projectId: "p1" },
      { coordinator: { enabled: true } },
      {
        ...deps,
        listThreads: async () => [],
        listSchedules: async () => {
          throw new Error("db closed")
        },
        markSetupOffered,
      }
    )
    expect(failing).toContain("Project setup")
    expect(markSetupOffered).toHaveBeenCalled()
  })
})

describe("the coordinator's context contributions", () => {
  const byId = (id: string) => contributions.find((c) => c.id === id)!
  const ctx = (
    session: Partial<ChatSession> | null,
    activeProject: Partial<Project> | null
  ): ContextTurnContext => ({
    session: session as ChatSession | null,
    agent: null,
    settings: null,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: activeProject as Project | null,
    query: { text: null, embedding: null },
    hostDeps: {},
    grant: null,
    kernelRetrieval: { identityTexts: [] },
  })
  const coordinated = { coordinator: { enabled: true, goal: "Ship v2", setupOfferedAt: 1 } }

  it("declares the goal as a session section in its slot and the status as a turn section", () => {
    expect(byId("project-goal")).toMatchObject({ cache: "session", slot: "project-goal" })
    expect(byId("status")).toMatchObject({ cache: "turn", deadlineMs: 5_000 })
    expect(byId("status").slot).toBeUndefined()
  })

  it("gives the coordinator and its threads the project goal", async () => {
    for (const projectRole of ["coordinator", "thread"] as const) {
      expect(
        await byId("project-goal").produce(ctx({ id: "c", projectRole }, coordinated))
      ).toEqual({ text: "## Project goal\n\nShip v2" })
    }
  })

  it("gives no goal to an ordinary session, without coordination, or without a goal", async () => {
    const goal = byId("project-goal")
    expect(await goal.produce(ctx({ id: "s" }, coordinated))).toBeNull()
    expect(
      await goal.produce(
        ctx({ id: "c", projectRole: "coordinator" }, { coordinator: { enabled: false, goal: "x" } })
      )
    ).toBeNull()
    expect(
      await goal.produce(
        ctx({ id: "c", projectRole: "coordinator" }, { coordinator: { enabled: true } })
      )
    ).toBeNull()
    expect(await goal.produce(ctx(null, null))).toBeNull()
  })

  it("gives the coordinator its live status and nobody else one", async () => {
    const status = byId("status")
    const section = await status.produce(
      ctx({ id: "c", projectRole: "coordinator", projectId: "p1" }, coordinated)
    )
    expect(section?.text).toContain("## Project status")
    expect(section?.text).toContain("Ship docs (t9)")
    expect(await status.produce(ctx({ id: "t", projectRole: "thread" }, coordinated))).toBeNull()
    expect(await status.produce(ctx({ id: "c", projectRole: "coordinator" }, null))).toBeNull()
    expect(await status.produce(ctx(null, coordinated))).toBeNull()
  })
})
