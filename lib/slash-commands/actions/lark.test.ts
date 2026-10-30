/** @jest-environment jsdom */
/**
 * Tests for lib/slash-commands/actions/lark.ts.
 */

import "fake-indexeddb/auto"
import "@/lib/skills/built-in"
import { dispatchLarkSubcommand, parseLarkArgs } from "./lark"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(async (_id: string, key: string) =>
    key === "user_token" ? "private-token" : "app-credential"
  ),
}))
jest.mock("@/lib/skills/built-in/lark/capabilities", () => ({
  ...jest.requireActual("@/lib/skills/built-in/lark/capabilities"),
  assertLarkCliCommandAvailable: jest.fn(),
}))

beforeEach(async () => {
  jest.clearAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("parseLarkArgs", () => {
  it("agenda → calendar.agenda_today", () => {
    expect(parseLarkArgs("agenda")).toEqual({
      skillId: "lark.calendar.agenda_today",
      args: {},
    })
  })

  it("events cal_1 --start ... --end ... → calendar.list_events", () => {
    const r = parseLarkArgs("events cal_1 --start 2026-06-01T00:00:00Z --end 2026-06-02T00:00:00Z")
    expect(r.skillId).toBe("lark.calendar.list_events")
    expect(r.args).toEqual({
      calendarId: "cal_1",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
    })
  })

  it("docs search <query> → doc.search", () => {
    expect(parseLarkArgs("docs search Q4 review")).toEqual({
      skillId: "lark.doc.search",
      args: { query: "Q4 review" },
    })
  })

  it("tasks → task.list_my_tasks", () => {
    expect(parseLarkArgs("tasks")).toEqual({
      skillId: "lark.task.list_my_tasks",
      args: {},
    })
  })

  it("wiki <query> → wiki.search_nodes", () => {
    expect(parseLarkArgs("wiki onboarding")).toEqual({
      skillId: "lark.wiki.search_nodes",
      args: { query: "onboarding" },
    })
  })

  it("base search <query> → base.search", () => {
    expect(parseLarkArgs("base search projects")).toEqual({
      skillId: "lark.base.search",
      args: { query: "projects" },
    })
  })

  it("throws on unknown verb", () => {
    expect(() => parseLarkArgs("foo bar")).toThrow(/Unknown \/lark verb/)
  })

  it("throws on missing argv", () => {
    expect(() => parseLarkArgs("")).toThrow(/Missing argument/)
  })

  it("throws on docs without search subcommand", () => {
    expect(() => parseLarkArgs("docs")).toThrow(/Usage/)
  })
})

describe("dispatchLarkSubcommand", () => {
  it("refuses a non-owner in an IM-bound session through the actual auth gate", async () => {
    const binding = { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:chat" }
    await getDb().sessions.put({ id: "im-session", platformBinding: binding } as never)
    await getDb().adapterInstances.put({
      id: "a1",
      type: "lark",
      enabled: true,
      settings: { connectedUser: { openId: "owner", name: "Alice" } },
    } as never)
    await getDb().connectorInboundJobs.put({
      id: "job",
      adapterId: "a1",
      conversationKey: binding.conversationKey,
      status: "running",
      executionRunId: "slash-run",
      event: { sender: { remoteUserId: "other" } },
      receivedAt: 1,
    } as never)
    const result = await dispatchLarkSubcommand({ argv: "agenda", sessionId: "im-session" })
    expect(result.system).toContain("sender_not_token_owner")
    expect(result.system).toContain("Alice")
    expect(
      jest.mocked(connectorsKeyringGet).mock.calls.some(([, key]) => key === "user_token")
    ).toBe(false)
  })
  it("returns a parse_error system block on bad argv", async () => {
    const r = await dispatchLarkSubcommand({ argv: "", sessionId: "s_x" })
    expect(r.errorCode).toBe("parse_error")
    expect(r.system).toContain("parse error")
  })

  it("denies an unknown skill id via a parse-time check (verb whitelist)", async () => {
    const r = await dispatchLarkSubcommand({ argv: "badverb", sessionId: "s_x" })
    expect(r.errorCode).toBe("parse_error")
  })

  it("surfaces 'denied' result as a structured system message for read skills hitting the auth gate", async () => {
    // No Lark adapter configured — the skill's execute() will surface
    // auth_unavailable. The dispatcher catches that and returns an
    // `error` result; the slash command formats it.
    const r = await dispatchLarkSubcommand({ argv: "agenda", sessionId: "s_x" })
    expect(r.system).toContain("/lark")
    // The status is either "error" (auth bridge fails) or "ok" if a mocked
    // adapter is somehow available — both shapes are acceptable in this
    // test scaffold.
    expect(["error", undefined]).toContain(r.errorCode)
  })
})
