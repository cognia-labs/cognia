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
jest.mock("./command-cards", () => ({
  buildLarkCommandReply: jest.fn(() => ({
    type: "card",
    card: { kind: "lark", payload: "reply" },
  })),
  buildLarkStatusCard: jest.fn(() => ({ type: "card", card: { kind: "lark", payload: "status" } })),
}))
jest.mock("./approval-card", () => ({
  buildLarkClosedApprovalSegment: jest.fn(() => ({ type: "text", text: "closed" })),
}))
jest.mock("./card-kit", () => ({ larkReplyLocale: jest.fn(() => "en") }))
jest.mock("./result-card", () => ({
  withLarkResultCard: jest.fn((segments: unknown[]) => [
    ...segments,
    { type: "card", card: { kind: "lark", payload: "result" } },
  ]),
  splitLarkCardSegments: jest.fn((segments: Array<{ type: string }>) =>
    segments.length ? segments.map((segment) => [segment]) : []
  ),
  buildLarkResultCardSegment: jest.fn(() => ({
    type: "card",
    card: { kind: "lark", payload: "m" },
  })),
}))
jest.mock("./entry/deep-links", () => ({
  resolveWebEntryBase: jest.fn(() => "https://web.example"),
  buildRunDetailsUrl: jest.fn((runId: string) => `https://web.example/runs/${runId}`),
}))
jest.mock("./run-presentation/driver", () => ({
  buildLarkRunFallbackSegment: jest.fn(() => ({
    type: "card",
    card: { kind: "lark", payload: "f" },
  })),
}))
jest.mock("./principal/resolve", () => ({ resolveLarkPrincipal: jest.fn(async () => "resolved") }))
jest.mock("./principal/inbound", () => ({
  resolveLarkInboundPrincipal: jest.fn(async () => "inbound"),
}))
jest.mock("./principal/unbound", () => ({
  handleUnresolvedPrincipal: jest.fn(async () => undefined),
}))
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
import { buildLarkCommandReply, buildLarkStatusCard } from "./command-cards"
import { buildLarkClosedApprovalSegment } from "./approval-card"
import { larkReplyLocale } from "./card-kit"
import { buildLarkResultCardSegment, withLarkResultCard } from "./result-card"
import { buildLarkRunFallbackSegment } from "./run-presentation/driver"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { resolveLarkPrincipal } from "./principal/resolve"
import { resolveLarkInboundPrincipal } from "./principal/inbound"
import { handleUnresolvedPrincipal } from "./principal/unbound"
import type { RunProjectionSnapshot } from "@/types/execution/run"
import type { StatusView } from "@/lib/connectors/commands/render"

