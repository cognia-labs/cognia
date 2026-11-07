import { PLAYBOOK_FLOW_LIMITS, PLAYBOOK_FLOW_PATH } from "./flow-schema"
import { findPlaybookFlowText, parsePlaybookFlow, type PlaybookFlowProblem } from "./parse-flow"

const REVIEW_FLOW = `
version: 1
inputs:
  - name: target
    description: Branch or changeset to review
limits:
  maxSubagents: 12
  maxBudgetUsd: 2.5
steps:
  - id: sweep
    uses: pattern:multi-modal-sweep
    with:
      objective: "Review {{inputs.target}}"
      modalities: [correctness, security, architecture, tests]
  - id: verify
    uses: pattern:adversarial-verify
    needs: [sweep]
    with:
      findings: "{{steps.sweep.output.findings}}"
  - id: verdict
    uses: pattern:synthesize
    needs: [verify]
    with:
      findings: "{{steps.verify.output}}"
outputs:
  report: "{{steps.verdict.output.report}}"
`

function problems(text: string): PlaybookFlowProblem[] {
  const result = parsePlaybookFlow(text)
  if (result.ok) throw new Error("expected problems")
  return result.problems
}

function codes(text: string): string[] {
  return problems(text).map((problem) => `${problem.code} ${problem.pointer}`)
}

