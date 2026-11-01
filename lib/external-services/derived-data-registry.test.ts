import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  listDerivedDataPurgerIds,
  purgeDerivedData,
  registerDerivedDataPurger,
} from "./derived-data-registry"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("pins the Host purgers with connection provenance today", () => {
  expect(listDerivedDataPurgerIds()).toEqual([
    "integration-events",
    "integration-ingress",
    "integration-event-audit",
  ])
})

it("reports failures without throwing and independently runs all purgers", async () => {
  const target = { kind: "plugin-data" as const, pluginId: "consumer" }
  const good = jest.fn(async () => {})
  const bad = registerDerivedDataPurger({
    id: "broken",
    purge: async () => {
      throw new Error("private credential")
    },
  })
  const dispose = registerDerivedDataPurger({ id: "healthy", purge: good })
  try {
    const report = await purgeDerivedData(target)
    expect(good).toHaveBeenCalledWith(target)
    expect(report.failed).toEqual(["broken"])
    expect(report.purged).toContain("healthy")
    expect(JSON.stringify(report)).not.toContain("private credential")
  } finally {
    bad()
    dispose()
  }
})
