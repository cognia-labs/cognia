import { readResolvedPrincipal } from "./resolved-principal"

describe("readResolvedPrincipal", () => {
  it("reads a well-formed stamp and drops anything else on it", () => {
    expect(
      readResolvedPrincipal({
        resolvedPrincipal: { principalId: "pr_1", accountId: "acc_1", extra: true },
      })
    ).toEqual({ principalId: "pr_1", accountId: "acc_1" })
  })

  it.each([
    undefined,
    {},
    { resolvedPrincipal: null },
    { resolvedPrincipal: "pr_1" },
    { resolvedPrincipal: { principalId: "pr_1" } },
    { resolvedPrincipal: { principalId: 1, accountId: "acc_1" } },
  ])("is undefined without a complete stamp: %j", (channelData) => {
    expect(
      readResolvedPrincipal(channelData as Record<string, unknown> | undefined)
    ).toBeUndefined()
  })
})
