import { defineSyncDriver, syncCursorInvalid, syncRateLimited } from "./define-sync-driver"

it("retains driver inference and emits only safe serializable sync tags", async () => {
  const driver = defineSyncDriver({
    itemId: (item: { id: string }) => item.id,
    fetchPage: async () => ({ items: [{ id: "one" }], cursor: "next" }),
    applyPage: async () => {},
  })
  expect(driver.itemId({ id: "one" })).toBe("one")
  expect(() => syncRateLimited(1200)).toThrow(
    expect.objectContaining({
      name: "ExternalSyncRateLimited",
      syncError: "rate-limited",
      retryAfterMs: 1200,
    })
  )
  expect(() => syncCursorInvalid()).toThrow(
    expect.objectContaining({ name: "ExternalSyncCursorInvalid", syncError: "cursor-invalid" })
  )
})
