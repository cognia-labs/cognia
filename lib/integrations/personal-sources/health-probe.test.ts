jest.mock("@/lib/mcp/sync-coordinator", () => ({
  __esModule: true,
  scheduleMcpSyncDrain: jest.fn(),
}))

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { probeAllPersonalDataSources, probePersonalDataSource } from "./health-probe"
import { setPersonalSourceEnabled, upsertPersonalSourceMcpServer } from "./presets"

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

describe("personal-sources health-probe (F7)", () => {
  it("reports desktop_required when no runtime host is available", async () => {
    const all = await probeAllPersonalDataSources({ hostAvailable: false, now: 1_000 })
    expect(all.lark.status).toBe("desktop_required")
    expect(all.gmail.status).toBe("desktop_required")
    expect(all["google-calendar"].status).toBe("desktop_required")
    expect(all.outlook.status).toBe("desktop_required")
  })

  it("classifies Lark CLI missing, auth error, and healthy version states", async () => {
    const missing = await probePersonalDataSource("lark", {
      runLarkCli: async () => ({
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
        notFound: true,
        timedOut: false,
      }),
    })
    expect(missing.status).toBe("unconfigured")

    const reauth = await probePersonalDataSource("lark", {
      runLarkCli: async () => ({
        stdout: "",
        stderr: "token expired: please run lark-cli auth login",
        exitCode: 1,
        notFound: false,
        timedOut: false,
      }),
    })
    expect(reauth.status).toBe("reauth_required")

    const ready = await probePersonalDataSource("lark", {
      runLarkCli: async () => ({
        stdout: "lark-cli version 1.0.98",
        stderr: "",
        exitCode: 0,
        notFound: false,
        timedOut: false,
      }),
    })
    expect(ready).toMatchObject({ status: "ready", detectedVersion: "1.0.98" })
  })

  it("classifies MCP personal sources across unconfigured, ready, disabled, and missing-secret reauth_required", async () => {
    const { store, values } = makeMemoryKeyring()

    const initial = await probePersonalDataSource("outlook", { credentialStore: store })
    expect(initial.status).toBe("unconfigured")

    const server = await upsertPersonalSourceMcpServer({
      sourceId: "outlook",
      secretValue: "ms365-secret-val",
      enabled: true,
      credentialStore: store,
    })

    const ready = await probePersonalDataSource("outlook", { credentialStore: store })
    expect(ready).toMatchObject({ status: "ready", serverId: server.id })

    // Simulate evicted keyring secret -> reauth_required
    values.clear()
    const evicted = await probePersonalDataSource("outlook", { credentialStore: store })
    expect(evicted.status).toBe("reauth_required")

    // Restore secret, record 401 in mcpAuditLog -> reauth_required
    values.set(`mcp/${server.id}/env/MS365_CLIENT_SECRET`, "ms365-secret-val")
    await getDb().mcpAuditLog.add({
      id: "aud-1",
      ts: 5_000,
      serverId: server.id,
      direction: "outbound",
      phase: "connect",
      errorCode: "HTTP_401_UNAUTHORIZED",
    } as never)
    const auditAuthFail = await probePersonalDataSource("outlook", { credentialStore: store })
    expect(auditAuthFail.status).toBe("reauth_required")

    await setPersonalSourceEnabled("outlook", false)
    const disabled = await probePersonalDataSource("outlook", { credentialStore: store })
    expect(disabled.status).toBe("disabled")
  })
})
