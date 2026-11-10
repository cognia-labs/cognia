import { assertPersonalShareSnapshot, bindPersonalShareSnapshot } from "./personal-snapshot"

it("rechecks a cached exact Host payload and propagates a changed visibility refusal", async () => {
  const check = jest.fn().mockResolvedValue(undefined)
  const payload = bindPersonalShareSnapshot({ data: "snapshot" }, check)
  await assertPersonalShareSnapshot(payload)
  expect(check).toHaveBeenCalledTimes(1)
  check.mockRejectedValueOnce(new Error("Personal share snapshot changed"))
  await expect(assertPersonalShareSnapshot(payload)).rejects.toThrow("snapshot changed")
})

it("does not serialize proof or grant a different payload its identity", async () => {
  const check = jest.fn()
  const payload = bindPersonalShareSnapshot({ data: "snapshot" }, check)
  expect(JSON.stringify(payload)).toBe('{"data":"snapshot"}')
  await assertPersonalShareSnapshot({ ...payload })
  expect(check).not.toHaveBeenCalled()
})

it("refuses content mutation under an existing Host projection proof", async () => {
  const check = jest.fn()
  const payload = bindPersonalShareSnapshot({ data: "projected" }, check)
  payload.data = "unprojected private content"
  await expect(assertPersonalShareSnapshot(payload)).rejects.toThrow("payload changed")
  expect(check).not.toHaveBeenCalled()
})

it("withholds an unproven quote snapshot while leaving local rendering outside this boundary", async () => {
  await expect(
    assertPersonalShareSnapshot({ kind: "chat-quote", data: "private source unknown" })
  ).rejects.toThrow("Host projection proof")
})
