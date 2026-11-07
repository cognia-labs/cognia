import { validateAgentCapabilityGrant } from "@cognia/agent-config-types/agent-capability-grant"

import {
  BROWSER_COMPANION_AGENT_INSTRUCTION,
  BROWSER_COMPANION_AGENT_PROMPT,
  contributions,
} from "./agent-grant"
import companionModule from "./module"
import {
  __resetCapabilityContributionsForTests,
  collectContributedGrants,
} from "@/lib/claude/capability-contributions"
import { bindExtensionSession, resetExtensionBindings } from "@/lib/browser/extension-engine"
import type { CapabilityContributionContext } from "@/lib/modules/manifest-types"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import { validatePromptBody } from "@/lib/prompts/template"

type Snapshot = CapabilityContributionContext["prompts"]["snapshot"]

const runOf = (sessionId: string | null, snapshot: Snapshot): CapabilityContributionContext => ({
  session: sessionId ? ({ id: sessionId } as CapabilityContributionContext["session"]) : null,
  agent: null,
  settings: null,
  activeGoal: null,
  prompts: { snapshot, context: { sessionId: sessionId ?? undefined } },
})

/** What the module contributes to a run, through the resolver's own reader. */
async function grantFor(sessionId: string | null, snapshot: Snapshot = null) {
  const { grants } = await collectContributedGrants(runOf(sessionId, snapshot), [
    { module: "browser-companion", stage: "stable", load: async () => ({ contributions }) },
  ])
  return grants[0]
}

beforeEach(() => {
  __resetCapabilityContributionsForTests()
  bindExtensionSession("s-browser", { deviceId: "browser-a" })
})
afterEach(() => resetExtensionBindings())

describe("the agent-mode contribution", () => {
  it("is the module's only contribution, an additive one", async () => {
    expect(contributions.map(({ id, failure }) => ({ id, failure }))).toEqual([
      { id: "agent-mode", failure: "skip" },
    ])
    expect((await companionModule.capabilityContributions.load()).contributions).toBe(contributions)
  })

  it("applies only to a conversation bound to a paired browser", async () => {
    expect(await grantFor("s-other")).toBeUndefined()
    expect(await grantFor(null)).toBeUndefined()
  })

  it("is a valid grant that only adds instructions", async () => {
    const grant = await grantFor("s-browser")
    expect(grant).toEqual({
      schemaVersion: 1,
      source: { kind: "module", id: "browser-companion/agent-mode" },
      instructions: [BROWSER_COMPANION_AGENT_INSTRUCTION],
    })
    // No tool, skill, MCP or permission change: those would widen or narrow
    // the run beyond "act in the browser the user started from".
    expect(grant).not.toHaveProperty("tools")
    expect(grant).not.toHaveProperty("permissionMode")
    expect(validateAgentCapabilityGrant(grant)).toMatchObject({ ok: true })
  })

  it("tells the model how the user stays in charge", () => {
    for (const phrase of [
      "browser_site_permission_required",
      "browser_user_takeover",
      "password",
    ]) {
      expect(BROWSER_COMPANION_AGENT_INSTRUCTION).toContain(phrase)
    }
  })
})

describe("the grant instruction as a Prompt Center entry (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("cannot be published without the two answers the user's control depends on", () => {
    expect(
      validatePromptBody(BROWSER_COMPANION_AGENT_PROMPT, "Act freely in the browser.")
    ).toEqual(
      expect.arrayContaining([
        { code: "missing-fragment", fragment: "browser_site_permission_required" },
        { code: "missing-fragment", fragment: "browser_user_takeover" },
      ])
    )
  })

  it("carries a published override as the grant's only instruction", async () => {
    const body =
      "You act in the user's browser. On browser_site_permission_required ask the user; " +
      "on browser_user_takeover stop."
    // The run's frozen snapshot is the one the grant resolves against.
    const snapshot = buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: "pob",
        promptId: BROWSER_COMPANION_AGENT_PROMPT.id,
        scope: "account",
        targetId: "",
        revisionId: "por-browser-grant",
        body,
        contractVersion: BROWSER_COMPANION_AGENT_PROMPT.contractVersion,
      },
    ])
    const grant = await grantFor("s-browser", snapshot)
    expect(grant.instructions).toEqual([body])
    // The override changes wording only; the grant still adds nothing else.
    expect(Object.keys(grant).sort()).toEqual(["instructions", "schemaVersion", "source"])
  })
})
