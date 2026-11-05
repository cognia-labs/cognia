/**
 * @jest-environment jsdom
 */

/**
 * The `github_write_back` producer against the real database: which jobs land
 * on the trail, on which issues, exactly once, and how a job that settles
 * after the call returned (or after its window closed) still gets there.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { listIssueEvents } from "@/lib/db/issue-events"
import { onIssueEvent } from "@/lib/issues/event-bus"
import { buildActivityData } from "@/lib/issues/wakeups/bridge"
import type { IssueEvent } from "@/types/issues"
import type { IntegrationActionJob } from "@/types/plugin/plugin-integration"
import {
  GITHUB_DELIVERY_PLUGIN_ID,
  GITHUB_INTEGRATION_ID,
  reconcileGithubWritebacks,
  recordGithubWritebackJob,
  stopGithubWritebackTracking,
  trackGithubWritebackJob,
} from "./github-writeback"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(stopGithubWritebackTracking)

const HUMAN = { kind: "human" } as const
const REF = { repoFullName: "acme/app", number: 7, htmlUrl: "https://github.com/acme/app/issues/7" }

let containerId: string
beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function linkedIssue(title = "Linked") {
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title,
    createdBy: HUMAN,
    githubRef: REF,
  })
}

let jobSeq = 0
async function addJob(over: Partial<IntegrationActionJob> = {}): Promise<IntegrationActionJob> {
  jobSeq += 1
  const row: IntegrationActionJob = {
    id: `job-${jobSeq}`,
    pluginId: GITHUB_DELIVERY_PLUGIN_ID,
    integrationId: GITHUB_INTEGRATION_ID,
    accountId: "acct-1",
    actionId: "closeIssue",
    input: { repoFullName: "acme/app", issueNumber: 7, reason: "completed" },
    status: "succeeded",
    risk: "destructive",
    idempotencyKey: `issue-writeback:acme/app#7:close:${jobSeq}`,
    attempts: 1,
    maxAttempts: 5,
    source: "manual",
    createdAt: "2026-11-05T01:00:00.000Z",
    updatedAt: "2026-11-05T01:00:05.000Z",
    ...over,
  }
  await getDb().integrationActionJobs.add(row)
  return row
}

async function writebacks(issueId: string): Promise<IssueEvent[]> {
  return (await listIssueEvents({ issueId })).filter((e) => e.kind === "github_write_back")
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe("recordGithubWritebackJob", () => {
  it("appends one entry to every issue linked to the GitHub issue, at the job's time", async () => {
    const a = await linkedIssue("A")
    const b = await linkedIssue("B")
    const other = await createIssue({
      projectId: "w1",
      issueProjectId: containerId,
      title: "Unlinked",
      createdBy: HUMAN,
    })
    const job = await addJob()

    const recorded = await recordGithubWritebackJob(job)

    expect(recorded.map((e) => e.issueId).sort()).toEqual([a.id, b.id].sort())
    const [entry] = await writebacks(a.id)
    expect(entry).toMatchObject({
      ts: Date.parse("2026-11-05T01:00:05.000Z"),
      payload: { kind: "github_write_back", action: "close", ref: REF, jobId: job.id, by: HUMAN },
    })
    expect(await writebacks(other.id)).toEqual([])
  })

  it("records a job once, however many times it is offered", async () => {
    const issue = await linkedIssue()
    const job = await addJob({
      actionId: "commentIssue",
      input: { repoFullName: "acme/app", issueNumber: 7, body: "hi" },
    })
    await recordGithubWritebackJob(job)
    await Promise.all([recordGithubWritebackJob(job), recordGithubWritebackJob(job)])
    const entries = await writebacks(issue.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.payload).toMatchObject({ action: "comment" })
  })

  it("ignores jobs that are not board write-backs or did not land", async () => {
    const issue = await linkedIssue()
    for (const over of [
      { status: "failed" as const },
      { status: "queued" as const },
      { idempotencyKey: "issue-publish:i1:acme/app" },
      { idempotencyKey: undefined },
      { actionId: "createIssue" },
      { pluginId: "other-plugin" },
      { input: { repoFullName: "acme/app" } },
    ]) {
      expect(await recordGithubWritebackJob(await addJob(over))).toEqual([])
    }
    expect(await writebacks(issue.id)).toEqual([])
  })

  it("builds the ref from the link when the issue only has an external ref", async () => {
    const issue = await linkedIssue()
    // Drop the denormalised `githubRef`, keeping the `externalRefs` entry.
    await getDb().issues.update(issue.id, { githubRef: undefined })
    await recordGithubWritebackJob(await addJob())
    expect((await writebacks(issue.id))[0]!.payload).toMatchObject({ ref: REF })
  })

  it("publishes after commit, as an entry a wakeup rule can match", async () => {
    const issue = await linkedIssue()
    const seen: IssueEvent[] = []
    const off = onIssueEvent((event) => seen.push(event), { kinds: ["github_write_back"] })
    await recordGithubWritebackJob(await addJob())
    off()
    expect(seen).toHaveLength(1)
    expect(buildActivityData(seen[0]!, undefined)).toMatchObject({
      issueId: issue.id,
      kind: "github_write_back",
      actor: HUMAN,
      summary: "close pushed to GitHub acme/app#7",
    })
  })
})

describe("trackGithubWritebackJob", () => {
  it("records a queued job once it succeeds", async () => {
    const issue = await linkedIssue()
    const job = await addJob({ status: "queued" })
    trackGithubWritebackJob(job.id)
    trackGithubWritebackJob(job.id)
    await settle()
    expect(await writebacks(issue.id)).toEqual([])

    await getDb().integrationActionJobs.update(job.id, { status: "running" })
    await settle()
    await getDb().integrationActionJobs.update(job.id, { status: "succeeded" })
    await settle()
    expect(await writebacks(issue.id)).toHaveLength(1)
  })

  it("records nothing for a job that ends failed, and stops watching it", async () => {
    const issue = await linkedIssue()
    const job = await addJob({ status: "retry_wait" })
    trackGithubWritebackJob(job.id)
    await settle()
    await getDb().integrationActionJobs.update(job.id, { status: "failed" })
    await settle()
    // A later (impossible) flip is no longer observed.
    await getDb().integrationActionJobs.update(job.id, { status: "succeeded" })
    await settle()
    expect(await writebacks(issue.id)).toEqual([])
  })
})

describe("reconcileGithubWritebacks", () => {
  it("records landed jobs the trail is missing and watches the ones still running", async () => {
    const issue = await linkedIssue()
    await addJob()
    const recordedAlready = await addJob()
    await recordGithubWritebackJob(recordedAlready)
    const pending = await addJob({ status: "retry_wait" })
    await addJob({ status: "failed" })
    await addJob({ idempotencyKey: "someone-else" })

    expect(await reconcileGithubWritebacks()).toEqual({ recorded: 1, tracking: 1 })
    expect(await writebacks(issue.id)).toHaveLength(2)

    await getDb().integrationActionJobs.update(pending.id, { status: "succeeded" })
    await settle()
    expect(await writebacks(issue.id)).toHaveLength(3)
    // Idempotent on the next boot.
    expect(await reconcileGithubWritebacks()).toEqual({ recorded: 0, tracking: 0 })
  })
})
