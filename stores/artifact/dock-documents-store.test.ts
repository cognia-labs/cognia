/** @jest-environment jsdom */
import {
  persistedDockDocuments,
  selectActiveDockDocument,
  useDockDocumentsStore,
  type DockDocumentTab,
} from "./dock-documents-store"

const tab = (id = "d1"): DockDocumentTab => ({
  id,
  providerId: "lark",
  resourceKind: "doc",
  resourceId: "abcdefghijklmnop1234",
  url: "",
  title: "Report",
  view: "snapshot",
  openedAt: Date.now(),
})
beforeEach(() => {
  localStorage.clear()
  useDockDocumentsStore.setState({ bySession: {} })
})

it("drops ephemeral tabs and all authority/body fields from durable descriptors", () => {
  useDockDocumentsStore.getState().put("s", tab())
  expect(JSON.parse(localStorage.getItem("cognia-dock-documents-v1")!).state.bySession).toEqual({})
  useDockDocumentsStore.getState().put("s", {
    ...tab("sent"),
    snapshotRef: { kind: "asset", assetId: "a", messageId: "m" },
    accountId: "secret-account",
    authorizationEpoch: "epoch",
    text: "private body",
  } as DockDocumentTab)
  const saved = localStorage.getItem("cognia-dock-documents-v1")!
  expect(saved).toContain('"assetId":"a"')
  for (const secret of ["secret-account", "epoch", "private body"])
    expect(saved).not.toContain(secret)
})
it("owns the active pointer and chooses a surviving document on close", () => {
  const store = useDockDocumentsStore.getState()
  store.put("s", tab())
  store.put("s", tab("d2"))
  store.activate("s", "d1")
  expect(selectActiveDockDocument(useDockDocumentsStore.getState(), "s")?.id).toBe("d1")
  store.activate("s", "absent")
  store.remove("s", "d1")
  expect(selectActiveDockDocument(useDockDocumentsStore.getState(), "s")?.id).toBe("d2")
  store.removeSession("s")
  expect(selectActiveDockDocument(useDockDocumentsStore.getState(), "s")).toBeNull()
})
it.each([
  null,
  [],
  "garbage",
  { bySession: [] },
  { bySession: { s: { documents: [null, {}], lastUsedAt: Date.now() } } },
])("rejects malformed persisted input %p", (value) => {
  expect(persistedDockDocuments(value)).toEqual({ bySession: {} })
})
it("ignores unknown versions and validates even same-version merge", async () => {
  const options = useDockDocumentsStore.persist.getOptions()
  const state = {
    bySession: {
      s: {
        documents: [{ ...tab(), snapshotRef: { kind: "asset", assetId: "a" } }],
        activeDocumentTabId: "missing",
        lastUsedAt: Date.now(),
      },
    },
  }
  expect(await options.migrate!(state, 99)).toEqual({ bySession: {} })
  expect(
    options.merge!(state, useDockDocumentsStore.getState()).bySession.s.activeDocumentTabId
  ).toBe("d1")
  expect(
    options.merge!(
      { bySession: { s: { documents: ["garbage"] } } },
      useDockDocumentsStore.getState()
    ).bySession
  ).toEqual({})
})
it("prunes at 30 days and 200 sessions", () => {
  const bySession = Object.fromEntries(
    Array.from({ length: 205 }, (_, i) => [
      `s${i}`,
      {
        documents: [{ ...tab(), snapshotRef: { kind: "asset", assetId: "a" } }],
        activeDocumentTabId: "d1",
        lastUsedAt: Date.now() - i,
      },
    ])
  )
  bySession.old = { ...bySession.s0, lastUsedAt: Date.now() - 31 * 86400000 }
  const result = persistedDockDocuments({ bySession }).bySession
  expect(Object.keys(result)).toHaveLength(200)
  expect(result.old).toBeUndefined()
})
it("keeps runtime actions callable after hydrating whitelisted descriptors", async () => {
  localStorage.setItem(
    "cognia-dock-documents-v1",
    JSON.stringify({
      version: 1,
      state: {
        bySession: {
          s: {
            documents: [{ ...tab(), snapshotRef: { kind: "asset", assetId: "a" } }],
            activeDocumentTabId: "d1",
            lastUsedAt: Date.now(),
          },
        },
        put: "untrusted persisted action",
      },
    })
  )
  await useDockDocumentsStore.persist.rehydrate()
  expect(selectActiveDockDocument(useDockDocumentsStore.getState(), "s")?.id).toBe("d1")
  useDockDocumentsStore.getState().put("s", tab("next"))
  expect(selectActiveDockDocument(useDockDocumentsStore.getState(), "s")?.id).toBe("next")
})
