/** @jest-environment jsdom */
// This integration test keeps the real form, persistence, registry, runner and engine.
// Only the plugin transport and scheduling are stubbed; no vendor credentials are used.
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIssueProject, getIssueProject } from "@/lib/db/issue-projects"
import { getIssueByExternalKey, updateIssue } from "@/lib/db/issues"
import { createIssuesAPI } from "@/lib/plugin/api/issues-api"
import { unregisterIssueSyncProvidersForPlugin } from "@/lib/plugin/bridge/issue-sync-providers-bridge"
import { getIssueSyncRegistry, resetIssueSyncRegistry } from "@/lib/issues/sync/registry"
import { resolveWorkspaceSyncBindings, runWorkspaceIssueSync } from "@/lib/issues/sync/runner"
import { issueSyncTarget } from "@/lib/issues/sync/engine"
import { exportAuthoredContent } from "@/lib/data/authored-content"
import { readDexieDelta } from "@/lib/sync/desktop-sync-source"
import { defineIssueSyncProvider } from "@cognia/plugin-sdk/api/issues"
import type {
  PluginIssueSyncProvider,
  PullResult,
  PushOutcome,
} from "@cognia/plugin-sdk/api/issues"
import { ProjectResourceDialog } from "./project-resource-dialog"
import { ProjectInspector } from "./projects/project-inspector"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  createGuardedAPI: (_id: string, api: unknown) => api,
  getPermissionGuard: () => ({ check: () => true }),
}))
jest.mock("@/lib/issues/github-sync-schedule", () => ({
  syncGithubIssueSchedule: async () => ({ action: "created", bindingCount: 1 }),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  resetIssueSyncRegistry()
})
afterEach(() => {
  unregisterIssueSyncProvidersForPlugin("acceptance")
  resetIssueSyncRegistry()
})
afterAll(fixture.dispose)

const definition = { id: "tracker", label: "Acme Tracker", schemaVersion: 1 }
const manifest = { id: "acceptance", issueSyncProviders: [definition] }
const providerId = "plugin:acceptance/tracker"
function provider(overrides: Partial<PluginIssueSyncProvider> = {}): PluginIssueSyncProvider {
  return defineIssueSyncProvider({
    id: definition.id,
    label: definition.label,
    pullFields: ["title"],
    pushFields: ["title"],
    resource: {
      label: definition.label,
      schemaVersion: 1,
      schema: {
        type: "object",
        properties: { project: { type: "string", title: "Remote project", minLength: 1 } },
        required: ["project"],
        mapping: {
          type: "object",
          properties: {
            title: { type: "string", title: "Title field", default: "Summary" },
            status: {
              type: "string",
              title: "Done status",
              enum: ["Closed", "Resolved"],
              default: "Closed",
            },
          },
          required: ["title"],
        },
      },
      describe: (config) => ({ key: String(config.project), label: String(config.project) }),
    },
    pull: async () => ({
      items: [
        {
          externalId: "remote-1",
          title: "Remote issue",
          status: "todo",
          remoteUpdatedAt: 1000,
          meta: { binding: "cannot-override-host-key" },
        },
      ],
      notModified: false,
    }),
    ...overrides,
  })
}

async function seedBinding() {
  return createIssueProject({
    projectId: "workspace",
    name: "Acme",
    key: "ACME",
    resources: [
      {
        kind: "plugin",
        providerId,
        schemaVersion: 1,
        config: { project: "remote", mapping: { title: "Summary", status: "Closed" } },
      },
    ],
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("registers, renders the schema/mapping, saves, syncs and resumes after disable/upgrade with the same watermark", async () => {
  const project = await createIssueProject({ projectId: "workspace", name: "Acme", key: "ACME" })
  const dialog = render(
    <ProjectResourceDialog open onOpenChange={jest.fn()} issueProjectId={project.id} roots={[]} />
  )
  act(() => {
    createIssuesAPI(manifest.id, manifest).registerSyncProvider(provider())
  })
  const user = userEvent.setup()
  await user.click(screen.getByRole("combobox", { name: "projects.resourceKind" }))
  await user.click(await screen.findByRole("option", { name: definition.label }))
  await user.type(screen.getByRole("textbox", { name: /Remote project/ }), "remote")
  let disposeOther!: () => void
  act(() => {
    disposeOther = getIssueSyncRegistry().register({
      ...getIssueSyncRegistry().get(providerId)!,
      id: "unrelated",
    })
  })
  expect(screen.getByRole("textbox", { name: /Remote project/ })).toHaveValue("remote")
  act(() => disposeOther())
  expect(screen.getByRole("textbox", { name: /Remote project/ })).toHaveValue("remote")
  expect(screen.getByRole("textbox", { name: /Title field/ })).toHaveValue("Summary")
  expect(screen.getByRole("group", { name: "projects.resourceMapping" })).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "projects.addResource" }))
  await waitFor(async () => expect((await getIssueProject(project.id))!.resources).toHaveLength(1))
  dialog.unmount()
  const saved = (await getIssueProject(project.id))!.resources[0]
  expect(saved).toEqual({
    kind: "plugin",
    providerId,
    schemaVersion: 1,
    name: "remote",
    config: { project: "remote", mapping: { title: "Summary", status: "Closed" } },
  })
  const first = await runWorkspaceIssueSync({ mirror: false })
  expect(first.outcomes[0].created).toBe(1)
  expect(first.failures).toEqual([])
  const imported = (await getIssueByExternalKey(providerId, "remote-1"))!
  expect(imported.externalRefs?.[0]).toMatchObject({
    provider: providerId,
    remoteUpdatedAt: 1000,
    meta: { binding: `${providerId}:remote` },
  })
  const inspector = render(
    <ProjectInspector
      project={(await getIssueProject(project.id))!}
      onPatch={jest.fn()}
      onClose={jest.fn()}
      onAddResource={jest.fn()}
      onRemoveResource={jest.fn()}
      onRequestDelete={jest.fn()}
      onOpenIssues={jest.fn()}
    />
  )
  act(() => unregisterIssueSyncProvidersForPlugin(manifest.id))
  expect(screen.getByText("projects.providerUnavailable")).toBeInTheDocument()
  expect((await runWorkspaceIssueSync({ mirror: false })).bindingCount).toBe(0)
  expect((await getIssueProject(project.id))!.resources[0]).toEqual(saved)
  const upgraded = provider()
  const pull = jest.fn(upgraded.pull)
  act(() => {
    createIssuesAPI(manifest.id, {
      ...manifest,
      issueSyncProviders: [{ ...definition, schemaVersion: 2 }],
    }).registerSyncProvider({
      ...upgraded,
      pull,
      resource: {
        ...upgraded.resource,
        schemaVersion: 2,
        migrate: (_version, config) => ({ ...config, extra: true }),
      },
    })
  })
  expect(screen.queryByText("projects.providerUnavailable")).not.toBeInTheDocument()
  const binding = (await resolveWorkspaceSyncBindings())[0]
  expect(binding.resource).toMatchObject({ schemaVersion: 2, config: { extra: true } })
  expect((await getDb().externalSyncCursors.get(issueSyncTarget(binding).key))?.cursor).toBe("1000")
  expect((await runWorkspaceIssueSync({ mirror: false })).failures).toEqual([])
  expect(pull).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ since: 1000 }))
  expect((await getIssueProject(project.id))!.resources[0]).toEqual(saved)
  inspector.unmount()
})

