import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ConnectorVendorAvatarContext } from "@/lib/connectors/vendor-contribution"

jest.mock("./build", () => ({ buildLarkAdapter: jest.fn(async () => ({ id: "built" })) }))
jest.mock("./whoami", () => ({ probeBotIdentity: jest.fn() }))
jest.mock("@/lib/auth-providers/feishu/oauth-handler", () => ({
  handleLarkOAuth: jest.fn(async () => undefined),
}))
jest.mock("./health", () => ({ pingLark: jest.fn(async () => true) }))
jest.mock("./avatar", () => ({ resolveLarkAvatar: jest.fn(async () => ({ url: "https://a" })) }))
jest.mock("./surface-schedule", () => ({
  startLarkSurfaceSweep: jest.fn(),
  startBindRequestExpirySweep: jest.fn(),
}))

import { larkContribution } from "./contribution"
import { LARK_CAPS } from "./capability"
import { buildLarkAdapter } from "./build"
import { probeBotIdentity } from "./whoami"
import { handleLarkOAuth } from "@/lib/auth-providers/feishu/oauth-handler"
import { pingLark } from "./health"
import { resolveLarkAvatar } from "./avatar"
import { startBindRequestExpirySweep, startLarkSurfaceSweep } from "./surface-schedule"

const row = (settings: Record<string, unknown> = {}) =>
  ({ id: "lark-1", type: "lark", settings }) as unknown as AdapterInstanceRow

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("larkContribution", () => {
  beforeEach(() => jest.clearAllMocks())

  it("serves the lark platform with its static capabilities", () => {
    expect(larkContribution.platform).toBe("lark")
    expect(larkContribution.capabilities).toBe(LARK_CAPS)
  })

  it("imports only light constants eagerly", () => {
    const source = readFileSync(join(__dirname, "contribution.ts"), "utf8")
    const eager = [...source.matchAll(/^import\s+(?!type\b)[^"']*["']([^"']+)["']/gm)].map(
      (match) => match[1]
    )
    expect(eager).toEqual(["./capability"])
  })

  it("delegates adapter construction, the identity probe and OAuth completion", async () => {
    await expect(larkContribution.buildAdapter!(row())).resolves.toEqual({ id: "built" })
    expect(buildLarkAdapter).toHaveBeenCalledWith(row())
    await expect(larkContribution.loadIdentityProbe!()).resolves.toBe(probeBotIdentity)
    await larkContribution.completeOAuth!("code-1", "state-1")
    expect(handleLarkOAuth).toHaveBeenCalledWith("code-1", { state: "state-1" })
  })

  it("treats only webhook transport as passive and pings through the bot info call", async () => {
    const passive = larkContribution.passiveTransport!
    expect(passive.applies(row({ transport: "webhook" }))).toBe(true)
    expect(passive.applies(row({ transport: "long-connection" }))).toBe(false)
    expect(passive.applies(row())).toBe(false)
    await expect(passive.ping(row({ transport: "webhook" }))).resolves.toBe(true)
    expect(pingLark).toHaveBeenCalled()
    expect(passive.failureReason).toBe("lark_ping_failed")
  })

  it("trusts Feishu and Lark CDN hosts and delegates avatar lookup", async () => {
    expect(larkContribution.avatar!.hosts).toEqual(
      expect.arrayContaining(["feishucdn.com", "larksuitecdn.com"])
    )
    const context = {} as ConnectorVendorAvatarContext
    await expect(larkContribution.avatar!.resolve(context)).resolves.toEqual({ url: "https://a" })
    expect(resolveLarkAvatar).toHaveBeenCalledWith(context)
  })

  it("starts both sweeps once loaded and disposes them on teardown", async () => {
    const surface = { dispose: jest.fn() }
    const expiry = { dispose: jest.fn() }
    jest.mocked(startLarkSurfaceSweep).mockReturnValue(surface as never)
    jest.mocked(startBindRequestExpirySweep).mockReturnValue(expiry as never)
    const services = larkContribution.startRuntimeServices!()
    expect(services).toHaveLength(1)
    await flush()
    expect(startLarkSurfaceSweep).toHaveBeenCalledTimes(1)
    expect(startBindRequestExpirySweep).toHaveBeenCalledTimes(1)
    services[0].dispose()
    expect(surface.dispose).toHaveBeenCalledTimes(1)
    expect(expiry.dispose).toHaveBeenCalledTimes(1)
  })

  it("does not start the sweeps when disposed before the schedule loads", async () => {
    const services = larkContribution.startRuntimeServices!()
    services[0].dispose()
    await flush()
    expect(startLarkSurfaceSweep).not.toHaveBeenCalled()
    expect(startBindRequestExpirySweep).not.toHaveBeenCalled()
  })
})
