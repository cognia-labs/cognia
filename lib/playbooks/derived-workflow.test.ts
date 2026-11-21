import type { SkillResource } from "@cognia/agent-config-types"

import { PLAYBOOK_FLOW_PATH } from "@/lib/skills/playbook/flow-schema"
import { playbookWorkflowId } from "@/lib/skills/playbook/compile"
import type { VisualWorkflow } from "@/types/workflow/visual"

import {
  MAX_PLAYBOOKS_PER_COMPILE,
  loadFreshWorkflow,
  loadPlaybookSource,
  syncPlaybookWorkflow,
  type PlaybookWorkflowDeps,
} from "./derived-workflow"

interface FakeSkill {
  name: string
  description?: string
  flow?: string
}

function harness(skills: Record<string, FakeSkill>) {
  const rows = new Map<string, VisualWorkflow>()
  let clock = 100
  const deps: PlaybookWorkflowDeps = {
    getSkill: async (id) =>
      skills[id] ? { id, name: skills[id].name, description: skills[id].description } : undefined,
    listResources: async (id): Promise<SkillResource[]> => {
      const flow = skills[id]?.flow
      return flow === undefined
        ? []
        : [{ path: PLAYBOOK_FLOW_PATH, content: flow, kind: "reference" } as SkillResource]
    },
    getWorkflow: async (id) => rows.get(id),
    putDerivedWorkflow: jest.fn(async (workflow: VisualWorkflow) => {
      rows.set(workflow.id, workflow)
      return workflow
    }),
    now: () => clock,
  }
  return { deps, rows, tick: () => (clock += 1) }
}

const FLOW = "version: 1\nsteps:\n  - id: scan\n    uses: skill:scan\n"

describe("loadPlaybookSource", () => {
  it("reads the flow the skill's resources carry", async () => {
    const { deps } = harness({ review: { name: "Review", description: "Reviews", flow: FLOW } })
    const loaded = await loadPlaybookSource("review", deps)
    expect(loaded).toMatchObject({
      status: "ok",
      source: { skillId: "review", name: "Review", description: "Reviews", flowText: FLOW },
    })
  })

  it("tells a missing skill, a plain skill and a broken flow apart", async () => {
    const { deps } = harness({
      plain: { name: "Plain" },
      broken: { name: "B", flow: "version: 2\nsteps: [{ id: a, uses: notify }]\n" },
    })
    expect(await loadPlaybookSource("ghost", deps)).toEqual({ status: "missing" })
    expect(await loadPlaybookSource("plain", deps)).toEqual({ status: "not-a-playbook" })
    expect(await loadPlaybookSource("broken", deps)).toMatchObject({
      status: "invalid",
      problems: [{ code: "flow_version_unsupported" }],
    })
  })
})

describe("syncPlaybookWorkflow", () => {
  it("compiles and stores the derived workflow on first open", async () => {
    const { deps, rows } = harness({ review: { name: "Review", flow: FLOW } })
    const result = await syncPlaybookWorkflow("review", deps)

    expect(result).toMatchObject({ status: "compiled", dormant: [] })
    const stored = rows.get(playbookWorkflowId("review"))
    expect(stored).toMatchObject({
      name: "Review",
      readOnly: true,
      derivedFrom: { kind: "playbook", skillId: "review", compiledAt: 100 },
    })
  })

  it("leaves a current row alone and recompiles when the flow changes", async () => {
    const skills = { review: { name: "Review", flow: FLOW } }
    const { deps, tick } = harness(skills)
    await syncPlaybookWorkflow("review", deps)
    tick()

    const again = await syncPlaybookWorkflow("review", deps)
    expect(again.status).toBe("current")
    expect(deps.putDerivedWorkflow).toHaveBeenCalledTimes(1)

    skills.review.flow = `${FLOW}  - id: tell\n    uses: notify\n    needs: [scan]\n`
    const changed = await syncPlaybookWorkflow("review", deps)
    expect(changed.status).toBe("compiled")
    if (changed.status !== "compiled") return
    expect(changed.workflow.derivedFrom?.compiledAt).toBe(101)
    expect(changed.workflow.nodes.map((n) => n.id)).toContain("pb_tell")
  })

  it("recompiles when a called playbook changes", async () => {
    const skills = {
      outer: { name: "Outer", flow: "version: 1\nsteps:\n  - id: dig\n    uses: playbook:inner\n" },
      inner: { name: "Inner", flow: FLOW },
    }
    const { deps } = harness(skills)
    const first = await syncPlaybookWorkflow("outer", deps)
    expect(first.status).toBe("compiled")
    if (first.status !== "compiled") return
    expect(first.workflow.nodes.map((n) => n.id)).toEqual(["pb__trigger", "pb_dig__scan", "pb_dig"])

    skills.inner.flow = `${FLOW}# reworded\n`
    expect((await syncPlaybookWorkflow("outer", deps)).status).toBe("compiled")
  })

  it("reports the steps a workflow cannot run yet", async () => {
    const { deps } = harness({
      sweep: {
        name: "Sweep",
        flow: "version: 1\nsteps:\n  - id: s\n    uses: pattern:synthesize\n",
      },
    })
    expect(await syncPlaybookWorkflow("sweep", deps)).toMatchObject({
      status: "compiled",
      dormant: [{ nodeId: "pb_s", reason: "pattern-core-pending" }],
    })
  })

  it("passes on why a skill has no workflow", async () => {
    const { deps } = harness({
      plain: { name: "Plain" },
      outer: { name: "Outer", flow: "version: 1\nsteps:\n  - id: dig\n    uses: playbook:plain\n" },
    })
    expect(await syncPlaybookWorkflow("ghost", deps)).toEqual({ status: "missing" })
    expect(await syncPlaybookWorkflow("plain", deps)).toEqual({ status: "not-a-playbook" })
    expect(await syncPlaybookWorkflow("outer", deps)).toMatchObject({
      status: "uncompilable",
      problems: [{ code: "compile_playbook_unknown", skillId: "outer" }],
    })
    expect(deps.putDerivedWorkflow).not.toHaveBeenCalled()
  })

  it("stops loading a call graph past the limit", async () => {
    const skills: Record<string, FakeSkill> = {}
    for (let i = 0; i <= MAX_PLAYBOOKS_PER_COMPILE; i++) {
      skills[`p${i}`] = {
        name: `P${i}`,
        flow:
          i < MAX_PLAYBOOKS_PER_COMPILE
            ? `version: 1\nsteps:\n  - id: next\n    uses: playbook:p${i + 1}\n`
            : FLOW,
      }
    }
    const { deps } = harness(skills)
    expect(await syncPlaybookWorkflow("p0", deps)).toEqual({
      status: "too-many-playbooks",
      limit: MAX_PLAYBOOKS_PER_COMPILE,
    })
  })
})

