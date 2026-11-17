#!/usr/bin/env node
/**
 * Adversarial characterization of context assembly through the real resolver.
 * Uses the existing isolated Dexie fixture. Passing assertions characterize a
 * defect, not correct product behavior. No provider calls or real data writes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const directory = ".cache/context-management-adversarial"
mkdirSync(directory, { recursive: true })
const harness = readFileSync("lib/claude/build-options-harness.test.ts", "utf8")
  .split('describe("resolveSendOptions — harness sections"')[0]
  .replace('from "./build-options"', 'from "@/lib/claude/build-options"')
writeFileSync(
  `${directory}/explicit-skill.test.ts`,
  harness +
    `
import { createSkill } from "@/lib/db/skills"

it("A01 observes a selected custom skill being omitted while its tool stays granted", async () => {
  const implicit = await createSkill({
    name: "Ambient skill", content: "A".repeat(15_500), allowedTools: [],
  })
  const selected = await createSkill({
    name: "Explicit selected skill", content: "SELECTED_RULE_7319" + "B".repeat(1_000),
    allowedTools: ["Bash"], invocationPolicy: "explicit",
  })
  const run = await startToolExecutionRun("skill-budget-audit", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const opts = await resolveSendOptions({
    character: { ...baseCharacter, skillIds: [implicit.id] },
    session: { id: "skill-budget-audit", characterId: baseCharacter.id } as ChatSession,
    executionIdentity: { runId: run.id },
    ephemeralSkillIds: [selected.id],
    skillRenderMode: "full",
  })
  expect(opts.systemPrompt).toContain("Ambient skill")
  expect(opts.systemPrompt).not.toContain("SELECTED_RULE_7319")
  expect(opts.systemPrompt).not.toContain("Explicit selected skill")
  expect(opts.allowedTools).toContain("Bash")
})

it("A02 observes the scheduler default-full call shape omitting an oversized selected skill", async () => {
  const selected = await createSkill({
    name: "Scheduled skill", content: "SCHEDULED_RULE_9841" + "C".repeat(17_000),
    allowedTools: ["Bash"],
  })
  const run = await startToolExecutionRun("skill-schedule-budget-audit", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const opts = await resolveSendOptions({
    character: baseCharacter,
    session: { id: "skill-schedule-budget-audit" } as ChatSession,
    executionIdentity: { runId: run.id },
    ephemeralSkillIds: [selected.id],
  })
  expect(opts.systemPrompt).not.toContain("SCHEDULED_RULE_9841")
  expect(opts.systemPrompt).not.toContain("Scheduled skill")
  expect(opts.allowedTools).toContain("Bash")
})

it("A03 controls that the normal composer hybrid mode keeps the explicit skill", async () => {
  const implicit = await createSkill({
    name: "Ambient skill", content: "A".repeat(15_500), allowedTools: [],
  })
  const selected = await createSkill({
    name: "Explicit selected skill", content: "SELECTED_RULE_7319" + "B".repeat(1_000),
    allowedTools: ["Bash"], invocationPolicy: "explicit",
  })
  const run = await startToolExecutionRun("skill-hybrid-control", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const opts = await resolveSendOptions({
    character: { ...baseCharacter, skillIds: [implicit.id] },
    session: { id: "skill-hybrid-control", characterId: baseCharacter.id } as ChatSession,
    executionIdentity: { runId: run.id },
    ephemeralSkillIds: [selected.id],
    skillRenderMode: "hybrid",
  })
  expect(opts.systemPrompt).toContain("SELECTED_RULE_7319")
  expect(opts.pluginTools?.map(tool => tool.name)).toContain("load_skill")
  releaseSkillLoadContext("skill-hybrid-control")
})
`
)
writeFileSync(
  `${directory}/jest.config.ts`,
  `import base from "../../jest.config.ts"
export default async () => {
  const config = await base()
  const project = config.projects.find(p => p.displayName === "jsdom" || p.displayName?.name === "jsdom")
  return { ...config, rootDir: process.cwd(), cacheDirectory: ".cache/context-management-adversarial/jest",
    projects: [{ ...project, rootDir: process.cwd(),
      testMatch: ["<rootDir>/.cache/context-management-adversarial/*.test.ts"],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: project.modulePathIgnorePatterns.filter(p => !p.includes(".cache")) }] }
}
`
)
const result = spawnSync(
  "pnpm",
  [
    "--config.verifyDepsBeforeRun=false",
    "test",
    "--config",
    `${directory}/jest.config.ts`,
    "--runInBand",
    "--watchman=false",
  ],
  { stdio: "inherit" }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
