import { normalizeRadarOutput, generateRadarReport } from "./generate"
import { RADAR_SYSTEM_PROMPT } from "./prompts"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { RadarDataItem } from "@/types/radar"
import {
  __overridePromptsForTests,
  __setPromptOverrideSnapshotForTests,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"

describe("normalizeRadarOutput", () => {
  it("keeps only valid source indexes while preserving legacy text actions", () => {
    const result = normalizeRadarOutput(
      {
        actions: [{ text: "Read", sourceIndexes: [0, 0, -1, 2.5, 99] }, "Legacy", null],
        graveyard: [null],
        topicCloud: [null],
      },
      3
    )
    expect(result.actions).toEqual(["Read", "Legacy"])
    expect(result.actionEvidence).toEqual([[0], []])
  })
  it("fills defaults for a malformed payload", () => {
    const out = normalizeRadarOutput({}, 3)
    expect(out.verdict).toBe("")
    expect(out.atAGlance).toEqual([])
    expect(out.graveyard).toEqual([])
  })

  it("keeps valid fields and filters out-of-range graveyard indices", () => {
    const out = normalizeRadarOutput(
      {
        verdict: "you read a lot of rust",
        atAGlance: ["a", 3, "b"],
        graveyard: [
          { index: 1, reason: "revisit" },
          { index: 99, reason: "out of range" },
          { index: 0 },
        ],
        topicCloud: [{ topic: "rust", weight: 0.7 }, { weight: 1 }],
      },
      3
    )
    expect(out.verdict).toBe("you read a lot of rust")
    expect(out.atAGlance).toEqual(["a", "b"])
    expect(out.graveyard).toEqual([{ index: 1, reason: "revisit" }])
    expect(out.topicCloud).toEqual([{ topic: "rust", weight: 0.7 }])
  })
})

describe("generateRadarReport", () => {
  const items: RadarDataItem[] = [{ id: "a", text: "rust ownership", source: "memory", at: 0 }]

  it("calls the client and parses JSON", async () => {
    const client: LlmClient = {
      complete: jest.fn(async () => '```json\n{"verdict":"ok","actions":["do x"]}\n```'),
    }
    const out = await generateRadarReport(client, { items })
    expect(client.complete).toHaveBeenCalled()
    expect(out.verdict).toBe("ok")
    expect(out.actions).toEqual(["do x"])
  })

  it("forwards abortSignal to client.complete and rejects immediately on abort (F22)", async () => {
    const controller = new AbortController()
    let notifyEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })
    const client: LlmClient = {
      complete: jest.fn(() => {
        notifyEntered()
        return new Promise<string>(() => {})
      }),
    }
    const pending = generateRadarReport(client, { items, signal: controller.signal })
    await entered
    controller.abort("cancelled-by-scheduler")
    await expect(pending).rejects.toThrow("cancelled-by-scheduler")
    expect(client.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ abortSignal: controller.signal })
    )
  })
})

describe("generateRadarReport (published prompt reaches the model, ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("sends the published knowledge.radar system prompt, not the shipped one", async () => {
    const def = RADAR_SYSTEM_PROMPT
    const body =
      'SENTINEL-knowledge.radar Reply with {"verdict":"","atAGlance":[],"actions":[],"topicCloud":[]}.'
    expect(validatePromptBody(def, body)).toEqual([])
    __overridePromptsForTests([[def, body]])

    const complete = jest.fn<Promise<string>, Parameters<LlmClient["complete"]>>(
      async () => '{"verdict":"ok"}'
    )
    await generateRadarReport(
      { complete },
      { items: [{ id: "a", text: "rust ownership", source: "memory", at: 0 }] }
    )
    const system = complete.mock.calls[0]?.[1]?.system ?? ""
    expect(system).toContain("SENTINEL-knowledge.radar")
    expect(system).not.toContain(def.defaultBody.slice(0, 80))
  })
})
