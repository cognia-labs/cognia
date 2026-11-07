const mockCreate = jest.fn(async (_twinId: string) => ({ datasetId: "d1", caseCount: 4 }))
jest.mock("@/lib/ai/eval/twin-benchmark", () => ({
  createTwinBenchmark: (twinId: string) => mockCreate(twinId),
}))

import { port } from "./benchmarks-port"

it("builds a twin benchmark through the eval engine", async () => {
  await expect(port.createTwinBenchmark("twin-1")).resolves.toEqual({
    datasetId: "d1",
    caseCount: 4,
  })
  expect(mockCreate).toHaveBeenCalledWith("twin-1")
})
