import type { EditorState } from "./store"
import {
  WORKFLOW_QUICK_ACTION_PROMPTS,
  buildQuickActionPrompt,
  buildSelectionReferencePrompt,
  buildSkillDraftPrompt,
} from "./quick-action-prompts"
import {
  __overridePromptsForTests,
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import { validatePromptBody } from "@/lib/prompts/template"
import type { PromptDefinitionV1 } from "@/lib/prompts/types"

function makeState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    baseWorkflow: { id: "wf_x", name: "Test wf" } as EditorState["baseWorkflow"],
    selectedNodeIds: [],
    selectedEdgeIds: [],
    dirty: false,
    savedAt: null,
    runStatusByStepId: {},
    validationByStepId: {},
    lastRunByStepId: {},
    ...overrides,
  } as unknown as EditorState
}

function makeNode(id: string, kind: string, label: string, params: Record<string, unknown> = {}) {
  return {
    id,
    type: "workflowNode" as const,
    position: { x: 0, y: 0 },
    data: { kind, label, params, typeVersion: 1 },
  } as unknown as EditorState["nodes"][number]
}

describe("buildQuickActionPrompt", () => {
  describe("validate", () => {
    it("returns the 'no issues' prompt when the graph is empty", () => {
      const out = buildQuickActionPrompt("validate", makeState())
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/validate/)
      expect(out).toContain("no validation errors")
    })

    it("includes branch params errors in the validate prompt", () => {
      const node = makeNode("branch", "flow.branch", "Branch", { condition: "true" })
      node.data.typeVersion = 2
      const prompt = buildQuickActionPrompt("validate", makeState({ nodes: [node] }))
      expect(prompt).toContain("conditions")
      expect(prompt).not.toContain("no validation errors")
    })

    it("includes the issue summary when nodes have invalid params", () => {
      // A cron-trigger node with an empty cron expression — params schema
      // requires `cron`, so `validateAllNodes` surfaces an issue under n_a.
      const nodes = [makeNode("n_a", "trigger.cron", "Daily", { cron: "" })]
      const out = buildQuickActionPrompt("validate", makeState({ nodes }))
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/validate/)
      expect(out).toContain("n_a")
      expect(out).toContain("issue")
    })
  })

  describe("explain", () => {
    it("falls back to a 'no selection' hint when nothing is picked", () => {
      const out = buildQuickActionPrompt("explain", makeState())
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/explain/)
      expect(out).toMatch(/no nodes are selected/i)
    })

    it("lists each selected node with id, label, kind", () => {
      const nodes = [
        makeNode("n_a", "ai.prompt", "Summarize"),
        makeNode("n_b", "email.send", "Notify user"),
      ]
      const out = buildQuickActionPrompt(
        "explain",
        makeState({ nodes, selectedNodeIds: ["n_a", "n_b"] })
      )
      expect(out).not.toBeNull()
      expect(out).toContain("`n_a`")
      expect(out).toContain("Summarize")
      expect(out).toContain("`ai.prompt`")
      expect(out).toContain("`n_b`")
      expect(out).toContain("Notify user")
      expect(out).toContain("`email.send`")
    })

    it("skips selected ids that aren't in the node list (stale selection)", () => {
      const nodes = [makeNode("n_a", "ai.prompt", "Summarize")]
      const out = buildQuickActionPrompt(
        "explain",
        makeState({ nodes, selectedNodeIds: ["n_a", "ghost"] })
      )
      expect(out).not.toBeNull()
      expect(out).toContain("`n_a`")
      expect(out).not.toContain("`ghost`")
    })
  })

  describe("suggest", () => {
    it("uses an empty-selection phrasing when nothing is picked", () => {
      const nodes = [makeNode("n_a", "ai.prompt", "Summarize")]
      const out = buildQuickActionPrompt("suggest", makeState({ nodes }))
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/suggest-next/)
      expect(out).toMatch(/no selection/i)
      expect(out).toContain("1 node")
    })

    it("includes selected nodes as anchor context", () => {
      const nodes = [
        makeNode("n_a", "ai.prompt", "Summarize"),
        makeNode("n_b", "email.send", "Notify"),
      ]
      const out = buildQuickActionPrompt("suggest", makeState({ nodes, selectedNodeIds: ["n_a"] }))
      expect(out).not.toBeNull()
      expect(out).toContain("`n_a`")
      expect(out).toContain("Summarize")
      expect(out).toMatch(/next node/i)
    })
  })

  it("returns null for an unknown quick-action kind", () => {
    // @ts-expect-error testing the defensive branch
    const out = buildQuickActionPrompt("frobnicate", makeState())
    expect(out).toBeNull()
  })
})

describe("buildSelectionReferencePrompt", () => {
  it("returns null when nothing is selected, so the caller just opens the panel", () => {
    expect(buildSelectionReferencePrompt(makeState())).toBeNull()
  })

  it("names every selected node so the request is scoped to them", () => {
    // Without this every request is whole-graph, so changing three nodes in a
    // fifty-node workflow starts with describing which three.
    const out = buildSelectionReferencePrompt(
      makeState({
        nodes: [makeNode("n1", "ai.prompt", "Draft"), makeNode("n2", "flow.branch", "Route")],
        selectedNodeIds: ["n1", "n2"],
      })
    )
    expect(out).toContain("**2 node(s)**")
    expect(out).toContain("`n1`")
    expect(out).toContain("Draft")
    expect(out).toContain("`n2`")
    expect(out).toContain("ai.prompt")
    expect(out).toContain("Scope every proposal that follows to these nodes")
  })

  it("skips a selected id that is no longer on the canvas", () => {
    const out = buildSelectionReferencePrompt(
      makeState({ nodes: [makeNode("n1", "ai.prompt", "Draft")], selectedNodeIds: ["n1", "gone"] })
    )
    expect(out).toContain("`n1`")
    expect(out).not.toContain("`gone`")
  })
})

