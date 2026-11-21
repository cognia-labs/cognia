/**
 * @jest-environment node
 */
import path from "node:path"

import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import { serializeManifest, type SessionManifest } from "../agent/session-store/manifest"
import { manifestPath, sessionsRoot, type SessionStoreFs } from "../agent/session-store/paths"
import type { ResolvedConfig } from "../config/schema"
import { attributeModel, formatUsageRow, readProviderUsage, readSessionManifests } from "./usage"
import type { ReadUsageDeps } from "./usage"

const HOME = "/home/u/.cognia"
const NOW = Date.parse("2026-09-02T12:00:00Z")
const DAY = 86_400_000

const CONFIG: ResolvedConfig = {
  provider: "openai",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: { openai: { apiKey: "o" }, deepseek: { apiKey: "d" }, groq: { apiKey: "g" } },
  cwd: "/w",
}

/** Catalog stand-in: one exclusive model each, plus one alias shared by two. */
const catalog = (id: string): string[] =>
  ({
    openai: ["gpt-4o", "shared-alias"],
    deepseek: ["deepseek-chat", "shared-alias"],
    groq: ["llama-3.3-70b"],
  })[id] ?? []

function manifest(
  id: string,
  updatedAt: number,
  extra: Partial<SessionManifest> = {}
): SessionManifest {
  return {
    manifestVersion: 1,
    sessionId: id,
    createdAt: new Date(updatedAt - 1000).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    workspace: "ws",
    turnCount: 1,
    sequenceDigest: "d",
    eventCount: 2,
    ...extra,
  }
}

function fakeFs(manifests: SessionManifest[]): SessionStoreFs {
  const files = new Map<string, string>()
  for (const m of manifests) files.set(manifestPath(HOME, m.sessionId), serializeManifest(m))
  files.set(manifestPath(HOME, "corrupt"), "{not json")
  const root = sessionsRoot(HOME)
  const dirs = new Set([...manifests.map((m) => m.sessionId), "corrupt", "empty-dir"])
  return {
    exists: (p) => p === root || files.has(p),
    isDirectory: (p) => p === root || dirs.has(path.basename(p)),
    readFile: (p) => files.get(p) ?? null,
    writeFileAtomic: () => undefined,
    appendFile: () => undefined,
    mkdirp: () => undefined,
    readdir: (dir) => (dir === root ? [...dirs] : []),
    removeFile: () => undefined,
    removeDir: () => undefined,
    writeFileExclusive: () => true,
    mtimeMs: () => null,
  }
}

const MANIFESTS: SessionManifest[] = [
  // Bound to a provider: exact.
  manifest("s-exact", NOW - DAY, {
    runtimeBinding: { backend: "builtin", model: "gpt-4o", provider: "openai" },
    usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 },
  }),
  // No binding, model listed by exactly one configured provider: catalog.
  manifest("s-catalog", NOW - 2 * DAY, {
    runtimeBinding: { backend: "builtin", model: "deepseek-chat" },
    usage: { inputTokens: 500, outputTokens: 50 },
  }),
  // No binding, alias shared by two providers: approximate, active wins.
  manifest("s-alias", NOW - 3 * DAY, {
    runtimeBinding: { backend: "builtin", model: "shared-alias" },
    usage: { inputTokens: 10, outputTokens: 5 },
  }),
  // Inside the window, nothing spent.
  manifest("s-empty", NOW - 4 * DAY, { usage: { inputTokens: 0, outputTokens: 0 } }),
  // Outside the window.
  manifest("s-old", NOW - 30 * DAY, {
    runtimeBinding: { backend: "builtin", model: "gpt-4o", provider: "openai" },
    usage: { inputTokens: 99_999, outputTokens: 99_999 },
  }),
]

/** The local ledger per provider, as `readLocalProviderUsage` answers it. */
const readLocalUsage: NonNullable<ReadUsageDeps["readLocalUsage"]> = jest.fn(
  async (providerId: string) => {
    if (providerId === "groq") throw new Error("ledger read failed")
    return providerId === "openai"
      ? [
          {
            model: "gpt-4o",
            turns: 3,
            inputTokens: 300,
            outputTokens: 30,
            costUsd: 0.003,
            unpricedTurns: 0,
          },
        ]
      : []
  }
)

