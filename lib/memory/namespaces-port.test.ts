const mockInvalidate = jest.fn(async (_twinId: string) => 3)
jest.mock("./twin-lifecycle", () => ({
  invalidateTwinMemoryNamespace: (twinId: string) => mockInvalidate(twinId),
}))

import { port } from "./namespaces-port"

it("retires a twin's namespace through the memory lifecycle", async () => {
  await expect(port.invalidateTwinNamespace("twin-1")).resolves.toBe(3)
  expect(mockInvalidate).toHaveBeenCalledWith("twin-1")
})
