import { validateWorkflow } from "@/lib/workflow/definition/validate"
import { validateNodeParams } from "@/lib/workflow/nodes/validate-params"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowNode,
  type WorkflowNodeKind,
} from "@/types/workflow/visual"

import {
  PLAYBOOK_COMPILE_MAX_NODES,
  PLAYBOOK_COMPILER_VERSION,
  PLAYBOOK_OUTPUT_NODE_ID,
  PLAYBOOK_TRIGGER_NODE_ID,
  compilePlaybook,
  playbookWorkflowId,
  type CompilePlaybookOptions,
  type PlaybookSource,
} from "./compile"
import { parsePlaybookFlow } from "./parse-flow"

function source(skillId: string, flowText: string, name = skillId): PlaybookSource {
  const parsed = parsePlaybookFlow(flowText)
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems))
  return { skillId, name, flowText, flow: parsed.flow }
}

function options(library: PlaybookSource[] = []): CompilePlaybookOptions {
  return {
    now: 1_000,
    settings: DEFAULT_WORKFLOW_SETTINGS,
    resolvePlaybook: (id) => library.find((p) => p.skillId === id),
  }
}

async function compiled(
  playbook: PlaybookSource,
  library: PlaybookSource[] = []
): Promise<{ workflow: VisualWorkflow; dormant: unknown[] }> {
  const result = await compilePlaybook(playbook, options(library))
  if (!result.ok) throw new Error(JSON.stringify(result.problems))
  return result
}

async function problems(playbook: PlaybookSource, library: PlaybookSource[] = []) {
  const result = await compilePlaybook(playbook, options(library))
  if (result.ok) throw new Error("expected problems")
  return result.problems.map((p) => `${p.code} ${p.skillId}${p.pointer}`)
}

function node(workflow: VisualWorkflow, id: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`no node ${id} in ${workflow.nodes.map((n) => n.id).join(", ")}`)
  return found
}

function edgesOf(workflow: VisualWorkflow): string[] {
  return workflow.edges.map(
    (e) => `${e.source}${e.sourceHandle ? `[${e.sourceHandle}]` : ""} → ${e.target}`
  )
}

/** The compiled graph must pass the workflow engine's own checks. */
function expectValid(workflow: VisualWorkflow, dormantNodeIds: string[] = []) {
  const validation = validateWorkflow(workflow)
  expect(validation.ok ? [] : validation.errors).toEqual([])
  for (const n of workflow.nodes) {
    if (dormantNodeIds.includes(n.id)) continue
    const result = validateNodeParams(n.type as WorkflowNodeKind, n.data.params, n.typeVersion)
    expect({ id: n.id, summary: result.summary }).toEqual({ id: n.id, summary: [] })
  }
}

const REVIEW = `
version: 1
inputs:
  - name: target
    description: Branch to review
limits:
  maxBudgetUsd: 2.5
  maxFanout: 3
steps:
  - id: scan
    uses: skill:code-scan
    requiresTools: true
    with:
      prompt: "Scan {{inputs.target}} for defects"
      outputSchema: { type: object, properties: { findings: { type: array } } }
      focus: [security, tests]
  - id: summarize
    uses: skill:summarize
    needs: [scan]
    with:
      findings: "{{steps.scan.output.findings}}"
      maxTurns: 4
  - id: tell
    uses: notify
    needs: [summarize]
    with:
      title: Review done
      body: "{{steps.summarize.output}}"
outputs:
  report: "{{steps.summarize.output}}"
`

