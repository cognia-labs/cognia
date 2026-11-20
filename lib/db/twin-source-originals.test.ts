import type { TwinSource } from "@/types/twin"
import { messageMediaRefRows, isMessageOwnedMediaRef } from "./message-media-refs"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { deleteAllTwinSourcesForTwin, deleteTwinSource } from "./twin-sources"
import { deleteTwin } from "./twins"
import {
  collectReleasedTwinSourceOriginals,
  describeTwinSourceOriginal,
  holdTwinSourceOriginal,
  isTwinSourceOriginalKey,
  listTwinSourceOriginalMediaKeys,
  readTwinSourceOriginal,
  reconcileTwinSourceOriginals,
  twinSourceOriginalOwnerKey,
} from "./twin-source-originals"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

async function sourceWithOriginal(
  id: string,
  body: string,
  twinId = "twin-1"
): Promise<TwinSource> {
  const blob = new Blob([body], { type: "application/pdf" })
  const original = await describeTwinSourceOriginal(blob, `${id}.pdf`, "application/pdf")
  const source: TwinSource = {
    id,
    twinId,
    kind: "document",
    format: "pdf",
    source: "",
    title: `${id}.pdf`,
    bytes: blob.size,
    fingerprint: original.contentHash,
    chunkCount: 0,
    status: "pending",
    importedAt: 1,
    redacted: false,
    original,
  }
  const db = getDb()
  await db.transaction("rw", db.twinSources, db.messageMedia, db.messageMediaRefs, async () => {
    await db.twinSources.put(source)
    await holdTwinSourceOriginal(id, original, blob)
  })
  return source
}

describe("twin source originals", () => {
  it("describes a file by its SHA-256 and keys its bytes as an original", async () => {
    const original = await describeTwinSourceOriginal(new Blob(["abc"]), "a.pdf", "")

    expect(original).toEqual({
      mediaKey: "original:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      contentHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      byteLength: 3,
      mediaType: "application/octet-stream",
      filename: "a.pdf",
    })
    expect(isTwinSourceOriginalKey(original)).toBe(true)
    expect(isTwinSourceOriginalKey({ ...original, mediaKey: "original:other" })).toBe(false)
    expect(isTwinSourceOriginalKey({ ...original, contentHash: "../x" })).toBe(false)
  })

  it("stores the bytes once and reads them back for the source", async () => {
    const source = await sourceWithOriginal("s1", "%PDF-1.7 one")

    expect(await (await readTwinSourceOriginal(source))!.text()).toBe("%PDF-1.7 one")
    expect(await readTwinSourceOriginal({ original: undefined })).toBeUndefined()
    expect(
      await readTwinSourceOriginal({ original: { ...source.original!, byteLength: 1 } })
    ).toBeUndefined()
    expect(await listTwinSourceOriginalMediaKeys()).toEqual([source.original!.mediaKey])
  })

  it("is held by a ref no conversation owns, which media GC still counts", async () => {
    const source = await sourceWithOriginal("s1", "%PDF-1.7 one")
    const [ref] = await getDb()
      .messageMediaRefs.where("messageId")
      .equals(twinSourceOriginalOwnerKey("s1"))
      .toArray()

    expect(ref).toMatchObject({ sessionId: "twin:sources", hash: source.original!.mediaKey })
    expect(isMessageOwnedMediaRef(ref)).toBe(false)
    expect(await collectReleasedTwinSourceOriginals([source.original!.mediaKey])).toBe(0)
    expect(await getDb().messageMedia.get(source.original!.mediaKey)).toBeDefined()
    expect(() => messageMediaRefRows("twin-source:x", "s", [])).toThrow("reserved_twin_source")
    expect(() => messageMediaRefRows("m", "twin:sources", [])).toThrow("reserved_twin_source")
  })

  it("collects the bytes with the last source that held them", async () => {
    const one = await sourceWithOriginal("s1", "%PDF-same")
    await sourceWithOriginal("s2", "%PDF-same")

    await deleteTwinSource("s1")
    expect(await getDb().messageMedia.get(one.original!.mediaKey)).toBeDefined()

    await deleteTwinSource("s2")
    expect(await getDb().messageMedia.get(one.original!.mediaKey)).toBeUndefined()
    expect(await getDb().messageMediaRefs.count()).toBe(0)
  })

  it("releases every source's bytes when the twin or all its sources are deleted", async () => {
    const a = await sourceWithOriginal("a", "%PDF-a", "twin-a")
    const b = await sourceWithOriginal("b", "%PDF-b", "twin-b")
    await getDb().twins.put({ id: "twin-a", name: "A", createdAt: 1, updatedAt: 1 } as never)

    await deleteTwin("twin-a", { skipExternalCleanup: true })
    expect(await getDb().messageMedia.get(a.original!.mediaKey)).toBeUndefined()

    await deleteAllTwinSourcesForTwin("twin-b")
    expect(await getDb().messageMedia.get(b.original!.mediaKey)).toBeUndefined()
  })

  it("rebuilds owner rows after a restore and drops originals whose bytes did not arrive", async () => {
    const kept = await sourceWithOriginal("kept", "%PDF-kept")
    const lost = await sourceWithOriginal("lost", "%PDF-lost")
    const db = getDb()
    // A restore that brought the rows and only one file, and a stale owner row.
    await db.messageMediaRefs.clear()
    await db.messageMedia.delete(lost.original!.mediaKey)
    await db.messageMediaRefs.put({
      messageId: twinSourceOriginalOwnerKey("gone"),
      sessionId: "twin:sources",
      hash: kept.original!.mediaKey,
    })

    const released = await db.transaction(
      "rw",
      db.twinSources,
      db.messageMedia,
      db.messageMediaRefs,
      () => reconcileTwinSourceOriginals()
    )

    expect(released).toEqual([kept.original!.mediaKey])
    expect((await db.messageMediaRefs.toArray()).map((ref) => [ref.messageId, ref.hash])).toEqual([
      [twinSourceOriginalOwnerKey("kept"), kept.original!.mediaKey],
    ])
    expect((await db.twinSources.get("lost"))?.original).toBeUndefined()
    expect((await db.twinSources.get("kept"))?.original).toEqual(kept.original)
    // Still held by "kept", so collecting what was released keeps it.
    expect(await collectReleasedTwinSourceOriginals(released)).toBe(0)
  })
})
