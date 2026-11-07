import { PLAYBOOK_FLOW_LIMITS, decodeStepUse, playbookFlowSchema } from "./flow-schema"

describe("decodeStepUse", () => {
  it.each([
    ["skill:review-lens", { kind: "skill", skillId: "review-lens" }],
    ["skill:anthropic.code-review", { kind: "skill", skillId: "anthropic.code-review" }],
    ["playbook:debug", { kind: "playbook", skillId: "debug" }],
    [
      "squad:builtin.agentTeam.parallel-review",
      { kind: "squad", templateId: "builtin.agentTeam.parallel-review" },
    ],
    ["squad:my-plugin:team", { kind: "squad", templateId: "my-plugin:team" }],
    ["pattern:adversarial-verify", { kind: "pattern", pattern: "adversarial-verify" }],
    ["approval", { kind: "approval" }],
    ["notify", { kind: "notify" }],
    ["issue.comment", { kind: "issue", operation: "comment" }],
  ])("decodes %s", (uses, expected) => {
    expect(decodeStepUse(uses)).toEqual(expected)
  })

  it.each([
    "pattern:refute-everything",
    "issue.delete",
    "skill:",
    "skill:two words",
    "tool:bash",
    ":review",
    "approve",
  ])("rejects %s", (uses) => {
    expect(decodeStepUse(uses)).toBeNull()
  })
})

describe("playbookFlowSchema", () => {
  const minimal = { version: 1, steps: [{ id: "review", uses: "skill:review" }] }

  it("applies defaults to a minimal flow", () => {
    expect(playbookFlowSchema.parse(minimal)).toEqual({
      version: 1,
      inputs: [],
      steps: [
        {
          id: "review",
          uses: "skill:review",
          with: {},
          needs: [],
          requiresTools: false,
          humanConfirm: false,
        },
      ],
      limits: {},
      outputs: {},
    })
  })

  it("defaults an input to a required variable", () => {
    const flow = playbookFlowSchema.parse({ ...minimal, inputs: [{ name: "target" }] })
    expect(flow.inputs).toEqual([{ name: "target", kind: "variable", required: true }])
  })

  it("rejects unknown fields at every level", () => {
    const result = playbookFlowSchema.safeParse({
      ...minimal,
      title: "x",
      steps: [{ id: "review", uses: "skill:review", requiresTool: true }],
      limits: { maxBudget: 1 },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.filter((issue) => issue.code === "unrecognized_keys")).toHaveLength(
      3
    )
  })

  it("rejects a flow without steps, a bad step id and an out-of-range limit", () => {
    expect(playbookFlowSchema.safeParse({ version: 1, steps: [] }).success).toBe(false)
    expect(
      playbookFlowSchema.safeParse({ version: 1, steps: [{ id: "Review", uses: "notify" }] })
        .success
    ).toBe(false)
    expect(
      playbookFlowSchema.safeParse({
        ...minimal,
        limits: { maxFanout: PLAYBOOK_FLOW_LIMITS.maxCount + 1 },
      }).success
    ).toBe(false)
    expect(playbookFlowSchema.safeParse({ ...minimal, limits: { maxBudgetUsd: 0 } }).success).toBe(
      false
    )
  })
})
