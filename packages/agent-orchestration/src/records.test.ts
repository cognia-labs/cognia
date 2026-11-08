import type { AgentTeamChildRun } from "./records"
import { createMemoryTeamRunStore } from "./memory-store"
import { contractChild, contractRun } from "./store-contract"

it("preserves a native resume id and visibility digest through durable record serialization", async () => {
  const store = createMemoryTeamRunStore()
  await store.createRun(contractRun())
  const child: AgentTeamChildRun = {
    ...contractChild(),
    sessionId: "native",
    personalVisibilityDigest: "personal-v1:owner",
  }
  await store.createChild(child)
  const restored = JSON.parse(JSON.stringify(await store.getChild(child.id))) as AgentTeamChildRun
  expect(restored).toMatchObject({
    sessionId: "native",
    personalVisibilityDigest: "personal-v1:owner",
  })
  await store.updateChild(child.id, {
    sessionId: undefined,
    personalVisibilityDigest: "personal-v1:other",
  })
  expect(await store.getChild(child.id)).toMatchObject({
    personalVisibilityDigest: "personal-v1:other",
  })
  expect((await store.getChild(child.id))?.sessionId).toBeUndefined()
})
