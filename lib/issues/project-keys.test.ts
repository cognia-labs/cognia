/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject, deleteIssueProject } from "@/lib/db/issue-projects"
import {
  issueProjectKeysStore,
  NO_ISSUE_PROJECT_KEYS,
  resetIssueProjectKeysStoresForTesting,
} from "./project-keys"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  resetIssueProjectKeysStoresForTesting()
})
afterAll(dbFixture.dispose)

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("issueProjectKeysStore", () => {
  it("follows project creation and deletion in its own workspace only", async () => {
    const store = issueProjectKeysStore("w1")
    const listener = jest.fn()
    const stop = store.subscribe(listener)
    const merc = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
    await createIssueProject({ projectId: "w2", name: "Other", key: "OTH" })
    await settle()
    expect([...store.getSnapshot()]).toEqual(["MERC"])

    await deleteIssueProject(merc.id)
    await settle()
    expect(store.getSnapshot().size).toBe(0)
    expect(listener).toHaveBeenCalled()
    stop()
  })

  it("is one shared store per workspace, and keeps its snapshot after the last subscriber", async () => {
    await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
    const store = issueProjectKeysStore("w1")
    expect(issueProjectKeysStore("w1")).toBe(store)
    const stop = store.subscribe(() => {})
    await settle()
    stop()
    expect(store.getSnapshot().has("MERC")).toBe(true)
  })

  it("does not notify when a write leaves the key set unchanged", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
    const store = issueProjectKeysStore("w1")
    const listener = jest.fn()
    const stop = store.subscribe(listener)
    await settle()
    const calls = listener.mock.calls.length
    const before = store.getSnapshot()
    const { updateIssueProject } = await import("@/lib/db/issue-projects")
    await updateIssueProject(project.id, { name: "Mercury 2" })
    await settle()
    expect(listener.mock.calls.length).toBe(calls)
    expect(store.getSnapshot()).toBe(before)
    stop()
  })

  it("has no keys without a workspace", () => {
    expect(issueProjectKeysStore(null).getSnapshot()).toBe(NO_ISSUE_PROJECT_KEYS)
    expect(issueProjectKeysStore(undefined).subscribe(() => {})).toEqual(expect.any(Function))
  })
})