describe("loadFreshWorkflow", () => {
  it("returns an ordinary workflow as stored without touching any playbook", async () => {
    const { deps, rows } = harness({})
    const plain = {
      id: "wf_plain",
      name: "Plain",
      nodes: [],
      edges: [],
    } as unknown as VisualWorkflow
    rows.set(plain.id, plain)
    expect(await loadFreshWorkflow("wf_plain", deps)).toEqual({
      status: "ready",
      workflow: plain,
      dormant: [],
    })
    expect(deps.putDerivedWorkflow).not.toHaveBeenCalled()
  })

  it("reports a missing row", async () => {
    const { deps } = harness({})
    expect(await loadFreshWorkflow("wf_ghost", deps)).toEqual({ status: "not-found" })
  })

  it("recompiles a derived row whose called playbook changed before handing it out", async () => {
    const skills = {
      outer: { name: "Outer", flow: "version: 1\nsteps:\n  - id: dig\n    uses: playbook:inner\n" },
      inner: { name: "Inner", flow: FLOW },
    }
    const { deps, tick } = harness(skills)
    await syncPlaybookWorkflow("outer", deps)
    tick()
    // The bookmark / library path: only the derived row's id is known.
    skills.inner.flow = `${FLOW}  - id: tell\n    uses: notify\n    needs: [scan]\n`

    const fresh = await loadFreshWorkflow(playbookWorkflowId("outer"), deps)
    expect(fresh.status).toBe("ready")
    if (fresh.status !== "ready") return
    expect(fresh.workflow.nodes.map((n) => n.id)).toContain("pb_dig__tell")
    expect(fresh.workflow.derivedFrom?.compiledAt).toBe(101)
    expect(deps.putDerivedWorkflow).toHaveBeenCalledTimes(2)
  })

  it("passes the dormant steps on so a runner can refuse", async () => {
    const { deps } = harness({
      sweep: {
        name: "Sweep",
        flow: "version: 1\nsteps:\n  - id: s\n    uses: pattern:synthesize\n",
      },
    })
    await syncPlaybookWorkflow("sweep", deps)
    expect(await loadFreshWorkflow(playbookWorkflowId("sweep"), deps)).toMatchObject({
      status: "ready",
      dormant: [{ nodeId: "pb_s", reason: "pattern-core-pending" }],
    })
  })

  it("keeps the stored copy but flags it when the source playbook is gone", async () => {
    const skills: Record<string, FakeSkill> = { review: { name: "Review", flow: FLOW } }
    const { deps } = harness(skills)
    await syncPlaybookWorkflow("review", deps)
    delete skills.review

    const fresh = await loadFreshWorkflow(playbookWorkflowId("review"), deps)
    expect(fresh).toMatchObject({
      status: "source-unavailable",
      problem: { status: "missing" },
      workflow: { id: playbookWorkflowId("review") },
    })
  })
})