it("drops a late pull after disable without importing issues or moving the watermark", async () => {
  await seedBinding()
  const pending = deferred<PullResult>()
  const started = deferred<AbortSignal>()
  createIssuesAPI(manifest.id, manifest).registerSyncProvider(
    provider({
      pull: async (_binding, options) => {
        started.resolve(options.signal!)
        return pending.promise
      },
    })
  )
  const run = runWorkspaceIssueSync({ mirror: false })
  const signal = await started.promise
  unregisterIssueSyncProvidersForPlugin(manifest.id)
  expect(signal.aborted).toBe(true)
  pending.resolve(await provider().pull({} as never, {}))
  expect((await run).outcomes).toEqual([])
  expect(await getDb().issues.count()).toBe(0)
})

it("drops a late push after provider replacement without advancing its externalRef", async () => {
  await seedBinding()
  createIssuesAPI(manifest.id, manifest).registerSyncProvider(provider())
  await runWorkspaceIssueSync({ mirror: false })
  const issue = (await getIssueByExternalKey(providerId, "remote-1"))!
  await updateIssue(issue.id, { title: "Local edit" }, { kind: "human" })
  const pending = deferred<PushOutcome>()
  const started = deferred<AbortSignal>()
  const api = createIssuesAPI(manifest.id, manifest)
  api.registerSyncProvider(
    provider({
      pull: async () => ({ items: [], notModified: true }),
      push: async (_binding, _ref, _patch, _issue, context) => {
        started.resolve(context.signal!)
        return pending.promise
      },
    })
  )
  const before = (await getIssueByExternalKey(providerId, "remote-1"))!.externalRefs
  const run = runWorkspaceIssueSync({ mirror: false })
  const signal = await started.promise
  api.registerSyncProvider(provider())
  expect(signal.aborted).toBe(true)
  pending.resolve({ status: "applied", remoteUpdatedAt: 9000 })
  expect((await run).outcomes).toEqual([])
  expect((await getIssueByExternalKey(providerId, "remote-1"))!.externalRefs).toEqual(before)
  expect(
    (
      await getDb().externalSyncCursors.get(
        issueSyncTarget((await resolveWorkspaceSyncBindings())[0]).key
      )
    )?.cursor
  ).toBe("1000")
})

