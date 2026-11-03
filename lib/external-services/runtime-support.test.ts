import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  EXTERNAL_SERVICE_RUNTIME_FACETS,
  EXTERNAL_SERVICE_RUNTIME_SUPPORT,
  assertRuntimeSupported,
  resolveAuthMethodSupport,
  renderRuntimeSupportTable,
  RuntimeSupportError,
} from "./runtime-support"

it("declares exactly one cell per profile and facet with typed refusal details", () => {
  expect(Object.keys(EXTERNAL_SERVICE_RUNTIME_SUPPORT).sort()).toEqual([
    "browser",
    "headless",
    "mobile",
    "tauri",
  ])
  for (const [profile, facets] of Object.entries(EXTERNAL_SERVICE_RUNTIME_SUPPORT)) {
    expect(Object.keys(facets).sort()).toEqual([...EXTERNAL_SERVICE_RUNTIME_FACETS].sort())
    for (const [facet, cell] of Object.entries(facets)) {
      const assert = () =>
        assertRuntimeSupported(
          facet as (typeof EXTERNAL_SERVICE_RUNTIME_FACETS)[number],
          profile as keyof typeof EXTERNAL_SERVICE_RUNTIME_SUPPORT
        )
      if (cell.availability === "blocked") {
        expect(assert).toThrow(RuntimeSupportError)
        try {
          assert()
        } catch (error) {
          expect(error).toMatchObject({
            code: "NOT_SUPPORTED",
            reason: cell.reason,
            recovery: cell.recovery,
          })
        }
      } else expect(assert).not.toThrow()
    }
  }
})

it("combines callback, secret exchange and persistence prerequisites", () => {
  expect(
    resolveAuthMethodSupport("oauth-pkce", "browser", {
      id: "secret",
      label: "Secret",
      tokenEndpoints: [{ url: "https://vendor.test/token", clientSecret: "json" }],
    })
  ).toMatchObject({ availability: "blocked", reason: "confidential-exchange-unavailable" })
  expect(resolveAuthMethodSupport("api-key", "browser")).toMatchObject({
    availability: "degraded",
    recovery: ["unlock-vault"],
  })
  expect(resolveAuthMethodSupport("device-code", "tauri")).toMatchObject({
    availability: "blocked",
    reason: "device-code-deferred",
  })
})

it.each(["en", "zh"])("keeps the %s plugin SDK runtime table identical to the matrix", (locale) => {
  const doc = readFileSync(
    join(process.cwd(), `docs/content/docs/${locale}/plugin-dev/author-sdk.mdx`),
    "utf8"
  )
  const table = doc
    .split("{/* external-service-runtime:start */}\n")[1]
    ?.split("\n{/* external-service-runtime:end */}")[0]
  expect(table).toBe(renderRuntimeSupportTable())
})
