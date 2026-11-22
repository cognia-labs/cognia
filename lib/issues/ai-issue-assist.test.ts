import {
  draftIssueDescription,
  improveIssueDescription,
  suggestIssueMetadata,
  suggestIssueRelations,
  suggestIssueTitle,
  ISSUE_DRAFT_PROMPT,
  ISSUE_METADATA_PROMPT,
  ISSUE_RELATIONS_PROMPT,
} from "./ai-issue-assist"
import * as issueAssist from "./ai-issue-assist"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  __overridePromptsForTests,
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"
import type { PromptDefinitionV1 } from "@/lib/prompts/types"

function stubClient(reply: string | ((prompt: string) => string) | Error): {
  client: LlmClient
  calls: { prompt: string; system?: string }[]
} {
  const calls: { prompt: string; system?: string }[] = []
  const client: LlmClient = {
    complete: async (prompt, options) => {
      calls.push({ prompt, system: options?.system })
      if (reply instanceof Error) throw reply
      return typeof reply === "function" ? reply(prompt) : reply
    },
  }
  return { client, calls }
}

const safe = () => true
const unsafe = () => false

describe("draftIssueDescription", () => {
  it("returns cleaned markdown for a title", async () => {
    const { client } = stubClient("```markdown\n## Summary\n\nBody here.\n```")
    const res = await draftIssueDescription("Fix login redirect loop", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "text", text: "## Summary\n\nBody here." })
  })

  it("skips empty titles without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await draftIssueDescription("   ", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips PII titles without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await draftIssueDescription("token abc", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })

  it("skips empty model output", async () => {
    const { client } = stubClient("   ")
    const res = await draftIssueDescription("x", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("includes the project name in the prompt when provided", async () => {
    const { client, calls } = stubClient("body")
    await draftIssueDescription("Fix crash", { client, isPiiSafe: safe, projectName: "Demo" })
    expect(calls[0].prompt).toContain("Project: Demo")
    expect(calls[0].prompt).toContain("Fix crash")
  })
})

describe("improveIssueDescription", () => {
  it("rewrites a draft body", async () => {
    const { client } = stubClient("## Summary\n\nTighter version.")
    const res = await improveIssueDescription("it broke lol", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "text", text: "## Summary\n\nTighter version." })
  })

  it("skips when the rewrite equals the input", async () => {
    const { client } = stubClient("same text")
    const res = await improveIssueDescription("same text", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips PII drafts without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await improveIssueDescription("key=secret", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })
})

describe("suggestIssueMetadata", () => {
  const labelNames = ["bug", "ui", "documentation"]

  it("parses a valid suggestion and canonicalizes label names", async () => {
    const { client } = stubClient('{"priority":"high","labels":["Bug","ui","nonexistent","BUG"]}')
    const res = await suggestIssueMetadata(
      { title: "Crash on save", description: "", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({
      kind: "suggestion",
      suggestion: { priority: "high", labelNames: ["bug", "ui"] },
    })
  })

  it("skips when nothing usable comes back", async () => {
    const { client } = stubClient('{"priority":"not-a-priority","labels":["other"]}')
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips on non-JSON output", async () => {
    const { client } = stubClient("I think it's a bug!")
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips on empty title+description without calling", async () => {
    const { client, calls } = stubClient("{}")
    const res = await suggestIssueMetadata(
      { title: " ", description: " ", labelNames },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("returns a priority-only suggestion when labels do not match", async () => {
    const { client } = stubClient('{"priority":"urgent","labels":[]}')
    const res = await suggestIssueMetadata(
      { title: "prod down", description: "", labelNames: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "suggestion", suggestion: { priority: "urgent", labelNames: [] } })
  })

  it("skips PII content without calling the model", async () => {
    const { client, calls } = stubClient("{}")
    const res = await suggestIssueMetadata(
      { title: "x", description: "secret", labelNames },
      { client, isPiiSafe: unsafe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })
})

describe("suggestIssueTitle", () => {
  it("returns a cleaned single-line title from the body", async () => {
    const { client } = stubClient('"Fix the login redirect loop on mobile.\nExtra ignored line"')
    const res = await suggestIssueTitle("## Steps\n\nOpen login…", {
      client,
      isPiiSafe: safe,
    })
    expect(res).toEqual({ kind: "text", text: "Fix the login redirect loop on mobile" })
  })

  it("skips empty bodies without calling the model", async () => {
    const { client, calls } = stubClient("x")
    const res = await suggestIssueTitle("  ", { client, isPiiSafe: safe })
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips PII bodies", async () => {
    const { client, calls } = stubClient("x")
    const res = await suggestIssueTitle("ssn 123", { client, isPiiSafe: unsafe })
    expect(res).toEqual({ kind: "skipped", reason: "pii" })
    expect(calls).toHaveLength(0)
  })
})

describe("suggestIssueRelations", () => {
  const candidates = [
    { id: "i1", identifier: "DEMO-1", title: "Auth refactor" },
    { id: "i2", identifier: "DEMO-2", title: "Login redirect loop" },
    { id: "i3", identifier: "DEMO-3", title: "Dashboard polish" },
  ]

  it("maps identifiers back to issue ids and drops unknowns", async () => {
    const { client } = stubClient(
      '{"parent": "demo-1", "blockedBy": ["DEMO-2", "NOPE-9"], "duplicates": ["DEMO-3"]}'
    )
    const res = await suggestIssueRelations(
      { title: "Login loop on mobile", description: "", candidates },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({
      kind: "suggestion",
      suggestion: { parentId: "i1", blockedByIds: ["i2"], duplicateIds: ["i3"] },
    })
  })

  it("skips without a model call when there are no candidates", async () => {
    const { client, calls } = stubClient("{}")
    const res = await suggestIssueRelations(
      { title: "x", description: "y", candidates: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "empty" })
    expect(calls).toHaveLength(0)
  })

  it("skips all-empty link results", async () => {
    const { client } = stubClient('{"parent": null, "blockedBy": [], "duplicates": []}')
    const res = await suggestIssueRelations(
      { title: "x", description: "", candidates },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("skips unparseable replies", async () => {
    const { client } = stubClient("not json at all")
    const res = await suggestIssueRelations(
      { title: "x", description: "", candidates },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })
})

describe("suggestIssueMetadata estimate", () => {
  it("accepts a bucketed estimate", async () => {
    const { client } = stubClient('{"priority": "high", "labels": [], "estimate": 5}')
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({
      kind: "suggestion",
      suggestion: { priority: "high", labelNames: [], estimate: 5 },
    })
  })

  it("drops out-of-bucket estimates", async () => {
    const { client } = stubClient('{"priority": null, "labels": [], "estimate": 7}')
    const res = await suggestIssueMetadata(
      { title: "x", description: "", labelNames: [] },
      { client, isPiiSafe: safe }
    )
    expect(res).toEqual({ kind: "skipped", reason: "no-output" })
  })
})

describe("customized issue-assist prompts (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("drafts with the workspace's wording and leaves other workspaces on the shipped text", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: ISSUE_DRAFT_PROMPT.id,
          scope: "workspace",
          targetId: "ws-1",
          revisionId: "por",
          body: "Write issue bodies in our RFC template.",
          contractVersion: ISSUE_DRAFT_PROMPT.contractVersion,
        },
      ])
    )
    const mine = stubClient("## Summary")
    await draftIssueDescription("Fix login", {
      client: mine.client,
      isPiiSafe: safe,
      promptContext: { workspaceId: "ws-1" },
    })
    expect(mine.calls[0].system).toBe("Write issue bodies in our RFC template.")
    const other = stubClient("## Summary")
    await draftIssueDescription("Fix login", {
      client: other.client,
      isPiiSafe: safe,
      promptContext: { workspaceId: "ws-2" },
    })
    expect(other.calls[0].system).toBe(ISSUE_DRAFT_PROMPT.defaultBody)
  })

  it("requires the JSON keys the metadata and relations parsers read", () => {
    expect(ISSUE_METADATA_PROMPT.requiredFragments).toEqual([
      '"priority"',
      '"labels"',
      '"estimate"',
    ])
    expect(ISSUE_RELATIONS_PROMPT.requiredFragments).toEqual([
      '"parent"',
      '"blockedBy"',
      '"duplicates"',
    ])
  })
})

describe("issue-assist overrides reach the model call (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  // Every prompt definition the module exports, so a new one needs a driver.
  const definitions = Object.values(issueAssist).filter(
    (value): value is PromptDefinitionV1 =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as Partial<PromptDefinitionV1>).id === "string" &&
      typeof (value as Partial<PromptDefinitionV1>).defaultBody === "string"
  )

  // Each prompt's public entry point, with inputs that reach the model call.
  const drive: Record<string, (client: LlmClient) => Promise<unknown>> = {
    "developer.issues.draft": (client) =>
      draftIssueDescription("Fix login redirect", { client, isPiiSafe: safe }),
    "developer.issues.improve": (client) =>
      improveIssueDescription("it broke on save", { client, isPiiSafe: safe }),
    "developer.issues.metadata": (client) =>
      suggestIssueMetadata(
        { title: "Crash on save", description: "", labelNames: ["bug"] },
        { client, isPiiSafe: safe }
      ),
    "developer.issues.title": (client) =>
      suggestIssueTitle("## Steps\n\nOpen login", { client, isPiiSafe: safe }),
    "developer.issues.relations": (client) =>
      suggestIssueRelations(
        {
          title: "Login loop",
          description: "",
          candidates: [{ id: "i1", identifier: "DEMO-1", title: "Auth refactor" }],
        },
        { client, isPiiSafe: safe }
      ),
  }

  it("finds every issue-assist prompt", () => {
    expect(definitions.map((def) => def.id).sort()).toEqual(Object.keys(drive).sort())
  })

  it.each(definitions.map((def) => [def.id, def] as const))(
    "sends the published %s override as the system prompt",
    async (id, def) => {
      const send = drive[id]
      expect(send).toBeDefined()

      // Without an override the call carries the shipped text.
      __overridePromptsForTests([])
      const shipped = stubClient("{}")
      await send(shipped.client)
      expect(shipped.calls[0].system).toBe(def.defaultBody)

      const body = [
        `SENTINEL-${def.id}`,
        ...def.variables.filter((spec) => spec.required).map((spec) => `{{${spec.name}}}`),
        ...def.requiredFragments,
      ].join(" ")
      expect(validatePromptBody(def, body)).toEqual([])
      __overridePromptsForTests([[def, body]])
      const { client, calls } = stubClient("{}")
      await send(client)
      expect(calls).toHaveLength(1)
      expect(calls[0].system).toContain(`SENTINEL-${def.id}`)
      expect(calls[0].system).not.toContain(def.defaultBody)
    }
  )

  it("blocks PII interpolated through projectName, labelNames, and candidate issues (T15 sibling)", async () => {
    const check = (text: string) => !text.includes("leak@example.com")
    const s1 = stubClient("body")
    expect(
      await draftIssueDescription("Clean title", {
        client: s1.client,
        isPiiSafe: check,
        projectName: "leak@example.com",
      })
    ).toEqual({ kind: "skipped", reason: "pii" })
    expect(s1.calls).toHaveLength(0)

    const s2 = stubClient("{}")
    expect(
      await suggestIssueMetadata(
        { title: "Clean", description: "", labelNames: ["leak@example.com"] },
        { client: s2.client, isPiiSafe: check }
      )
    ).toEqual({ kind: "skipped", reason: "pii" })
    expect(s2.calls).toHaveLength(0)

    const s3 = stubClient("{}")
    expect(
      await suggestIssueRelations(
        {
          title: "Clean",
          description: "",
          candidates: [{ id: "1", identifier: "DEMO-1", title: "Contact leak@example.com" }],
        },
        { client: s3.client, isPiiSafe: check }
      )
    ).toEqual({ kind: "skipped", reason: "pii" })
    expect(s3.calls).toHaveLength(0)
  })
})
