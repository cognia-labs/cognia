import type { PluginManifest } from "@/types/plugin"
import { collectPluginRuntimeProfileDiagnostics } from "./runtime-compatibility"
import { readFileSync } from "node:fs"
import { join } from "node:path"

function manifest(patch: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "demo.plugin",
    name: "Demo",
    version: "1.0.0",
    description: "Demo plugin",
    type: "frontend",
    capabilities: [],
    ...patch,
  }
}

describe("collectPluginRuntimeProfileDiagnostics", () => {
  it.each([
    "feishu-auth",
    "feishu-calendar",
    "example-auth-provider",
    "example-docs-provider",
    "example-backup-destination",
    "example-issue-sync",
    "example-sync",
  ])("keeps first-party runtime declarations honest: %s", (name) => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "plugins", name, "plugin.json"), "utf8")
    ) as PluginManifest
    for (const profile of ["browser", "tauri", "mobile", "headless"] as const) {
      const declared = manifest.runtimeCompatibility?.[profile]
      expect(declared).toBeDefined()
      const derived = collectPluginRuntimeProfileDiagnostics(manifest, profile)
      if (declared?.availability === "supported")
        expect(derived.filter((item) => item.severity === "error")).toEqual([])
      if (profile === "browser" || profile === "mobile") {
        expect(declared?.recovery).toEqual(["pair-with-desktop", "use-always-on-host"])
        expect(declared?.reason).toBe(
          name === "example-sync"
            ? "background-sync-unavailable"
            : "confidential-exchange-unavailable"
        )
      }
    }
  })
  it("accepts an explicitly supported Headless runtime", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ runtimeCompatibility: { headless: { availability: "supported" } } }),
        "headless"
      )
    ).toEqual([])
  })

  it("inherits browser compatibility for frontend Headless plugins", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ runtimeCompatibility: { browser: { availability: "supported" } } }),
        "headless"
      )
    ).toEqual([])
  })

  it("inherits Tauri compatibility for Node-target plugins", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({
          type: "hybrid",
          engines: { node: ">=20.0.0" },
          runtimeCompatibility: { tauri: { availability: "supported" } },
        }),
        "headless"
      )
    ).toEqual([])
  })

  it("reports degraded, blocked, and undeclared profiles", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({
          runtimeCompatibility: {
            headless: { availability: "degraded", reason: "No interactive UI" },
          },
        }),
        "headless"
      )
    ).toEqual([expect.objectContaining({ severity: "warning", code: "runtime.headless.degraded" })])
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ runtimeCompatibility: { headless: { availability: "blocked" } } }),
        "headless"
      )
    ).toEqual([
      expect.objectContaining({ severity: "error", code: "runtime.headless.unsupported" }),
    ])
    expect(collectPluginRuntimeProfileDiagnostics(manifest(), "browser")).toEqual([
      expect.objectContaining({ severity: "error", code: "runtime.browser.unsupported" }),
    ])
  })

  it("keeps the desktop profile unrestricted", () => {
    expect(collectPluginRuntimeProfileDiagnostics(manifest(), "tauri")).toEqual([])
  })

  it.each(["browser", "tauri", "mobile", "headless"] as const)(
    "blocks a device-code-only provider on %s including honest manifest warnings",
    (profile) => {
      const diagnostics = collectPluginRuntimeProfileDiagnostics(
        manifest({
          runtimeCompatibility: { [profile]: { availability: "supported" } },
          authProviders: [{ id: "device", label: "Device", methods: ["device-code"] }],
        }),
        profile
      )
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            reason: "device-code-deferred",
            recovery: ["use-another-method"],
          }),
          expect.objectContaining({
            severity: "warning",
            code: `runtime.${profile}.declaration-mismatch`,
          }),
        ])
      )
    }
  )

  it("warns for a partially usable provider, background sync and non-Host CORS", () => {
    const diagnostics = collectPluginRuntimeProfileDiagnostics(
      manifest({
        runtimeCompatibility: { mobile: { availability: "supported" } },
        authProviders: [
          { id: "mixed", label: "Mixed", methods: ["oauth-pkce", "client-credentials"] },
        ],
        permissions: ["sync:run"],
        networkAccess: { rules: [{ domain: "vendor.test", methods: ["GET"], paths: ["/*"] }] },
      }),
      "mobile"
    )
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.every((entry) => entry.severity === "warning")).toBe(true)
    expect(diagnostics.map((entry) => entry.reason)).toEqual([
      "confidential-exchange-unavailable",
      "background-sync-unavailable",
      "vendor-cors-required",
    ])
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ networkAccess: { allowedDomains: ["localhost"] } }),
        "tauri"
      )
    ).toEqual([])
  })

  it("derives confidential PKCE requirements from token endpoints", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({
          authProviders: [
            {
              id: "secret",
              label: "Secret",
              methods: ["oauth-pkce"],
              tokenEndpoints: [{ url: "https://vendor.test/token", clientSecret: "basic" }],
            },
          ],
        }),
        "browser"
      )
    ).toContainEqual(
      expect.objectContaining({ severity: "error", reason: "confidential-exchange-unavailable" })
    )
  })
})
