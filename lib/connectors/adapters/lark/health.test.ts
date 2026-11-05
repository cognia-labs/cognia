import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))
jest.mock("@/lib/auth-providers/feishu/auth", () => ({ getTenantToken: jest.fn() }))

import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantToken } from "@/lib/auth-providers/feishu/auth"
import { pingLark } from "./health"

const row = { id: "lark-1", type: "lark", settings: {} } as unknown as AdapterInstanceRow

function credentials(appId: string | null, appSecret: string | null) {
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_id, key) => (key === "appId" ? appId : appSecret) as never)
}

describe("pingLark", () => {
  beforeEach(() => jest.resetAllMocks())

  it("asks bot/v3/info with an adapter-admin tenant token", async () => {
    credentials("cli_a", "secret")
    jest.mocked(getTenantToken).mockResolvedValue("t-1")
    jest.mocked(connectorsHttpRequest).mockResolvedValue({ status: 200 } as never)
    await expect(pingLark(row)).resolves.toBe(true)
    expect(getTenantToken).toHaveBeenCalledWith(
      { appId: "cli_a", appSecret: "secret" },
      "adapter-admin"
    )
    expect(connectorsHttpRequest).toHaveBeenCalledWith({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: "Bearer t-1" },
      timeoutMs: 5_000,
    })
  })

  it("fails without credentials, without a token, or on a non-2xx answer", async () => {
    credentials(null, "secret")
    await expect(pingLark(row)).resolves.toBe(false)
    credentials("cli_a", "secret")
    jest.mocked(getTenantToken).mockResolvedValue("")
    await expect(pingLark(row)).resolves.toBe(false)
    jest.mocked(getTenantToken).mockResolvedValue("t-1")
    jest.mocked(connectorsHttpRequest).mockResolvedValue({ status: 401 } as never)
    await expect(pingLark(row)).resolves.toBe(false)
    expect(getTenantToken).toHaveBeenCalledTimes(2)
  })

  it("reports a thrown request as a failed ping", async () => {
    credentials("cli_a", "secret")
    jest.mocked(getTenantToken).mockRejectedValue(new Error("offline"))
    await expect(pingLark(row)).resolves.toBe(false)
  })
})
