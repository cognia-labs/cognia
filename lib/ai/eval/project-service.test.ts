/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { EvalEnvironmentCompatibility, EvalProject } from "@cognia/eval-core"
import {
  EvalProjectService,
  digestEvalDependency,
  readEvalTargetDependency,
} from "./project-service"
import { getSettings } from "@/lib/db/settings"
import { saveEvalProject } from "@/lib/db/eval-lab"
import { publishPromptOverride, savePromptOverrideDraft } from "@/lib/db/prompt-overrides"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

const project = (): EvalProject => ({
  id: "project-1",
  name: "Selection",
  mode: "model",
  dataset: {
    datasetId: "dataset-1",
    version: 2,
    digest: "sha256:dataset",
    caseIds: Array.from({ length: 30 }, (_, i) => `case-${i}`),
    holdoutCaseIds: Array.from({ length: 30 }, (_, i) => `case-${i}`),
    requiredModalities: ["text"],
  },
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model" as const,
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    runtimeTarget: "web" as const,
    isLocal: true,
    capabilities: ["text" as const],
    available: true,
    credentialReady: true,
  })),
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 10, confirmed: true },
  judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
})

const environment: EvalEnvironmentCompatibility = {
  checkedAt: 50,
  runtimeByVariant: { a: { available: true }, b: { available: true } },
  storage: { status: "available", requiredBytes: 1, availableBytes: 100 },
}

