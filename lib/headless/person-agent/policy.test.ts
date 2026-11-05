import { currentPersonModelPricing, rememberPersonModelPricing } from "./model-pricing"
import { fetchPersonAgentPolicy, resolvePersonAgent, type PersonAgentPolicy } from "./policy"

const policy: PersonAgentPolicy = {
  allowedAgents: [
    { runtimeId: "claude-agent-acp", available: true, providers: ["anthropic"] },
    { runtimeId: "codex-acp", available: false, providers: [] },
  ],
  defaultAgent: "claude-agent-acp",
  execution: "sandboxed",
  models: { anthropic: ["claude-sonnet-4-5"] },
  usage: { month: "2026-10", spentTokens: 10, reservedTokens: 0, monthlyTokens: 100 },
}

const session = { providerOverride: "anthropic", model: "claude-sonnet-4-5" }

/** The policy as this Host version answers it: every field present. */
const wire = { ...policy, modelNames: {}, modelPricing: {}, resumeAfterRestart: false }

describe("person agent policy", () => {
  it("p6e runs the session's agent, else the org default", () => {
    expect(
      resolvePersonAgent({ ...session, agentRuntimeId: "claude-agent-acp" }, policy, true)
    ).toEqual({
      kind: "agent",
      runtimeId: "claude-agent-acp",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    })
    expect(resolvePersonAgent(session, policy, false)).toMatchObject({
      kind: "agent",
      runtimeId: "claude-agent-acp",
    })
  })

  it("p6e stays tool-less chat with no agent and no default", () => {
    const noDefault = { ...policy, defaultAgent: null }
    expect(resolvePersonAgent(session, noDefault, true)).toEqual({ kind: "tool-less" })
    expect(resolvePersonAgent(session, noDefault, false)).toEqual({
      kind: "refused",
      code: "execution_isolation_unavailable",
    })
  })

  it("p6e never falls back from an agent the org does not allow", () => {
    expect(resolvePersonAgent({ ...session, agentRuntimeId: "pi" }, policy, true)).toEqual({
      kind: "refused",
      code: "org_agent_not_allowed",
    })
  })

  it("p6e refuses without execution or model access", () => {
    expect(resolvePersonAgent(session, { ...policy, execution: "none" }, true)).toEqual({
      kind: "refused",
      code: "execution_isolation_unavailable",
    })
    expect(resolvePersonAgent({ ...session, agentRuntimeId: "codex-acp" }, policy, true)).toEqual({
      kind: "refused",
      code: "model_access_unavailable",
    })
    for (const picks of [
      { providerOverride: "openai", model: "gpt" },
      { providerOverride: "anthropic" },
      { model: "claude-sonnet-4-5" },
      // D09: a model the org does not serve is refused here, as the lease would.
      { providerOverride: "anthropic", model: "claude-opus-unserved" },
    ]) {
      expect(resolvePersonAgent(picks, policy, true)).toEqual({
        kind: "refused",
        code: "model_access_unavailable",
      })
    }
  })

  it("d09 refuses tool-less chat on a model the org does not serve", () => {
    const noDefault = { ...policy, defaultAgent: null }
    expect(
      resolvePersonAgent({ providerOverride: "anthropic", model: "unserved" }, noDefault, true)
    ).toEqual({ kind: "refused", code: "model_access_unavailable" })
    // Without tool-less chat on this Host nothing could run it anyway.
    expect(
      resolvePersonAgent({ providerOverride: "anthropic", model: "unserved" }, noDefault, false)
    ).toEqual({ kind: "refused", code: "execution_isolation_unavailable" })
  })

  it("p6e reads the Host policy and refuses a malformed answer", async () => {
    const call = jest.fn().mockResolvedValueOnce(wire).mockResolvedValueOnce({ allowedAgents: 1 })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toEqual(policy)
    expect(call).toHaveBeenCalledWith("person_agent_policy_get", {})
    await expect(fetchPersonAgentPolicy({ call })).rejects.toMatchObject({
      code: "execution_isolation_unavailable",
    })
  })

  it("adr0253 o02 refuses a policy without the fields this Host version answers with", async () => {
    const { models: _models, ...noModels } = wire
    const { usage: _usage, ...noUsage } = wire
    const { resumeAfterRestart: _resume, ...noResume } = wire
    for (const answer of [
      noModels,
      noUsage,
      noResume,
      { ...wire, models: { anthropic: ["ok"], openai: "gpt" } },
      { ...wire, models: { broken: [1] } },
      {
        ...wire,
        usage: { month: "2026-10", spentTokens: -1, reservedTokens: 0, monthlyTokens: null },
      },
    ]) {
      const call = jest.fn().mockResolvedValueOnce(answer)
      await expect(fetchPersonAgentPolicy({ call })).rejects.toMatchObject({
        code: "execution_isolation_unavailable",
      })
    }
    // No usage ledger on this Host is a real answer, and so is an uncapped month.
    const call = jest
      .fn()
      .mockResolvedValueOnce({ ...wire, usage: null })
      .mockResolvedValueOnce({ ...wire, usage: { ...policy.usage, monthlyTokens: null } })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toMatchObject({ usage: null })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toMatchObject({
      usage: { monthlyTokens: null },
    })
  })

  it("keeps the deployment's model names for served models only, and omits an empty map", async () => {
    const { usage: _usage, ...rest } = wire
    const call = jest
      .fn()
      .mockResolvedValueOnce({
        ...rest,
        usage: null,
        models: { anthropic: ["ok", "other"], openai: ["gpt"] },
        modelNames: {
          anthropic: { ok: "Okay Model", other: "", unserved: "Ghost" },
          openai: { gpt: "x".repeat(201) },
          broken: "nope",
          missing: { m: "Not served" },
        },
      })
      .mockResolvedValueOnce({ ...rest, usage: null, models: { anthropic: ["ok"] } })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toMatchObject({
      models: { anthropic: ["ok", "other"], openai: ["gpt"] },
      modelNames: { anthropic: { ok: "Okay Model" } },
    })
    // A deployment that names none leaves the field out.
    const plain = await fetchPersonAgentPolicy({ call })
    expect("modelNames" in plain).toBe(false)
  })

  it("keeps the deployment's valid prices for served models and remembers them (ADR-0253 §10)", async () => {
    rememberPersonModelPricing({ stale: { m: { promptPer1M: 9, completionPer1M: 9 } } })
    const { usage: _usage, ...rest } = wire
    const call = jest
      .fn()
      .mockResolvedValueOnce({
        ...rest,
        usage: null,
        models: { anthropic: ["ok", "bad"], openai: ["gpt"] },
        modelPricing: {
          anthropic: {
            ok: { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 },
            bad: { promptPer1M: -1, completionPer1M: 1 },
            unserved: { promptPer1M: 1, completionPer1M: 1 },
          },
          openai: { gpt: { promptPer1M: 1 } },
          broken: "nope",
        },
      })
      .mockResolvedValueOnce({ ...rest, usage: null, models: { anthropic: ["ok"] } })
    const priced = {
      anthropic: { ok: { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 } },
    }
    await expect(fetchPersonAgentPolicy({ call })).resolves.toMatchObject({ modelPricing: priced })
    expect(currentPersonModelPricing()).toEqual(priced)
    // A Host that prices nothing leaves the field out and clears what was remembered.
    const plain = await fetchPersonAgentPolicy({ call })
    expect("modelPricing" in plain).toBe(false)
    expect(currentPersonModelPricing()).toEqual({})
  })

  it("adr0253 resumes after a restart only when the Host says exactly true", async () => {
    const call = jest.fn().mockResolvedValueOnce({ ...wire, resumeAfterRestart: true })
    await expect(fetchPersonAgentPolicy({ call })).resolves.toEqual({
      ...policy,
      resumeAfterRestart: true,
    })
    call.mockResolvedValueOnce(wire)
    expect("resumeAfterRestart" in (await fetchPersonAgentPolicy({ call }))).toBe(false)
    for (const value of ["true", 1, null, undefined]) {
      call.mockResolvedValueOnce({ ...wire, resumeAfterRestart: value })
      await expect(fetchPersonAgentPolicy({ call })).rejects.toMatchObject({
        code: "execution_isolation_unavailable",
      })
    }
  })
})
