/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { updateTwinSource } from "@/lib/db/twin-sources"
import { registerTwinSource } from "./source-registration"
import { twinSourceProvenance } from "./source-registration"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().twinSources.clear()
})

const draft = {
  twinId: "twin-a",
  kind: "document" as const,
  format: "markdown" as const,
  source: "same body",
  title: "Notes",
  bytes: 9,
  redacted: false,
}

it("reuses an active source with the same Twin fingerprint", async () => {
  const first = await registerTwinSource(draft)
  const second = await registerTwinSource({ ...draft, title: "Duplicate title" })

  expect(first.created).toBe(true)
  expect(second).toMatchObject({ created: false, revived: false })
  expect(second.source.id).toBe(first.source.id)
  expect(await getDb().twinSources.count()).toBe(1)
})

it("retains portable capture fields through registration and duplicate/retry paths", async () => {
  const remoteDocument = {
    v: 1 as const,
    providerId: "lark",
    resourceKind: "doc" as const,
    resourceId: "doc-token",
    title: "Notes",
    url: "",
    fetchedAt: 1,
    completeness: { status: "complete" as const },
    captureId: crypto.randomUUID(),
    connectionScoped: true as const,
  }
  const first = await registerTwinSource({ ...draft, remoteDocument })
  expect(twinSourceProvenance(first.source)).toEqual(remoteDocument)
  const duplicate = await registerTwinSource(draft)
  expect(duplicate.source.captureId).toBe(remoteDocument.captureId)
  await updateTwinSource(first.source.id, { status: "failed" })
  const revived = await registerTwinSource(draft)
  expect(twinSourceProvenance(revived.source)).toEqual(remoteDocument)
})

it("revives a failed source instead of creating a duplicate", async () => {
  const first = await registerTwinSource(draft)
  await updateTwinSource(first.source.id, { status: "failed", errorMessage: "offline" })

  const retried = await registerTwinSource({ ...draft, title: "Retried notes" })

  expect(retried).toMatchObject({ created: false, revived: true })
  expect(retried.source).toMatchObject({
    id: first.source.id,
    title: "Retried notes",
    status: "pending",
    chunkCount: 0,
  })
  expect(retried.source.errorMessage).toBeUndefined()
})

it("isolates identical content by Twin", async () => {
  const first = await registerTwinSource(draft)
  const second = await registerTwinSource({ ...draft, twinId: "twin-b" })

  expect(second.source.id).not.toBe(first.source.id)
  expect(await getDb().twinSources.count()).toBe(2)
})
