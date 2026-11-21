const mockDefaultRoutedPromptDeps = jest.fn(async (_options: unknown) => ({ routed: true }))
const mockRunRoutedPrompt = jest.fn()
jest.mock("@/lib/workflow/nodes/ai/ai-prompt-routed", () => ({
  defaultRoutedPromptDeps: (options: unknown) => mockDefaultRoutedPromptDeps(options),
  runRoutedPrompt: (...args: unknown[]) => mockRunRoutedPrompt(...args),
}))

import {
  defaultCouncilRunPrompt,
  runCouncil,
  formatCouncillorPrompt,
  formatCouncillorResults,
  parseConfidence,
  renderCouncilReport,
  COUNCIL_SYNTHESIS_PROMPT,
  type CouncilOptions,
  type RunCouncilDeps,
  type RunPromptInput,
} from "./run-council"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

const COUNCIL_SYNTHESIS_SYSTEM = COUNCIL_SYNTHESIS_PROMPT.defaultBody

/** Fake runPrompt: councillor aliases echo a canned line; the synthesizer
 *  (identified by the synthesis system prompt) returns a report. */
function makeDeps(
  overrides: {
    perAlias?: Record<
      string,
      (input: RunPromptInput) => Promise<{ completion: string; model?: string }>
    >
    synth?: string
  } = {}
): { deps: RunCouncilDeps; calls: RunPromptInput[] } {
  const calls: RunPromptInput[] = []
  const deps: RunCouncilDeps = {
    runPrompt: async (input) => {
      calls.push(input)
      if (input.systemPrompt?.startsWith(COUNCIL_SYNTHESIS_SYSTEM.slice(0, 20))) {
        return {
          completion:
            overrides.synth ??
            "## Council Response\nDo X.\n## Council Summary\nConfidence: majority",
          model: "synth-model",
          provider: "openai",
        }
      }
      const fn = overrides.perAlias?.[input.modelAlias]
      if (fn) return fn(input)
      return { completion: `answer from ${input.modelAlias}`, model: input.modelAlias }
    },
  }
  return { deps, calls }
}

const baseOpts: CouncilOptions = {
  prompt: "Should we use a queue or an outbox?",
  councillors: [
    { name: "alpha", modelAlias: "fast" },
    { name: "beta", modelAlias: "smart" },
  ],
  synthesizerAlias: "synth",
}