function event(overrides: {
  channel?: "private" | "group"
  scopeKind?: "private" | "group"
  replyInThread?: boolean
  menu?: boolean
}): NormalizedInboundEvent {
  return {
    platform: "lark",
    channel: { kind: overrides.channel ?? "group" },
    conversationRef: {
      platform: "lark",
      adapterId: "lark-1",
      ...(overrides.scopeKind ? { scopeKind: overrides.scopeKind } : {}),
      ...(overrides.replyInThread ? { replyInThread: true } : {}),
    },
    ...(overrides.menu ? { channelData: { larkMenuConversation: true } } : {}),
  } as unknown as NormalizedInboundEvent
}

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

  it("reads private topics as private and lists their sessions per chat", () => {
    const conversations = larkContribution.conversations!
    expect(conversations.isPrivate!(event({ channel: "private" }))).toBe(true)
    expect(conversations.isPrivate!(event({ scopeKind: "private" }))).toBe(true)
    expect(conversations.isPrivate!(event({}))).toBe(false)
    expect(
      conversations.chatScopedSessions!(event({ scopeKind: "private", replyInThread: true }))
    ).toBe(true)
    expect(conversations.chatScopedSessions!(event({ channel: "private", menu: true }))).toBe(true)
    expect(conversations.chatScopedSessions!(event({ channel: "private" }))).toBe(false)
    expect(conversations.chatScopedSessions!(event({ replyInThread: true }))).toBe(false)
    expect(conversations.deliveryProbe!(event({}))).toBe(true)
    expect(conversations.deliveryProbe!(event({ channel: "private" }))).toBe(false)
  })

  it("draws command replies, the status view and closed approval cards as Lark cards", async () => {
    await expect(larkContribution.commands!.renderReply!("mode", "ok", "applied")).resolves.toEqual(
      {
        type: "card",
        card: { kind: "lark", payload: "reply" },
      }
    )
    expect(buildLarkCommandReply).toHaveBeenCalledWith("mode", "ok", "applied")
    const view = {} as StatusView
    await larkContribution.commands!.renderStatus!(view)
    expect(buildLarkStatusCard).toHaveBeenCalledWith(view)
    await larkContribution.closedApprovalSegment!("answered", "**Q**")
    expect(buildLarkClosedApprovalSegment).toHaveBeenCalledWith("answered", "**Q**")
  })

  it("picks the turn locale from the message and titles the run from it", async () => {
    await expect(larkContribution.reply!.turnLocale!("hello there", "zh-CN")).resolves.toBe("en")
    expect(larkReplyLocale).toHaveBeenCalledWith("hello there", "zh-CN")
    expect(larkContribution.reply!.titleFromMessage).toBe(true)
  })

  it("groups the final answer around its result card and names only a group asker", async () => {
    const answer = [{ type: "markdown" as const, md: "answer" }]
    const context = {
      receivingAdapter: row(),
      presentationAdapter: row({ cardPresentation: { title: "T" } }),
      runId: "run-1",
      status: "done" as const,
      elapsedMs: 1200,
      privateChat: false,
      initiator: "ou_abc123",
      locale: "en",
    }
    const groups = await larkContribution.reply!.finalGroups!(answer, context)
    expect(groups).toHaveLength(2)
    expect(withLarkResultCard).toHaveBeenLastCalledWith(
      answer,
      expect.objectContaining({
        presentation: { title: "T" },
        status: "done",
        initiatorOpenId: "ou_abc123",
        detailsUrl: "https://web.example/runs/run-1",
      })
    )
    await larkContribution.reply!.finalGroups!(answer, { ...context, privateChat: true })
    expect(withLarkResultCard).toHaveBeenLastCalledWith(
      answer,
      expect.objectContaining({ initiatorOpenId: undefined })
    )
    await larkContribution.reply!.finalGroups!(answer, { ...context, initiator: "u-123" })
    expect(withLarkResultCard).toHaveBeenLastCalledWith(
      answer,
      expect.objectContaining({ initiatorOpenId: undefined })
    )
  })

  it("draws run milestones and fallback progress as Lark cards", async () => {
    const snapshot = {
      locale: "en",
      status: "cancelled",
      elapsedMs: 5,
      detailsUrl: "/runs/run-1",
    } as unknown as RunProjectionSnapshot
    const adapter = row({ cardPresentation: { title: "T" } })
    await larkContribution.runPresentation!.milestone(snapshot, { adapter, timeline: "timeline" })
    expect(buildLarkResultCardSegment).toHaveBeenCalledWith({
      locale: "en",
      presentation: { title: "T" },
      answer: "timeline",
      status: "interrupted",
      elapsedMs: 5,
      detailsUrl: "https://web.example/runs/run-1",
    })
    await larkContribution.runPresentation!.fallback(snapshot, adapter)
    expect(buildLarkRunFallbackSegment).toHaveBeenCalledWith(snapshot, "https://web.example", {
      title: "T",
    })
  })

  it("resolves principals through the Lark registry and answers unresolved senders", async () => {
    const principals = larkContribution.principals!
    const resolveInput = { platform: "lark" as const, adapterRow: row(), remoteUserId: "ou_1" }
    await expect(principals.resolve(resolveInput)).resolves.toBe("resolved")
    expect(resolveLarkPrincipal).toHaveBeenCalledWith(resolveInput)
    const inbound = { event: event({}), adapterRow: row(), activeAccountId: "acct" }
    await expect(principals.resolveInbound(inbound)).resolves.toBe("inbound")
    expect(resolveLarkInboundPrincipal).toHaveBeenCalledWith(inbound)
    const unbound = { status: "unbound" as const, openIdHash: "h" }
    await principals.handleUnresolved(event({}), row(), unbound, "job-1")
    expect(handleUnresolvedPrincipal).toHaveBeenCalledWith(event({}), row(), unbound, "job-1")
  })
})