describe("EvalProjectService v2", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await saveEvalProject(project())
  })

  afterAll(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("preflights and atomically queues every stage-one variant × holdout case", async () => {
    let id = 0
    const service = new EvalProjectService({ now: () => 100, newId: () => `id-${id++}` })

    await expect(service.preflight("project-1", environment)).resolves.toMatchObject({ ok: true })
    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: { exact: "1" },
      randomSeed: 42,
      environmentCompatibility: environment,
    })

    expect(experiment.state).toBe("queued")
    expect(experiment.manifest.adaptiveRepetitions).toEqual({ stageOne: 1, maximum: 3 })
    expect(experiment.manifest.retentionDays).toBe(90)
    expect(experiment.manifest.environmentCompatibility).toEqual(environment)
    expect(await getDb().evalTasks.where("experimentId").equals(experiment.id).count()).toBe(60)
    expect(
      await getDb().evalTasks.where("experimentId").equals(experiment.id).first()
    ).toMatchObject({
      repetition: 1,
      state: "queued",
    })
  })

  it("cannot resume or pause cancelled work and rejects stale scoped mutations", async () => {
    const service = new EvalProjectService()
    const experiment = await service.start("project-1", {
      appVersion: "1",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })
    await service.cancel(experiment.id)
    await service.resume(experiment.id)
    await service.pause(experiment.id)
    expect((await service.status(experiment.id)).experiment.state).toBe("cancelled")
    let checks = 0
    const scoped = new EvalProjectService({
      scope: {
        db: getDb(),
        assertActive() {
          if (++checks > 1) throw new Error("scope changed")
        },
      },
    })
    await expect(scoped.extendBudget(experiment.id, 99)).rejects.toThrow("scope changed")
    expect((await service.status(experiment.id)).experiment.budgetCap).not.toBe(99)
  })

  it("reserves cloud judge calls even when the evaluated target runs locally", async () => {
    const formal = project()
    formal.decisionPolicy.formal = true
    formal.judgePolicy = {
      enabled: true,
      providerId: "judge-provider",
      modelId: "judge-model",
      isLocal: false,
      price: { currency: "USD", inputPerMillion: 10, outputPerMillion: 20 },
      maxOutputTokens: 300,
      secondJudgeProviderId: "second-judge-provider",
      secondJudgeModelId: "second-judge-model",
      secondJudgeIsLocal: false,
      secondJudgePrice: { currency: "USD", inputPerMillion: 10, outputPerMillion: 20 },
      calibrated: true,
      anchorCount: 30,
      kappa: 0.7,
      accuracy: 0.9,
    }
    await saveEvalProject(formal)
    const service = new EvalProjectService({ now: () => 100, newId: () => crypto.randomUUID() })

    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })

    const firstTask = await getDb().evalTasks.where("experimentId").equals(experiment.id).first()
    expect(firstTask?.estimatedWorstCaseCost).toBeGreaterThan(0)
  })

  it("runs the concrete environment adapter before returning verified preflight", async () => {
    const checkEnvironment = jest.fn(async () => environment)
    const service = new EvalProjectService({ checkEnvironment })

    await expect(service.environment("project-1")).resolves.toEqual(environment)
    await expect(service.verifiedPreflight("project-1")).resolves.toMatchObject({
      environmentCompatibility: environment,
      result: { ok: true },
    })
    expect(checkEnvironment).toHaveBeenCalledTimes(2)
  })

  it("persists pause/resume/cancel states and exposes report evidence", async () => {
    const service = new EvalProjectService({ now: () => 100, newId: () => crypto.randomUUID() })
    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })

    await service.pause(experiment.id)
    await expect(service.status(experiment.id)).resolves.toMatchObject({
      experiment: { state: "paused" },
    })
    await service.resume(experiment.id)
    await expect(service.status(experiment.id)).resolves.toMatchObject({
      experiment: { state: "queued" },
    })
    await service.cancel(experiment.id)
    await expect(service.report(experiment.id)).resolves.toMatchObject({
      experiment: { state: "cancelled" },
      tasks: { cancelled: 60 },
      recommendations: [],
    })
  })

  it("extends the active budget without mutating the immutable manifest", async () => {
    const service = new EvalProjectService({ now: () => 250, newId: () => crypto.randomUUID() })
    const experiment = await service.start("project-1", {
      appVersion: "1.0.0",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })

    await service.extendBudget(experiment.id, 15)
    const updated = await getDb().evalExperiments.get(experiment.id)

    expect(updated).toMatchObject({
      budgetCap: 15,
      budgetExtensions: [{ previousCap: 10, nextCap: 15, createdAt: 250 }],
    })
    expect(updated?.manifest.budget.hardCap).toBe(10)
    await expect(service.extendBudget(experiment.id, 15)).rejects.toThrow("greater")
  })

  it("freezes a balanced seeded schedule and fingerprints cases and target definitions", async () => {
    const frozenCase = {
      id: "case-0",
      datasetId: "dataset-1",
      input: "frozen input",
      capability: "text",
      source: "handwritten" as const,
      createdAt: 1,
      updatedAt: 1,
    }
    await getDb().evalCases.put(frozenCase)
    const service = new EvalProjectService({
      readTargetDependency: async (variant) => ({ id: variant.id, revision: "pinned" }),
    })
    const start = (seed: number) =>
      service.start("project-1", {
        appVersion: "test",
        scorerVersions: {},
        randomSeed: seed,
        environmentCompatibility: environment,
        executionProtocol: { kind: "balanced", repetitions: 3, outerConcurrency: 1 },
      })
    const first = await start(42)
    const second = await start(42)
    const third = await start(7)
    const schedule = async (id: string) =>
      (await getDb().evalTasks.where("experimentId").equals(id).toArray())
        .sort((a, b) => a.scheduleOrder! - b.scheduleOrder!)
        .map((row) => `${row.caseId}:${row.variantId}:${row.repetition}`)
    const firstOrder = await schedule(first.id)
    expect(firstOrder).toHaveLength(180)
    expect(new Set(firstOrder).size).toBe(180)
    expect(await schedule(second.id)).toEqual(firstOrder)
    expect(await schedule(third.id)).not.toEqual(firstOrder)
    expect(first.manifest.caseDigests?.[frozenCase.id]).toBe(await digestEvalDependency(frozenCase))
    expect(first.manifest.targetDigests?.a).toBe(
      await digestEvalDependency({ id: "a", revision: "pinned" })
    )
    expect(first.manifest.executionProtocol).toEqual({
      kind: "balanced",
      repetitions: 3,
      outerConcurrency: 1,
    })
  })

  // F06: saving a draft changed the digest of a target whose published text
  // had not changed, and the executor refused to run the experiment.
  it("keeps a target's digest across a draft and changes it when published text does", async () => {
    const variant = { ...project().variants[0], kind: "chat" as const, targetId: "agent-1" }
    const target = { scope: "account" as const, targetId: "" }
    const base = {
      promptId: "generation.title.chat",
      target,
      contractVersion: 1,
      baseDigest: "sha256:base",
      origin: "editor" as const,
    }
    const published = await publishPromptOverride({
      ...base,
      body: "Published.",
      expectedRev: 0,
      mutationId: "pub-1",
    })
    const before = await digestEvalDependency(await readEvalTargetDependency(variant))
    const drafted = await savePromptOverrideDraft({
      ...base,
      body: "Unpublished draft.",
      expectedRev: published.rev,
      mutationId: "draft-1",
    })
    expect(await digestEvalDependency(await readEvalTargetDependency(variant))).toBe(before)
    await publishPromptOverride({
      ...base,
      body: "Published again.",
      expectedRev: drafted.rev,
      mutationId: "pub-2",
    })
    expect(await digestEvalDependency(await readEvalTargetDependency(variant))).not.toBe(before)
  })

  it("fingerprints execution settings without persisting their contents in a manifest", async () => {
    const settings = await getSettings()
    await getDb().settings.put({ ...settings, defaultModel: "frozen-default-model" })
    const variant = project().variants[0]
    const first = await digestEvalDependency(await readEvalTargetDependency(variant))
    await getDb().settings.update("singleton", { defaultModel: "changed-default-model" })
    const second = await digestEvalDependency(await readEvalTargetDependency(variant))
    expect(second).not.toBe(first)
    const experiment = await new EvalProjectService().start("project-1", {
      appVersion: "test",
      scorerVersions: {},
      randomSeed: 1,
      environmentCompatibility: environment,
    })
    expect(JSON.stringify(experiment.manifest)).not.toContain("changed-default-model")
    expect(experiment.manifest.targetDigests?.[variant.id]).toMatch(/^sha256:/)
  })

  it("ignores unrelated agent/workspace overrides and cosmetic character edits in target digest (T06)", async () => {
    await getDb().characters.put({
      id: "agent-1",
      name: "Agent One",
      systemPrompt: "Stable system prompt",
      avatarUrl: "https://example.invalid/a.png",
      updatedAt: new Date("2026-11-22T00:00:00Z"),
      createdAt: new Date("2026-11-22T00:00:00Z"),
    } as never)
    const variant = { ...project().variants[0], kind: "chat" as const, targetId: "agent-1" }
    const baseline = await digestEvalDependency(await readEvalTargetDependency(variant))

    // Cosmetic avatar and timestamp updates must not invalidate the target digest.
    await getDb().characters.update("agent-1", {
      avatarUrl: "https://example.invalid/b.png",
      updatedAt: new Date("2026-11-22T01:00:00Z"),
    } as never)
    expect(await digestEvalDependency(await readEvalTargetDependency(variant))).toBe(baseline)

    // Publishing overrides for another agent or workspace must not invalidate agent-1's chat eval.
    await publishPromptOverride({
      promptId: "chat.brief-mode",
      target: { scope: "agent", targetId: "agent-2" },
      body: "Other agent brevity.",
      contractVersion: 1,
      baseDigest: "sha256:base",
      expectedRev: 0,
      mutationId: "other-agent",
      origin: "editor",
    })
    await publishPromptOverride({
      promptId: "chat.brief-mode",
      target: { scope: "workspace", targetId: "ws-other" },
      body: "Other workspace brevity.",
      contractVersion: 1,
      baseDigest: "sha256:base",
      expectedRev: 0,
      mutationId: "other-ws",
      origin: "editor",
    })
    expect(await digestEvalDependency(await readEvalTargetDependency(variant))).toBe(baseline)

    // Publishing an override scoped to agent-1 itself DOES change its target digest.
    await publishPromptOverride({
      promptId: "chat.brief-mode",
      target: { scope: "agent", targetId: "agent-1" },
      body: "Agent-1 brevity.",
      contractVersion: 1,
      baseDigest: "sha256:base",
      expectedRev: 0,
      mutationId: "this-agent",
      origin: "editor",
    })
    expect(await digestEvalDependency(await readEvalTargetDependency(variant))).not.toBe(baseline)
  })
})