describe("runCouncil", () => {
  it("fans out councillors and synthesizes a report with parsed confidence", async () => {
    const { deps, calls } = makeDeps()
    const res = await runCouncil(baseOpts, deps)

    expect(res.totalCount).toBe(2)
    expect(res.respondedCount).toBe(2)
    expect(res.confidence).toBe("majority")
    expect(res.synthesizerModel).toBe("synth-model")
    expect(res.markdown).toMatch(/Council Response/)
    // 2 councillor calls + 1 synthesizer call.
    expect(calls).toHaveLength(3)
    expect(calls.filter((c) => c.systemPrompt).length).toBe(1)
  })

  it("prepends a councillor system prompt as role guidance", async () => {
    const { deps, calls } = makeDeps()
    await runCouncil(
      {
        ...baseOpts,
        councillors: [{ name: "reviewer", modelAlias: "fast", systemPrompt: "Focus on bugs." }],
      },
      deps
    )
    const councillorCall = calls.find((c) => !c.systemPrompt)
    expect(councillorCall?.userPrompt).toMatch(/Focus on bugs\./)
    expect(councillorCall?.userPrompt).toMatch(/queue or an outbox/)
  })

  it("runs serially when executionMode is 'serial'", async () => {
    const order: string[] = []
    const perAlias = {
      fast: async () => {
        order.push("fast-start")
        await new Promise((r) => setTimeout(r, 10))
        order.push("fast-end")
        return { completion: "a" }
      },
      smart: async () => {
        order.push("smart-start")
        return { completion: "b" }
      },
    }
    const { deps } = makeDeps({ perAlias })
    await runCouncil({ ...baseOpts, executionMode: "serial" }, deps)
    // Serial → fast fully finishes before smart starts.
    expect(order).toEqual(["fast-start", "fast-end", "smart-start"])
  })

  it("records a failed councillor but still synthesizes from the survivors", async () => {
    const perAlias = {
      smart: async () => {
        throw new Error("provider down")
      },
    }
    const { deps } = makeDeps({ perAlias })
    const res = await runCouncil(baseOpts, deps)
    expect(res.respondedCount).toBe(1)
    expect(res.councillors.find((c) => c.name === "beta")?.status).toBe("failed")
    expect(res.councillors.find((c) => c.name === "beta")?.error).toMatch(/provider down/)
  })

  it("treats an empty completion as a failed councillor", async () => {
    const perAlias = { fast: async () => ({ completion: "   " }) }
    const { deps } = makeDeps({ perAlias })
    const res = await runCouncil(baseOpts, deps)
    expect(res.councillors.find((c) => c.name === "alpha")?.status).toBe("failed")
    expect(res.councillors.find((c) => c.name === "alpha")?.error).toMatch(/empty response/)
  })

  it("times out a hung councillor and aborts its call", async () => {
    let aborted = false
    const perAlias = {
      fast: (input: RunPromptInput) =>
        new Promise<{ completion: string }>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            aborted = true
            reject(input.signal?.reason)
          })
        }),
    }
    const { deps } = makeDeps({ perAlias })
    const res = await runCouncil({ ...baseOpts, timeoutMs: 20 }, deps)
    expect(aborted).toBe(true)
    expect(res.councillors.find((c) => c.name === "alpha")?.status).toBe("failed")
    expect(res.councillors.find((c) => c.name === "alpha")?.error).toMatch(/timed out/)
    expect(res.councillors.find((c) => c.name === "alpha")?.stopUnconfirmed).toBeUndefined()
  })

  it("keeps a timed-out councillor's slot through its stop grace, then records an unconfirmed stop", async () => {
    let release!: () => void
    const hung = new Promise<void>((resolve) => {
      release = resolve
    })
    let fastStartedAt = 0
    let smartStartedAt = 0
    const perAlias = {
      fast: async () => {
        fastStartedAt = Date.now()
        await hung
        return { completion: "late" }
      },
      smart: async () => {
        smartStartedAt = Date.now()
        return { completion: "b" }
      },
    }
    const { deps } = makeDeps({ perAlias })
    try {
      const res = await runCouncil(
        { ...baseOpts, executionMode: "serial", timeoutMs: 10, stopGraceMs: 30 },
        deps
      )
      expect(res.councillors.find((c) => c.name === "alpha")).toMatchObject({
        status: "failed",
        stopUnconfirmed: true,
      })
      // The next councillor waited for the deadline AND the stop grace.
      expect(smartStartedAt - fastStartedAt).toBeGreaterThanOrEqual(35)
      expect(res.respondedCount).toBe(1)
    } finally {
      release()
    }
  })

  it("rates no consensus when no councillor answered (the synthesizer answers alone)", async () => {
    const failing = async () => {
      throw new Error("member unavailable")
    }
    const { deps, calls } = makeDeps({
      perAlias: { fast: failing, smart: failing },
      synth: "Unsupported synthesis\n\nConfidence: unanimous",
    })
    const res = await runCouncil(baseOpts, deps)
    // The single-model fallback is kept: the synthesizer still answers.
    expect(calls).toHaveLength(3)
    expect(res.markdown).toContain("Unsupported synthesis")
    expect(res).toMatchObject({ respondedCount: 0, totalCount: 2, confidence: "unknown" })
  })

  it("rates no consensus from a single answer", async () => {
    const { deps } = makeDeps({
      perAlias: {
        smart: async () => {
          throw new Error("provider down")
        },
      },
      synth: "Confidence: unanimous",
    })
    const res = await runCouncil(baseOpts, deps)
    expect(res).toMatchObject({ respondedCount: 1, confidence: "unknown" })
  })

  it("starts no councillor or synthesis after the caller stops it", async () => {
    const controller = new AbortController()
    const perAlias = {
      fast: async () => {
        controller.abort(new Error("step cancelled"))
        return { completion: "a" }
      },
    }
    const { deps, calls } = makeDeps({ perAlias })
    await expect(
      runCouncil({ ...baseOpts, executionMode: "serial", signal: controller.signal }, deps)
    ).rejects.toThrow("step cancelled")
    expect(calls.map((c) => c.modelAlias)).toEqual(["fast"])
  })

  it("appends extra synthesis guidance to the system prompt", async () => {
    const { deps, calls } = makeDeps()
    await runCouncil({ ...baseOpts, synthesisInstructions: "Be terse." }, deps)
    const synthCall = calls.find((c) => c.systemPrompt)
    expect(synthCall?.systemPrompt).toMatch(/Additional guidance:\nBe terse\./)
  })

  it("sends the shipped synthesis prompt when nothing is published", async () => {
    const { deps, calls } = makeDeps()
    await runCouncil(baseOpts, deps)
    expect(calls.find((c) => c.systemPrompt)?.systemPrompt).toBe(COUNCIL_SYNTHESIS_SYSTEM)
  })

  it("synthesizes with a published override and still appends caller guidance", async () => {
    const body = "Merge the answers. End with Confidence: unanimous|majority|split."
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: COUNCIL_SYNTHESIS_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-council-synthesis",
          body,
          contractVersion: COUNCIL_SYNTHESIS_PROMPT.contractVersion,
        },
      ])
    )
    const { deps, calls } = makeDeps()
    await runCouncil({ ...baseOpts, synthesisInstructions: "Be terse." }, deps)
    const synthCall = calls.find((c) => c.systemPrompt)
    expect(synthCall?.systemPrompt).toBe(`${body}\n\nAdditional guidance:\nBe terse.`)
  })

  it("validates required input", async () => {
    const { deps } = makeDeps()
    await expect(runCouncil({ ...baseOpts, prompt: "  " }, deps)).rejects.toThrow(
      /prompt is required/
    )
    await expect(runCouncil({ ...baseOpts, councillors: [] }, deps)).rejects.toThrow(
      /at least one councillor/
    )
    await expect(runCouncil({ ...baseOpts, synthesizerAlias: "" }, deps)).rejects.toThrow(
      /synthesizerAlias/
    )
  })
})