describe("compilePlaybook", () => {
  it("lowers skill steps to agent turns and wires them in dependency order", async () => {
    const { workflow, dormant } = await compiled(source("review", REVIEW, "Change review"))

    expect(workflow.nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      `${PLAYBOOK_TRIGGER_NODE_ID}:trigger.manual`,
      "pb_scan:action.agent.turn",
      "pb_summarize:action.agent.turn",
      "pb_tell:action.notify.send",
      `${PLAYBOOK_OUTPUT_NODE_ID}:io.output`,
    ])
    expect(edgesOf(workflow)).toEqual([
      "pb__trigger → pb_scan",
      "pb_scan → pb_summarize",
      "pb_summarize → pb_tell",
      "pb_tell → pb__output",
    ])
    expect(node(workflow, "pb_scan").data.params).toEqual({
      prompt:
        'Scan {{ $trigger.payload.target }} for defects\n\nInputs:\n- focus: ["security","tests"]',
      skillIds: ["code-scan"],
      outputSchema: { type: "object", properties: { findings: { type: "array" } } },
      toolsEnabled: true,
      requireTools: true,
    })
    expect(node(workflow, "pb_summarize").data.params).toEqual({
      prompt:
        "Run the \"summarize\" skill.\n\nInputs:\n- findings: {{ $nodes['pb_scan'].object.findings }}",
      skillIds: ["summarize"],
      maxTurns: 4,
    })
    expect(node(workflow, "pb_tell").data.params).toEqual({
      title: "Review done",
      body: "{{ $nodes['pb_summarize'].text }}",
    })
    expect(node(workflow, PLAYBOOK_OUTPUT_NODE_ID).data.params).toEqual({
      value: { report: "{{ $nodes['pb_summarize'].text }}" },
    })
    expect(dormant).toEqual([])
    expectValid(workflow)
  })

  it("writes a read-only derived workflow with the limits as settings", async () => {
    const { workflow } = await compiled(source("review", REVIEW, "Change review"))

    expect(workflow.id).toBe(playbookWorkflowId("review"))
    expect(workflow.readOnly).toBe(true)
    expect(workflow.derivedFrom).toEqual({
      kind: "playbook",
      skillId: "review",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      compilerVersion: PLAYBOOK_COMPILER_VERSION,
      compiledAt: 1_000,
    })
    expect(workflow.schemaVersion).toBe(2)
    expect(workflow.name).toBe("Change review")
    expect(workflow.settings.maxCostUsd).toBe(2.5)
    expect(workflow.settings.maxConcurrency).toBe(3)
    expect(workflow.settings.riskGating).toBe(true)
    const inputSchema = {
      type: "object",
      properties: { target: { type: "string", description: "Branch to review" } },
      required: ["target"],
    }
    expect(workflow.interface).toEqual({ inputSchema })
    expect(node(workflow, PLAYBOOK_TRIGGER_NODE_ID).data.params).toEqual({ inputSchema })
  })

  it("is deterministic and hashes the flow text", async () => {
    const first = await compiled(source("review", REVIEW))
    const second = await compiled(source("review", REVIEW))
    expect(second.workflow).toEqual(first.workflow)

    const edited = await compiled(source("review", `${REVIEW}\n# reworded\n`))
    expect(edited.workflow.derivedFrom?.contentHash).not.toBe(
      first.workflow.derivedFrom?.contentHash
    )
    const renamed = await compiled(source("review", REVIEW, "Other name"))
    expect(renamed.workflow.derivedFrom?.contentHash).not.toBe(
      first.workflow.derivedFrom?.contentHash
    )
  })

  it("lays nodes out in columns by depth", async () => {
    const { workflow } = await compiled(source("review", REVIEW))
    expect(workflow.nodes.map((n) => n.position.x)).toEqual([0, 360, 720, 1080, 1440])
  })

  it("puts an approval in front of a humanConfirm step and leaves approvals through approved", async () => {
    const { workflow } = await compiled(
      source(
        "release",
        `
version: 1
steps:
  - id: gate
    uses: approval
    with: { title: Ship it?, message: Release now }
  - id: publish
    uses: skill:publish
    needs: [gate]
    humanConfirm: true
  - id: done
    uses: notify
    needs: [publish]
`
      )
    )

    expect(edgesOf(workflow)).toEqual([
      "pb__trigger → pb_gate",
      "pb_gate[approved] → pb_publish__confirm",
      "pb_publish__confirm[approved] → pb_publish",
      "pb_publish → pb_done",
    ])
    expect(node(workflow, "pb_gate").data.params).toEqual({
      title: "Ship it?",
      message: "Release now",
    })
    expect(node(workflow, "pb_publish__confirm").type).toBe("action.approval.request")
    expect(node(workflow, "pb_done").data.params).toEqual({ title: "done" })
    expectValid(workflow)
  })

  it("wraps a forEach step in a loop container whose output is the list of results", async () => {
    const { workflow } = await compiled(
      source(
        "verify",
        `
version: 1
limits: { maxFanout: 100 }
steps:
  - id: find
    uses: skill:find
    with: { outputSchema: { type: object } }
  - id: check
    uses: skill:check-one
    needs: [find]
    forEach: "{{steps.find.output.findings}}"
    with:
      prompt: "Check {{item}}"
  - id: file
    uses: issue.create
    needs: [check]
    with:
      title: Findings
      description: "{{steps.check.output}}"
`
      )
    )

    expect(node(workflow, "pb_check")).toMatchObject({
      type: "flow.loop",
      typeVersion: 2,
      data: {
        params: {
          mode: "forEach",
          source: "{{ $nodes['pb_find'].object.findings }}",
          output: "{{ $node['pb_check__body'].text }}",
          iterationConcurrency: 64,
        },
      },
    })
    expect(node(workflow, "pb_check__body")).toMatchObject({
      type: "action.agent.turn",
      parentId: "pb_check",
      data: { label: "check (each)", params: { prompt: "Check {{ $item }}" } },
    })
    expect(node(workflow, "pb_file").data.params).toEqual({
      title: "Findings",
      description: "{{ $nodes['pb_check'].items }}",
    })
    expect(edgesOf(workflow)).toEqual([
      "pb__trigger → pb_find",
      "pb_find → pb_check",
      "pb_check → pb_file",
    ])
    expectValid(workflow)
  })

  it("marks pattern and squad steps dormant until the pattern core lands", async () => {
    const { workflow, dormant } = await compiled(
      source(
        "sweep",
        `
version: 1
steps:
  - id: sweep
    uses: pattern:multi-modal-sweep
    with: { modalities: [correctness, security] }
  - id: team
    uses: squad:fix-team
    needs: [sweep]
`,
        "Sweep"
      )
    )

    expect(node(workflow, "pb_sweep")).toMatchObject({
      type: "pattern.multi-modal-sweep",
      data: { params: { modalities: ["correctness", "security"], objective: "Sweep: sweep" } },
    })
    expect(node(workflow, "pb_team")).toMatchObject({
      type: "action.team.run",
      data: { params: { templateId: "fix-team", goal: "Sweep: team" } },
    })
    expect(dormant).toEqual([
      { nodeId: "pb_sweep", skillId: "sweep", stepId: "sweep", reason: "pattern-core-pending" },
      { nodeId: "pb_team", skillId: "sweep", stepId: "team", reason: "squad-template-pending" },
    ])
    // No team: the params themselves refuse to run until F1b.
    expect(
      validateNodeParams("pattern.multi-modal-sweep", node(workflow, "pb_sweep").data.params)
        .hasErrors
    ).toBe(true)
    expectValid(workflow, ["pb_sweep", "pb_team"])
  })

  describe("calling another playbook", () => {
    const DIAGNOSE = source(
      "diagnose",
      `
version: 1
inputs:
  - name: symptom
  - name: depth
    default: shallow
  - name: note
    required: false
steps:
  - id: probe
    uses: skill:probe
    with:
      prompt: "Probe {{inputs.symptom}} ({{inputs.depth}}){{inputs.note}}"
      symptom: "{{inputs.symptom}}"
  - id: explain
    uses: skill:explain
    needs: [probe]
    with: { evidence: "{{steps.probe.output}}" }
outputs:
  cause: "{{steps.explain.output}}"
`
    )

    it("inlines the called playbook and binds its inputs", async () => {
      const caller = source(
        "triage",
        `
version: 1
inputs: [{ name: ticket }]
steps:
  - id: read
    uses: skill:read-ticket
    with: { outputSchema: { type: object } }
  - id: dig
    uses: playbook:diagnose
    needs: [read]
    with:
      symptom: "{{steps.read.output.symptom}}"
  - id: report
    uses: notify
    needs: [dig]
    with:
      title: "Cause of {{inputs.ticket}}"
      body: "{{steps.dig.output.cause}}"
`
      )
      const { workflow } = await compiled(caller, [DIAGNOSE])

      expect(workflow.nodes.map((n) => n.id)).toEqual([
        PLAYBOOK_TRIGGER_NODE_ID,
        "pb_read",
        "pb_dig__probe",
        "pb_dig__explain",
        "pb_dig",
        "pb_report",
      ])
      expect(node(workflow, "pb_dig__probe").data.params).toEqual({
        prompt:
          "Probe {{ $nodes['pb_read'].object.symptom }} (shallow)\n\nInputs:\n- symptom: {{ $nodes['pb_read'].object.symptom }}",
        skillIds: ["probe"],
      })
      expect(node(workflow, "pb_dig").data.params).toEqual({
        value: { cause: "{{ $nodes['pb_dig__explain'].text }}" },
      })
      expect(node(workflow, "pb_report").data.params).toEqual({
        title: "Cause of {{ $trigger.payload.ticket }}",
        body: "{{ $nodes['pb_dig'].value.cause }}",
      })
      expect(edgesOf(workflow)).toEqual([
        "pb__trigger → pb_read",
        "pb_read → pb_dig__probe",
        "pb_dig__probe → pb_dig__explain",
        "pb_dig__explain → pb_dig",
        "pb_dig → pb_report",
      ])
      expectValid(workflow)
    })

    it("substitutes a typed value for an input that is a whole reference", async () => {
      const callee = source(
        "count",
        `
version: 1
inputs: [{ name: limit }]
steps:
  - id: list
    uses: issue.list
    with: { limit: "{{inputs.limit}}" }
`
      )
      const caller = source(
        "outer",
        `
version: 1
steps:
  - id: run
    uses: playbook:count
    with: { limit: 5 }
`
      )
      const { workflow } = await compiled(caller, [callee])
      expect(node(workflow, "pb_run__list").data.params).toEqual({ limit: 5 })
    })

    it("hashes the called playbook too", async () => {
      const caller = source(
        "outer",
        "version: 1\nsteps:\n  - id: dig\n    uses: playbook:diagnose\n    with: { symptom: x }\n"
      )
      const before = await compiled(caller, [DIAGNOSE])
      const changed = { ...DIAGNOSE, flowText: `${DIAGNOSE.flowText}\n# edited\n` }
      const after = await compiled(caller, [changed])
      expect(after.workflow.derivedFrom?.contentHash).not.toBe(
        before.workflow.derivedFrom?.contentHash
      )
    })

    it("reports unknown, cyclic and badly bound playbook calls", async () => {
      expect(
        await problems(source("outer", "version: 1\nsteps:\n  - id: a\n    uses: playbook:ghost\n"))
      ).toEqual(["compile_playbook_unknown outer/steps/0/uses"])

      const ping = source("ping", "version: 1\nsteps:\n  - id: a\n    uses: playbook:pong\n")
      const pong = source("pong", "version: 1\nsteps:\n  - id: b\n    uses: playbook:ping\n")
      expect(await problems(ping, [pong])).toEqual(["compile_playbook_cycle pong/steps/0/uses"])

      expect(
        await problems(
          source(
            "outer",
            "version: 1\nsteps:\n  - id: a\n    uses: playbook:diagnose\n    with: { symptoms: x }\n"
          ),
          [DIAGNOSE]
        )
      ).toEqual([
        "compile_playbook_input_unknown outer/steps/0/with/symptoms",
        "compile_playbook_input_missing outer/steps/0/with",
      ])

      expect(
        await problems(
          source(
            "outer",
            `
version: 1
steps:
  - id: list
    uses: issue.list
  - id: each
    uses: playbook:diagnose
    needs: [list]
    forEach: "{{steps.list.output.issues}}"
    with: { symptom: "{{item}}" }
`
          ),
          [DIAGNOSE]
        )
      ).toEqual(["compile_playbook_for_each outer/steps/1/forEach"])
    })
  })

  it("refuses a sensitive input, which a workflow run would store", async () => {
    expect(
      await problems(
        source(
          "deploy",
          "version: 1\ninputs:\n  - { name: token, kind: sensitive }\nsteps:\n  - id: a\n    uses: notify\n"
        )
      )
    ).toEqual(["compile_input_sensitive deploy/inputs/0/kind"])
  })

  it("refuses reading a field of a plain-text skill reply", async () => {
    expect(
      await problems(
        source(
          "p",
          `
version: 1
steps:
  - id: a
    uses: skill:a
  - id: b
    uses: notify
    needs: [a]
    with: { body: "{{steps.a.output.findings}}" }
`
        )
      )
    ).toEqual(["compile_reference_unstructured p/steps/1/with/body"])
  })

  it("refuses a graph past the node ceiling", async () => {
    const wide = source(
      "wide",
      `version: 1\nsteps:\n${Array.from({ length: 64 }, (_, i) => `  - { id: s${i}, uses: notify }`).join("\n")}\n`
    )
    const caller = source(
      "outer",
      `version: 1\nsteps:\n${Array.from({ length: 9 }, (_, i) => `  - { id: c${i}, uses: "playbook:wide" }`).join("\n")}\n`
    )
    expect(9 * 65 + 1).toBeGreaterThan(PLAYBOOK_COMPILE_MAX_NODES)
    expect(await problems(caller, [wide])).toEqual(["compile_too_large outer"])
  })
})

describe("playbookWorkflowId", () => {
  it("is stable, readable and keeps ids that sanitise alike apart", () => {
    expect(playbookWorkflowId("change-review")).toBe(playbookWorkflowId("change-review"))
    expect(playbookWorkflowId("change-review")).toMatch(/^wf_playbook_change-review_[0-9a-f]{8}$/)
    expect(playbookWorkflowId("cognia:review")).not.toBe(playbookWorkflowId("cognia_review"))
  })
})
