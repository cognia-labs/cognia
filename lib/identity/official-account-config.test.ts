import { officialDeployment } from "./official-deployment"
import {
  accountConfigUrl,
  fetchOfficialAccountConfig,
  resetOfficialAccountConfigCache,
} from "./official-account-config"

const deployment = officialDeployment({})!

beforeEach(() => {
  resetOfficialAccountConfigCache()
})

describe("official-account-config", () => {
  it("resolves /api/account/config on the issuer origin", () => {
    expect(accountConfigUrl("https://id.cognia.cn/api/auth")).toBe(
      "https://id.cognia.cn/api/account/config"
    )
  })

  it("parses known providers, preserves server order, and caches per issuer", async () => {
    const fetchImpl = jest.fn(async () =>
      Response.json({
        providers: ["github", "feishu", "unknown-future-idp", "github"],
        coolingOffDays: 14,
      })
    ) as unknown as typeof fetch

    const first = await fetchOfficialAccountConfig(deployment, { fetchImpl })
    expect(first).toEqual({
      providers: ["github", "feishu"],
      coolingOffDays: 14,
    })

    const second = await fetchOfficialAccountConfig(deployment, { fetchImpl })
    expect(second).toEqual(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await fetchOfficialAccountConfig(deployment, { fetchImpl, forceRefresh: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("returns null on HTTP error, malformed JSON, or network failure", async () => {
    expect(
      await fetchOfficialAccountConfig(deployment, {
        fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
      })
    ).toBeNull()

    expect(
      await fetchOfficialAccountConfig(deployment, {
        fetchImpl: (async () => Response.json({ coolingOffDays: 7 })) as unknown as typeof fetch,
      })
    ).toBeNull()

    expect(
      await fetchOfficialAccountConfig(deployment, {
        fetchImpl: (async () => {
          throw new Error("offline")
        }) as unknown as typeof fetch,
      })
    ).toBeNull()
  })
})