describe("quick-action Prompt Center entries (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  function override(promptId: string, revisionId: string, body: string) {
    return {
      bindingId: `pob-${revisionId}`,
      promptId,
      scope: "account" as const,
      targetId: "",
      revisionId,
      body,
      contractVersion: 1,
    }
  }

  it("sends published wording with the graph data rendered in", () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        override(
          WORKFLOW_QUICK_ACTION_PROMPTS.explain.id,
          "por-qa-explain",
          "/explain\nExplain these {{count}}:{{nodes}}"
        ),
        override(
          WORKFLOW_QUICK_ACTION_PROMPTS.suggestUnselected.id,
          "por-qa-suggest",
          "/suggest-next\n{{nodeCount}} nodes, {{edgeCount}} edges. One idea, please."
        ),
      ])
    )
    const nodes = [makeNode("n1", "ai.prompt", "Summarize")]
    expect(buildQuickActionPrompt("explain", makeState({ nodes, selectedNodeIds: ["n1"] }))).toBe(
      "/explain\nExplain these 1:\n- `n1` — **Summarize** (kind: `ai.prompt`)"
    )
    expect(buildQuickActionPrompt("suggest", makeState({ nodes }))).toBe(
      "/suggest-next\n1 nodes, 0 edges. One idea, please."
    )
  })

  it("keeps the shipped layout when a selected id is missing from the graph", () => {
    const out = buildSelectionReferencePrompt(makeState({ selectedNodeIds: ["gone"] }))
    expect(out).toBe(
      [
        "I have **1 node(s)** selected on the canvas and want to work on just those:",
        "",
        "",
        "Read them, tell me in one or two sentences what this part of the graph does, then ask me what I want changed.",
        "Scope every proposal that follows to these nodes and their edges unless I say otherwise.",
      ].join("\n")
    )
  })
})

/** A contract-valid override body, unique to the slot. */
function sentinelBody(def: PromptDefinitionV1): string {
  return [
    `SENTINEL-${def.id}`,
    ...def.variables.filter((spec) => spec.required).map((spec) => `{{${spec.name}}}`),
    ...def.requiredFragments,
  ].join(" ")
}

/** The longest literal line of the shipped body, placeholders cut out. */
function shippedSnippet(def: PromptDefinitionV1): string {
  return def.defaultBody
    .split(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}|\n/)
    .map((part) => part.trim())
    .reduce((longest, part) => (part.length > longest.length ? part : longest), "")
}

describe("quick-action overrides reach the Copilot message (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  const picked = makeState({
    nodes: [makeNode("n1", "ai.prompt", "Summarize"), makeNode("n2", "email.send", "Notify")],
    selectedNodeIds: ["n1"],
  })
  // Each member's builder call, with inputs that reach that member's branch.
  const drive = {
    selectionReference: () => buildSelectionReferencePrompt(picked),
    validateClean: () => buildQuickActionPrompt("validate", makeState()),
    validateIssues: () =>
      buildQuickActionPrompt(
        "validate",
        makeState({ nodes: [makeNode("n_a", "trigger.cron", "Daily", { cron: "" })] })
      ),
    explainEmpty: () => buildQuickActionPrompt("explain", makeState()),
    explain: () => buildQuickActionPrompt("explain", picked),
    suggest: () => buildQuickActionPrompt("suggest", picked),
    suggestUnselected: () => buildQuickActionPrompt("suggest", makeState({ nodes: picked.nodes })),
    draftFromSkill: () => buildSkillDraftPrompt({ name: "Release notes", content: "1. Read." }),
  } satisfies Record<keyof typeof WORKFLOW_QUICK_ACTION_PROMPTS, () => string | null>

  it.each(Object.entries(WORKFLOW_QUICK_ACTION_PROMPTS))(
    "sends the published %s override instead of the shipped text",
    (key, def) => {
      const send = (drive as Record<string, (() => string | null) | undefined>)[key]
      expect(send).toBeDefined()

      // Without an override the builder sends this slot's shipped text.
      __overridePromptsForTests([])
      const snippet = shippedSnippet(def)
      expect(send!()).toContain(snippet)

      const body = sentinelBody(def)
      expect(validatePromptBody(def, body)).toEqual([])
      __overridePromptsForTests([[def, body]])
      const sent = send!()
      expect(sent).toContain(`SENTINEL-${def.id}`)
      expect(sent).not.toContain(snippet)
    }
  )
})

describe("buildSkillDraftPrompt", () => {
  it("asks the Copilot to draft the graph from the skill's text", () => {
    const prompt = buildSkillDraftPrompt({
      name: "Release notes",
      content: "1. Read the merged PRs.\n2. Group them by area.",
    })
    expect(prompt).toContain("Draft this workflow from the skill **Release notes** below.")
    expect(prompt).toContain("`wf_*` tools")
    expect(prompt.endsWith("1. Read the merged PRs.\n2. Group them by area.")).toBe(true)
  })

  it("is a registered Prompt Center entry", () => {
    expect(WORKFLOW_QUICK_ACTION_PROMPTS.draftFromSkill.id).toBe(
      "developer.workflow.quick-action.draft-from-skill"
    )
  })
})