describe("readSessionManifests", () => {
  it("walks the sessions root and skips corrupt or empty entries", () => {
    const found = readSessionManifests(HOME, fakeFs(MANIFESTS))
    expect(found.map((m) => m.sessionId).sort()).toEqual(
      ["s-alias", "s-catalog", "s-empty", "s-exact", "s-old"].sort()
    )
    expect(readSessionManifests("/nowhere", fakeFs([]))).toEqual([])
  })
})

describe("attributeModel", () => {
  it("prefers the binding, then a single catalog hit, and marks aliases approximate", () => {
    expect(attributeModel("gpt-4o", "openai", CONFIG, catalog)).toEqual({
      providerId: "openai",
      attribution: "exact",
    })
    expect(attributeModel("deepseek-chat", undefined, CONFIG, catalog)).toEqual({
      providerId: "deepseek",
      attribution: "catalog",
    })
    expect(attributeModel("shared-alias", undefined, CONFIG, catalog)).toEqual({
      providerId: "openai",
      attribution: "approximate",
    })
    expect(attributeModel("mystery", undefined, CONFIG, catalog)).toEqual({
      attribution: "approximate",
    })
  })
})

describe("readProviderUsage", () => {
  it("joins the ledger with the session manifests and states the attribution", async () => {
    const ensureDb = jest.fn(async () => undefined)
    const report = await readProviderUsage({
      config: CONFIG,
      readLocalUsage,
      home: HOME,
      now: () => NOW,
      ensureDb,
      fsx: fakeFs(MANIFESTS),
      modelCatalog: catalog,
    })
    expect(ensureDb).toHaveBeenCalledTimes(1)
    expect(report.to).toBe(NOW)
    expect(report.from).toBe(NOW - 7 * DAY)

    expect(report.ledger.rows).toEqual([
      {
        providerId: "openai",
        model: "gpt-4o",
        attribution: "exact",
        turns: 3,
        inputTokens: 300,
        outputTokens: 30,
        costUsd: 0.003,
        costKnown: true,
        unpricedTurns: 0,
      },
    ])
    expect(report.ledger.failures.map((f) => f.providerId)).toEqual(["groq"])
    expect(report.ledger.failures[0]!.failure.failure.message).toBe("ledger read failed")

    expect(report.sessions.scanned).toBe(4)
    expect(report.sessions.withoutUsage).toBe(1)
    expect(report.sessions.catalogAttributed).toBe(1)
    expect(report.sessions.approximate).toBe(1)
    const byModel = Object.fromEntries(report.sessions.rows.map((r) => [r.model, r]))
    expect(byModel["gpt-4o"]).toMatchObject({
      providerId: "openai",
      attribution: "exact",
      turns: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.01,
      costKnown: true,
    })
    expect(byModel["deepseek-chat"]).toMatchObject({
      providerId: "deepseek",
      attribution: "catalog",
    })
    expect(byModel["shared-alias"]).toMatchObject({
      providerId: "openai",
      attribution: "approximate",
    })
    // A model no pricing layer knows is reported unknown, never $0.00.
    expect(byModel["shared-alias"]!.costKnown).toBe(false)
  })

  it("reports an unpriced ledger model as unknown and a partly priced one as a lower bound (F11)", async () => {
    const report = await readProviderUsage({
      config: CONFIG,
      readLocalUsage: async (providerId) =>
        providerId === "openai"
          ? [
              {
                model: "local-model",
                turns: 2,
                inputTokens: 10,
                outputTokens: 1,
                costUsd: 0,
                unpricedTurns: 2,
              },
              {
                model: "gpt-4o",
                turns: 2,
                inputTokens: 10,
                outputTokens: 1,
                costUsd: 0.25,
                unpricedTurns: 1,
              },
            ]
          : [],
      home: HOME,
      now: () => NOW,
      ensureDb: async () => undefined,
      fsx: fakeFs([]),
      modelCatalog: catalog,
    })
    const byModel = Object.fromEntries(report.ledger.rows.map((r) => [r.model, r]))
    expect(byModel["local-model"]).toMatchObject({ costKnown: false, unpricedTurns: 2 })
    expect(formatUsageRow(byModel["local-model"]!)).toMatch(/cost unknown$/)
    expect(formatUsageRow(byModel["gpt-4o"]!)).toMatch(/≥ \$0\.2500$/)
  })

  it("counts only sessions that ran inside the window, and reports the ones that span it (F11)", async () => {
    const report = await readProviderUsage({
      config: CONFIG,
      readLocalUsage: async () => [],
      home: HOME,
      now: () => NOW,
      ensureDb: async () => undefined,
      fsx: fakeFs([
        manifest("s-inside", NOW - DAY, {
          runtimeBinding: { backend: "builtin", model: "gpt-4o", provider: "openai" },
          usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
        }),
        // Began a month ago, last ran yesterday: its total is mostly old spend.
        {
          ...manifest("s-long", NOW - DAY, {
            runtimeBinding: { backend: "builtin", model: "gpt-4o", provider: "openai" },
            usage: { inputTokens: 99_999, outputTokens: 99_999, costUsd: 50 },
          }),
          createdAt: new Date(NOW - 30 * DAY).toISOString(),
        },
      ]),
      modelCatalog: catalog,
    })
    expect(report.sessions.scanned).toBe(2)
    expect(report.sessions.spanning).toBe(1)
    expect(report.sessions.rows).toEqual([
      expect.objectContaining({ model: "gpt-4o", inputTokens: 10, costUsd: 0.01 }),
    ])
  })

  it("scopes both ledgers to --provider", async () => {
    const report = await readProviderUsage({
      config: CONFIG,
      readLocalUsage,
      home: HOME,
      providerId: "deepseek",
      now: () => NOW,
      ensureDb: async () => undefined,
      fsx: fakeFs(MANIFESTS),
      modelCatalog: catalog,
    })
    expect(report.ledger.rows).toEqual([])
    expect(report.ledger.failures).toEqual([])
    expect(report.sessions.rows.map((r) => r.model)).toEqual(["deepseek-chat"])
  })

  it("keeps the session ledger when the database cannot open", async () => {
    const report = await readProviderUsage({
      config: CONFIG,
      readLocalUsage,
      home: HOME,
      now: () => NOW,
      ensureDb: async () => {
        throw new Error("snapshot corrupt")
      },
      fsx: fakeFs(MANIFESTS),
      modelCatalog: catalog,
    })
    expect(report.ledger.unavailable).toBe("snapshot corrupt")
    expect(report.ledger.rows).toEqual([])
    expect(report.sessions.rows.length).toBe(3)
  })

  it("refuses an inverted window", async () => {
    await expect(
      readProviderUsage({
        config: CONFIG,
        readLocalUsage,
        home: HOME,
        from: NOW,
        to: NOW - 1,
        ensureDb: async () => undefined,
        fsx: fakeFs([]),
      })
    ).rejects.toThrow(/window/)
  })
})

describe("formatUsageRow", () => {
  it("marks catalog and approximate attribution and never prints an unknown cost as free", () => {
    expect(
      formatUsageRow({
        providerId: "openai",
        model: "gpt-4o",
        attribution: "exact",
        turns: 1,
        inputTokens: 1500,
        outputTokens: 2_000_000,
        costUsd: 0.5,
        costKnown: true,
        unpricedTurns: 0,
      })
    ).toBe("  openai           gpt-4o                           in    1.5k  out    2.0M  $0.5000")
    expect(
      formatUsageRow({
        model: "mystery",
        attribution: "approximate",
        turns: 1,
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0,
        costKnown: false,
        unpricedTurns: 1,
      })
    ).toMatch(/^~ \?\s+mystery\s+in\s+5\s+out\s+5\s+cost unknown$/)
  })
})
