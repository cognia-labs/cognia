/** @jest-environment jsdom */
import {
  connectionAccess,
  connectionMetadata,
  registerHostAuthProviderService,
} from "./connection-access"
import { getAuthProviderOwner } from "./auth-provider-registry"
import { getPlugin } from "@/lib/db/plugins"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"

jest.mock("./auth-provider-registry", () => ({ getAuthProviderOwner: jest.fn() }))
jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))

beforeEach(() => {
  jest.mocked(getAuthProviderOwner).mockReturnValue("owner")
  jest.mocked(getPlugin).mockImplementation(
    async (id) =>
      ({
        manifest:
          id === "owner"
            ? { providesServices: { "auth.vendor": "1.0.0" } }
            : id === "required"
              ? { requiresServices: { "auth.vendor": "^1" } }
              : id === "optional"
                ? { optionalServices: { "auth.vendor": "^1" } }
                : {},
      }) as never
  )
})

it.each([
  ["owner", true],
  ["required", true],
  ["optional", true],
  ["unrelated", false],
])("visibility for %s is %s", async (id, expected) => {
  const access = connectionAccess(id, () => {})
  expect(await access.visible({ providerId: "vendor", ownerPluginId: "owner" })).toBe(expected)
  expect(await access.visible({ providerId: "vendor", ownerPluginId: "owner" }, "different")).toBe(
    false
  )
})

it("starts with an empty Host provider/service map and supports explicit registration", async () => {
  jest.mocked(getAuthProviderOwner).mockReturnValue(null)
  const access = connectionAccess("required", () => {})
  const row = { providerId: "vendor", ownerPluginId: null }
  expect(await access.visible(row)).toBe(false)
  const dispose = registerHostAuthProviderService("vendor", "auth.vendor")
  try {
    expect(await access.visible(row, "auth.vendor")).toBe(true)
    expect(await connectionAccess("unrelated", () => {}).visible(row)).toBe(false)
  } finally {
    dispose()
  }
  expect(await access.visible(row)).toBe(false)
})

it("refuses changed or unknown provider owners", async () => {
  const access = connectionAccess("owner", () => {})
  expect(await access.visible({ providerId: "vendor", ownerPluginId: "previous" })).toBe(false)
  jest.mocked(getAuthProviderOwner).mockReturnValue(undefined)
  expect(await access.visible({ providerId: "vendor", ownerPluginId: "owner" })).toBe(false)
})

it("does not interpret malformed stored service maps as declarations", async () => {
  jest.mocked(getPlugin).mockImplementation(
    async (id) =>
      ({
        manifest:
          id === "owner"
            ? { providesServices: { "auth.vendor": "1.0.0" } }
            : { requiresServices: "auth.vendor", optionalServices: ["auth.vendor"] },
      }) as never
  )
  expect(
    await connectionAccess("consumer", () => {}).visible({
      providerId: "vendor",
      ownerPluginId: "owner",
    })
  ).toBe(false)
})

it("projects only allowed metadata and copies scopes", () => {
  const row = {
    id: "ref",
    providerId: "vendor",
    accountLabel: "Account",
    principalKind: "user",
    issuer: "https://issuer.test",
    tenantLabel: "Org",
    scopes: ["read"],
    status: "connected",
    revision: 3,
    principalId: "private",
    clientId: "private",
    accessToken: "never",
  } as unknown as AuthConnectionRow
  expect(connectionMetadata(row)).toEqual({
    ref: "ref",
    providerId: "vendor",
    accountLabel: "Account",
    principalKind: "user",
    issuer: "https://issuer.test",
    tenantLabel: "Org",
    scopes: ["read"],
    status: "connected",
    revision: 3,
  })
  const metadata = connectionMetadata(row)
  metadata.scopes.push("write")
  expect(row.scopes).toEqual(["read"])
})

it("rechecks permission after a manifest await", async () => {
  let allowed = true
  jest.mocked(getPlugin).mockImplementationOnce(async () => {
    allowed = false
    return undefined
  })
  const check = () => {
    if (!allowed) throw new Error("revoked")
  }
  await expect(
    connectionAccess("required", check).visible({ providerId: "vendor", ownerPluginId: "owner" })
  ).rejects.toThrow("revoked")
})
