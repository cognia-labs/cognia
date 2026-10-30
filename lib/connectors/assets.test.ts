import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  rememberConnectorAssets,
  requireConnectorAsset,
  verifyConnectorAssetReferences,
  forgetConnectorAsset,
  collectConnectorAssetReferences,
  renewConnectorAssetReferences,
} from "./assets"
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
it("collects padded references from nested cards and renews only acknowledged owned assets", async () => {
  const reference = "qqbot-media://image/v1/token=="
  expect(
    collectConnectorAssetReferences(
      [{ card: { markdown: { content: `![x](${reference})` } } }],
      /qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=-]+/g
    )
  ).toEqual([reference])
  await rememberConnectorAssets("a", [
    { adapterId: "a", id: "x", reference, expiresAt: Date.now() + 1000 },
  ])
  const expiresAt = Date.now() + 90 * 86400_000
  await renewConnectorAssetReferences("other", [reference], expiresAt)
  expect((await requireConnectorAsset("a", "x")).expiresAt).not.toBe(expiresAt)
  await renewConnectorAssetReferences("a", [reference], expiresAt)
  expect((await requireConnectorAsset("a", "x")).expiresAt).toBe(expiresAt)
})
it("persists ownership across lookup and refuses a different adapter or an expired asset", async () => {
  const asset = {
    adapterId: "a",
    id: "image",
    reference: "native:image",
    expiresAt: Date.now() + 60_000,
  }
  await rememberConnectorAssets("a", [asset])
  expect(await requireConnectorAsset("a", "image")).toEqual(asset)
  await expect(verifyConnectorAssetReferences("a", ["native:image"])).resolves.toBeUndefined()
  await expect(verifyConnectorAssetReferences("other", ["native:image"])).rejects.toThrow(/adapter/)
  await expect(requireConnectorAsset("other", "image")).rejects.toThrow(/unknown/)
  await rememberConnectorAssets("a", [{ ...asset, expiresAt: Date.now() - 1 }])
  await expect(requireConnectorAsset("a", "image")).rejects.toThrow(/expired/)
})
it("deletes only the selected adapter's receipt and rejects foreign upload results", async () => {
  await expect(
    rememberConnectorAssets("a", [{ adapterId: "b", id: "x", reference: "native:x" }])
  ).rejects.toThrow(/adapter/)
  await rememberConnectorAssets("a", [{ adapterId: "a", id: "x", reference: "native:x" }])
  await forgetConnectorAsset("a", "x")
  await expect(requireConnectorAsset("a", "x")).rejects.toThrow(/unknown/)
})
