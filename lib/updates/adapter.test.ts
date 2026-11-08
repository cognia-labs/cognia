import { EXECUTOR_PRIMARY_ACTION, isInAppExecutor } from "@cognia/agent-config-types"

import {
  requireCatalog,
  type UpdateAdapter,
  type UpdateApplyContext,
  type UpdateItem,
} from "./adapter"

/**
 * The contract is types-only, so what is worth pinning is that a conforming
 * adapter compiles and that the row projection stays consistent with the
 * executor vocabulary it is derived from.
 */
const adapter: UpdateAdapter = {
  kind: "plugin",
  executor: "plugin-runtime",
  isSupported: () => true,
  check: async () => [],
  apply: async () => ({ state: "verified" }),
}

describe("UpdateAdapter", () => {
  it("carries download-only intent independently of consent (U01)", async () => {
    const contexts: UpdateApplyContext[] = []
    const desktop: UpdateAdapter = {
      kind: "desktop",
      executor: "tauri",
      isSupported: () => true,
      check: async () => [],
      apply: async (_candidate, context) => {
        contexts.push(context)
        return { state: context.downloadOnly ? "awaiting-consent" : "awaiting-restart" }
      },
    }
    expect(await desktop.apply({} as never, { consented: true, downloadOnly: true })).toEqual({
      state: "awaiting-consent",
    })
    expect(contexts).toEqual([{ consented: true, downloadOnly: true }])
  })
  it("distinguishes a catalog outage from missing configuration and an empty answer (U11)", () => {
    const context = { channel: "stable" as const, rolloutBucket: 0, manual: false, catalog: null }
    expect(() => requireCatalog({ ...context, catalogStatus: "unavailable" })).toThrow(
      "catalog_unavailable"
    )
    expect(() => requireCatalog({ ...context, catalogStatus: "unconfigured" })).toThrow(
      "catalog_unconfigured"
    )
    expect(requireCatalog({ ...context, catalog: [], catalogStatus: "ok" })).toEqual([])
    const error = new Error("signature verification failed")
    expect(() =>
      requireCatalog({ ...context, catalogStatus: "unavailable", catalogError: error })
    ).toThrow(error)
  })
  it("answers an empty check as everything current", async () => {
    expect(
      await adapter.check({ channel: "stable", rolloutBucket: 0, manual: false, catalog: null })
    ).toEqual([])
  })

  it("requires every adapter to implement apply, including store-backed ones", async () => {
    const store: UpdateAdapter = {
      kind: "mobile-ios",
      executor: "app-store",
      isSupported: () => false,
      check: async () => [],
      apply: async () => ({ state: "awaiting-store" }),
    }
    expect((await store.apply({} as never, { consented: true })).state).toBe("awaiting-store")
  })
})

describe("UpdateItem", () => {
  it("derives externallyInstalled from the executor, not from the asset kind", () => {
    const row: UpdateItem = {
      key: "mobile-ios:app",
      assetId: "app",
      kind: "mobile-ios",
      executor: "app-store",
      state: "available",
      candidate: null,
      currentVersion: "1.0.0",
      action: EXECUTOR_PRIMARY_ACTION["app-store"],
      externallyInstalled: !isInAppExecutor("app-store"),
    }
    expect(row.externallyInstalled).toBe(true)
    expect(row.action).toBe("open-store")
  })
})