it("projects portable resources into real backup and companion delta payloads without device identity", async () => {
  await getDb().table("projects").put({
    id: "workspace",
    name: "Workspace",
    roots: [],
    sessionIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  })
  const project = await seedBinding()
  const sections = []
  for await (const section of exportAuthoredContent(getDb(), {
    includeSessions: false,
    includeApiKey: true,
    includeLocalStorage: false,
  }))
    sections.push(section)
  const backup = sections.find((section) => section.section === "issueProjects")!
  const delta = await readDexieDelta("issueProjects", 0)
  expect(backup.rows[0]).toMatchObject({ resources: project.resources })
  expect(delta.rows[0]).toMatchObject({ resources: project.resources })
  for (const payload of [backup, delta])
    expect(JSON.stringify(payload)).not.toMatch(/connectionRef|accountId|accessToken|deviceId/)
})

it("prefills migrated configuration and replaces the stored version only on explicit save", async () => {
  const project = await seedBinding()
  const original = project.resources[0]
  const implementation = provider()
  createIssuesAPI(manifest.id, {
    ...manifest,
    issueSyncProviders: [{ ...definition, schemaVersion: 2 }],
  }).registerSyncProvider({
    ...implementation,
    resource: {
      ...implementation.resource,
      schemaVersion: 2,
      migrate: (_version, config) => ({
        ...config,
        mapping: { title: "Migrated title", status: "Resolved" },
      }),
    },
  })
  const onEdit = jest.fn()
  const inspector = render(
    <ProjectInspector
      project={project}
      onEditResource={onEdit}
      onPatch={jest.fn()}
      onClose={jest.fn()}
      onAddResource={jest.fn()}
      onRemoveResource={jest.fn()}
      onRequestDelete={jest.fn()}
      onOpenIssues={jest.fn()}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "projects.editResource" }))
  expect(onEdit).toHaveBeenCalledWith(0)
  inspector.unmount()
  render(
    <ProjectResourceDialog
      open
      onOpenChange={jest.fn()}
      issueProjectId={project.id}
      roots={[]}
      initialResource={original as Extract<typeof original, { kind: "plugin" }>}
    />
  )
  expect(screen.getByRole("textbox", { name: /Title field/ })).toHaveValue("Migrated title")
  expect((await getIssueProject(project.id))!.resources).toEqual([original])
  await user.click(screen.getByRole("button", { name: "projects.saveResource" }))
  await waitFor(async () =>
    expect((await getIssueProject(project.id))!.resources).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        config: { project: "remote", mapping: { title: "Migrated title", status: "Resolved" } },
      }),
    ])
  )
})