describe("parsePlaybookFlow", () => {
  it("parses a valid flow and decodes every step", () => {
    const result = parsePlaybookFlow(REVIEW_FLOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.flow.steps.map((step) => step.use)).toEqual([
      { kind: "pattern", pattern: "multi-modal-sweep" },
      { kind: "pattern", pattern: "adversarial-verify" },
      { kind: "pattern", pattern: "synthesize" },
    ])
    expect(result.flow.limits).toEqual({ maxSubagents: 12, maxBudgetUsd: 2.5 })
    expect(result.flow.inputs).toEqual([
      {
        name: "target",
        kind: "variable",
        required: true,
        description: "Branch or changeset to review",
      },
    ])
    expect(result.flow.outputs).toEqual({ report: "{{steps.verdict.output.report}}" })
  })

  it("reports a file over the size limit before parsing it", () => {
    const text = `version: 1\n# ${"x".repeat(PLAYBOOK_FLOW_LIMITS.maxBytes)}\n`
    expect(codes(text)).toEqual(["flow_too_large "])
  })

  it("refuses duplicate keys", () => {
    expect(codes("version: 1\nversion: 1\nsteps: [{id: a, uses: notify}]\n")).toEqual([
      "flow_key_duplicate ",
    ])
  })

  it("refuses YAML aliases", () => {
    const text = "version: 1\nsteps:\n  - &s {id: a, uses: notify}\n  - *s\n"
    expect(codes(text)).toEqual(["flow_alias_unsupported "])
  })

  it("reports malformed YAML", () => {
    expect(codes("version: 1\nsteps: [\n")[0]).toMatch(/^flow_yaml_invalid/)
  })

  it("reports an unsupported version at /version", () => {
    expect(codes("version: 2\nsteps: [{id: a, uses: notify}]\n")).toEqual([
      "flow_version_unsupported /version",
    ])
  })

  it("points at unknown fields and invalid values", () => {
    expect(
      codes(`
version: 1
steps:
  - id: a
    uses: notify
    requiresTool: true
    humanConfirm: "yes"
`)
    ).toEqual([
      "flow_field_invalid /steps/0/humanConfirm",
      "flow_field_unknown /steps/0/requiresTool",
    ])
  })

  it("reports duplicate inputs and a default on a sensitive input", () => {
    expect(
      codes(`
version: 1
inputs:
  - name: token
    kind: sensitive
    default: abc
  - name: token
steps: [{id: a, uses: notify}]
`)
    ).toEqual([
      "flow_input_sensitive_default /inputs/0/default",
      "flow_input_duplicate /inputs/1/name",
    ])
  })

  it("reports duplicate step ids, unknown uses and unknown needs", () => {
    expect(
      codes(`
version: 1
steps:
  - id: a
    uses: pattern:refute-everything
  - id: a
    uses: notify
    needs: [ghost]
`)
    ).toEqual([
      "flow_step_uses_unknown /steps/0/uses",
      "flow_step_duplicate /steps/1/id",
      "flow_step_needs_unknown /steps/1/needs/0",
    ])
  })

  it("reports a cycle once, including a step that needs itself", () => {
    expect(
      codes(`
version: 1
steps:
  - {id: a, uses: notify, needs: [c]}
  - {id: b, uses: notify, needs: [a]}
  - {id: c, uses: notify, needs: [b]}
  - {id: d, uses: notify, needs: [d]}
`)
    ).toEqual(["flow_step_needs_cycle /steps/1/needs", "flow_step_needs_cycle /steps/3/needs"])
    expect(problems("version: 1\nsteps:\n  - {id: d, uses: notify, needs: [d]}\n")[0].message).toBe(
      "steps form a cycle: d → d"
    )
  })

  it("checks references inside nested step parameters", () => {
    expect(
      codes(`
version: 1
inputs: [{name: target}]
steps:
  - id: a
    uses: notify
  - id: b
    uses: notify
    with:
      message:
        title: "{{inputs.missing}}"
        lines: ["{{steps.ghost.output}}", "{{steps.a.output}}", "{{env.HOME}}"]
`)
    ).toEqual([
      "flow_reference_input_unknown /steps/1/with/message/title",
      "flow_reference_step_unknown /steps/1/with/message/lines/0",
      "flow_reference_step_not_ancestor /steps/1/with/message/lines/1",
      "flow_reference_invalid /steps/1/with/message/lines/2",
    ])
  })

  it("accepts a transitive ancestor and lets outputs read any step", () => {
    const result = parsePlaybookFlow(`
version: 1
steps:
  - {id: a, uses: notify}
  - {id: b, uses: notify, needs: [a]}
  - id: c
    uses: notify
    needs: [b]
    with: {text: "{{ steps.a.output.text }}"}
  - {id: d, uses: notify}
outputs:
  first: "{{steps.d.output}}"
`)
    expect(result.ok).toBe(true)
  })

  it("allows {{item}} only inside a forEach step, and not in its own list", () => {
    expect(
      codes(`
version: 1
steps:
  - id: find
    uses: pattern:multi-modal-sweep
  - id: check
    uses: skill:verify-one
    needs: [find]
    forEach: "{{item}}"
    with: {finding: "{{item}}"}
  - id: report
    uses: notify
    needs: [check]
    with: {text: "{{item}}"}
`)
    ).toEqual([
      "flow_reference_item_outside_for_each /steps/1/forEach",
      "flow_reference_item_outside_for_each /steps/2/with/text",
    ])
  })

  it("escapes pointer tokens", () => {
    expect(
      codes(`
version: 1
steps:
  - id: a
    uses: notify
    with: {"a/b~c": "{{nope}}"}
`)
    ).toEqual(["flow_reference_invalid /steps/0/with/a~1b~0c"])
  })
})

describe("findPlaybookFlowText", () => {
  it("returns the text at references/flow.yaml", () => {
    expect(
      findPlaybookFlowText([
        { path: "references/notes.md", content: "notes" },
        { path: PLAYBOOK_FLOW_PATH, content: "version: 1", encoding: "utf-8" },
      ])
    ).toBe("version: 1")
  })

  it("ignores a root-level flow.yaml and a binary resource", () => {
    expect(findPlaybookFlowText([{ path: "flow.yaml", content: "version: 1" }])).toBeUndefined()
    expect(
      findPlaybookFlowText([
        { path: PLAYBOOK_FLOW_PATH, content: "dmVyc2lvbjog", encoding: "base64" },
      ])
    ).toBeUndefined()
  })
})