describe("formatting helpers", () => {
  it("formatCouncillorPrompt prepends role guidance only when present", () => {
    expect(formatCouncillorPrompt("Q")).toBe("Q")
    expect(formatCouncillorPrompt("Q", "Role")).toBe("Role\n\n---\n\nQ")
  })

  it("formatCouncillorResults includes completed and failed councillors", () => {
    const out = formatCouncillorResults("Q", [
      { name: "a", model: "m1", status: "completed", text: "ans" },
      { name: "b", model: "m2", status: "failed", error: "boom" },
    ])
    expect(out).toMatch(/\*\*a\*\* \(m1\):\nans/)
    expect(out).toMatch(/Failed\/Timed-out Councillors/)
    expect(out).toMatch(/\*\*b\*\*: failed — boom/)
  })

  it("formatCouncillorResults handles the all-failed case", () => {
    const out = formatCouncillorResults("Q", [
      { name: "a", model: "m", status: "failed", error: "x" },
    ])
    expect(out).toMatch(/All councillors failed/)
    expect(out).toMatch(/Answer the original prompt directly/)
  })

  it("parseConfidence extracts the rating or returns unknown", () => {
    expect(parseConfidence("Confidence: unanimous")).toBe("unanimous")
    expect(parseConfidence("... confidence rating: SPLIT.")).toBe("split")
    expect(parseConfidence("no rating here")).toBe("unknown")
  })

  it("renderCouncilReport appends a footer with counts and confidence", () => {
    const report = renderCouncilReport({
      markdown: "## Council Response\nX",
      confidence: "majority",
      councillors: [],
      respondedCount: 2,
      totalCount: 3,
      synthesizerModel: "gpt",
    })
    expect(report).toMatch(/2\/3 councillors responded/)
    expect(report).toMatch(/synthesized by gpt/)
    expect(report).toMatch(/majority/)
  })
})

describe("defaultCouncilRunPrompt", () => {
  it("routes on the council surface and ledgers every call under the caller's binding", async () => {
    mockRunRoutedPrompt.mockResolvedValue({
      completion: "answer",
      provider: "openai",
      model: "gpt-5",
    })
    const ledger = {
      surface: "utilityLedger" as const,
      origin: "chat" as const,
      featureId: "slash-council",
      workspaceId: "ws-9",
    }
    const runPrompt = await defaultCouncilRunPrompt(ledger)
    expect(mockDefaultRoutedPromptDeps).toHaveBeenCalledWith({ routingSurface: "council", ledger })

    await expect(runPrompt({ modelAlias: "fast", userPrompt: "q" })).resolves.toEqual({
      completion: "answer",
      provider: "openai",
      model: "gpt-5",
    })
    expect(mockRunRoutedPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ modelAlias: "fast", userPrompt: "q" }),
      { routed: true }
    )
  })

  it("reserves every call from the caller's run tree budget when it names a run", async () => {
    const ledger = {
      surface: "agentsWorkflows" as const,
      origin: "workflow" as const,
      featureId: "workflow:c1",
      workspaceId: null,
    }
    await defaultCouncilRunPrompt(ledger, "execution:workflow:run-1")
    expect(mockDefaultRoutedPromptDeps).toHaveBeenLastCalledWith({
      routingSurface: "council",
      ledger,
      executionRunId: "execution:workflow:run-1",
    })
  })
})
