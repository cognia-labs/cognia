jest.mock("@/lib/mcp/sync-coordinator", () => ({
  __esModule: true,
  scheduleMcpSyncDrain: jest.fn(),
}))

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { isMcpSecretRef } from "@/lib/mcp/credentials"
import {
  PERSONAL_DATA_SOURCE_PRESETS,
  findPersonalSourceMcpServer,
  getPersonalDataSourcePreset,
  parseCommandArgsLine,
  setPersonalSourceEnabled,
  upsertPersonalSourceMcpServer,
} from "./presets"

const dbFixture = createDbTestFixture()

function makeMemoryKeyring(): { store: KeyringStore; values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    store: {
      save: async (key, value) => {
        values.set(key, value)
      },
      load: async (key) => values.get(key) ?? null,
      delete: async (key) => {
        values.delete(key)
      },
    },
  }
}

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("personal-sources presets (F7)", () => {
  it("defines Lark, Gmail, Google Calendar, and Outlook presets with governed outbound write tools", () => {
    expect(PERSONAL_DATA_SOURCE_PRESETS.map((p) => p.id)).toEqual([
      "lark",
      "gmail",
      "google-calendar",
      "outlook",
    ])
    expect(getPersonalDataSourcePreset("gmail").outboundWriteTools).toContain("send_email")
    expect(getPersonalDataSourcePreset("outlook").outboundWriteTools).toContain("send_mail")
    expect(parseCommandArgsLine("  -y   @cocal/google-calendar-mcp ")).toEqual([
      "-y",
      "@cocal/google-calendar-mcp",
    ])
  })

  it("externalizes MCP secrets to keyring and preserves trust across command overrides", async () => {
    const { store, values } = makeMemoryKeyring()
    const created = await upsertPersonalSourceMcpServer({
      sourceId: "gmail",
      secretValue: "super-secret-oauth-client",
      enabled: true,
      credentialStore: store,
    })

    expect(created.enabled).toBe(true)
    expect(created.trust?.state).toBe("trusted")
    const env = (created.config as { env?: Record<string, unknown> }).env ?? {}
    expect(isMcpSecretRef(env.GMAIL_CLIENT_SECRET)).toBe(true)
    expect(JSON.stringify(created.config)).not.toContain("super-secret-oauth-client")
    expect([...values.values()]).toContain("super-secret-oauth-client")

    // Updating command/args without re-entering secret preserves the secretRef and enabled state!
    const updated = await upsertPersonalSourceMcpServer({
      sourceId: "gmail",
      command: "uvx",
      args: ["custom-gmail-mcp"],
      enabled: true,
      credentialStore: store,
    })
    expect(updated.enabled).toBe(true)
    expect(updated.trust?.state).toBe("trusted")
    expect((updated.config as { command?: string }).command).toBe("uvx")
    const updatedEnv = (updated.config as { env?: Record<string, unknown> }).env ?? {}
    expect(isMcpSecretRef(updatedEnv.GMAIL_CLIENT_SECRET)).toBe(true)

    await setPersonalSourceEnabled("gmail", false)
    const afterDisable = await findPersonalSourceMcpServer("gmail")
    expect(afterDisable?.enabled).toBe(false)
  })
})
