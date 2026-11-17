/**
 * How `resolveSendOptions` delivers skill bodies in full mode — the default
 * for every caller that names no render mode, the scheduler's skill runs
 * among them. A skill named for the turn is delivered whole outside the
 * ceiling; the ceiling only decides which of the agent's own skills also fit,
 * and one it leaves out is not offered at all: no body, no tools.
 */

const loadProjectInstructions = jest.fn()
jest.mock("@/lib/agents/instructions/load", () => ({
  loadProjectInstructions: (...args: unknown[]) => loadProjectInstructions(...args),
}))

import { resolveSendOptions } from "./build-options"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { Character, ChatSession } from "@cognia/agent-config-types"
import { createSkill } from "@/lib/db/skills"
import { releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  loadProjectInstructions.mockReset()
  loadProjectInstructions.mockResolvedValue({
    section: "",
    files: [],
    markdownAgentFiles: [],
    warnings: [],
  })
})
afterAll(dbFixture.dispose)

const baseCharacter: Character = {
  id: "char_s",
  name: "Operator",
  avatarColor: "oklch(0.7 0.15 240)",
  systemPrompt: "PERSONA_PROMPT",
  allowedTools: ["Read"],
  createdAt: 1,
  updatedAt: 1,
}

async function runFor(sessionId: string) {
  return (await startToolExecutionRun(sessionId, { localAuthorization: LOCAL_PERSON_RUN })).id
}

describe("resolveSendOptions — full-mode skill delivery", () => {
  it("delivers a selected skill whole even when the agent's own skills fill the ceiling", async () => {
    const ambient = await createSkill({
      name: "Ambient skill",
      content: "AMBIENT_RULE" + "A ".repeat(20_000),
      allowedTools: ["Grep"],
    })
    const selected = await createSkill({
      name: "Explicit selected skill",
      content: "SELECTED_RULE_7319" + "B".repeat(1_000),
      allowedTools: ["Bash"],
      invocationPolicy: "explicit",
    })
    const opts = await resolveSendOptions({
      character: { ...baseCharacter, skillIds: [ambient.id] },
      session: { id: "skill-full-1", characterId: baseCharacter.id } as ChatSession,
      executionIdentity: { runId: await runFor("skill-full-1") },
      ephemeralSkillIds: [selected.id],
      skillRenderMode: "full",
    })
    const prompt = `${opts.systemPrompt ?? ""}\n${opts.appendSystemPrompt ?? ""}`
    expect(prompt).toContain("SELECTED_RULE_7319")
    expect(opts.allowedTools).toContain("Bash")
    // The ambient skill alone exceeds the ceiling: absent, and so are its tools.
    expect(prompt).not.toContain("AMBIENT_RULE")
    expect(opts.allowedTools).not.toContain("Grep")
  })

  it("delivers the scheduler's oversized skill under the default (full) render mode", async () => {
    const scheduled = await createSkill({
      name: "Scheduled skill",
      content: "SCHEDULED_RULE_9841" + "C".repeat(17_000),
      allowedTools: ["Bash"],
    })
    // The scheduler's skill executor call shape: the skill as an ephemeral id,
    // no render mode.
    const opts = await resolveSendOptions({
      character: baseCharacter,
      session: { id: "skill-full-2" } as ChatSession,
      executionIdentity: { runId: await runFor("skill-full-2") },
      ephemeralSkillIds: [scheduled.id],
    })
    const prompt = `${opts.systemPrompt ?? ""}\n${opts.appendSystemPrompt ?? ""}`
    expect(prompt).toContain("SCHEDULED_RULE_9841")
    expect(opts.allowedTools).toContain("Bash")
  })

  it("keeps an agent skill that fits, with its tools", async () => {
    const small = await createSkill({
      name: "Small skill",
      content: "SMALL_RULE_1182",
      allowedTools: ["Grep"],
    })
    const opts = await resolveSendOptions({
      character: { ...baseCharacter, skillIds: [small.id] },
      session: { id: "skill-full-3", characterId: baseCharacter.id } as ChatSession,
      executionIdentity: { runId: await runFor("skill-full-3") },
    })
    const prompt = `${opts.systemPrompt ?? ""}\n${opts.appendSystemPrompt ?? ""}`
    expect(prompt).toContain("SMALL_RULE_1182")
    expect(opts.allowedTools).toContain("Grep")
  })

  it("matches the composer's hybrid mode for the selected skill", async () => {
    const ambient = await createSkill({
      name: "Ambient skill",
      content: "A".repeat(15_500),
      allowedTools: [],
    })
    const selected = await createSkill({
      name: "Explicit selected skill",
      content: "SELECTED_RULE_7319" + "B".repeat(1_000),
      allowedTools: ["Bash"],
      invocationPolicy: "explicit",
    })
    const opts = await resolveSendOptions({
      character: { ...baseCharacter, skillIds: [ambient.id] },
      session: { id: "skill-hybrid", characterId: baseCharacter.id } as ChatSession,
      executionIdentity: { runId: await runFor("skill-hybrid") },
      ephemeralSkillIds: [selected.id],
      skillRenderMode: "hybrid",
    })
    const prompt = `${opts.systemPrompt ?? ""}\n${opts.appendSystemPrompt ?? ""}`
    expect(prompt).toContain("SELECTED_RULE_7319")
    expect(opts.pluginTools?.map((tool) => tool.name)).toContain("load_skill")
    releaseSkillLoadContext("skill-hybrid")
  })
})
