import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NotificationRecord } from "@/types/notifications"
import type { NotificationListFilter } from "@/lib/db/notifications"

// Use the owning app's setup translator. A docs-local next-intl mock resolves
// a different workspace package from the components' next-intl import.
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@cognia/logging", () => ({ loggers: { ui: { warn: jest.fn(), error: jest.fn() } } }))
jest.mock("@/lib/notifications/api", () => ({
  listNotificationDeliveries: jest.fn(async () => []),
}))
jest.mock("@/lib/notifications/recurring-compaction", () => ({
  ensureRecurringNotificationsCompacted: jest.fn(async () => {}),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: [], activeProjectId: null }),
}))

let rows = new Map<string, NotificationRecord>()
const list = jest.fn(async (filter: NotificationListFilter = {}) => {
  let found = [...rows.values()]
    .filter(
      (record) =>
        (filter.includeDone || record.readState !== "done") &&
        (!filter.readStates || filter.readStates.includes(record.readState)) &&
        (!filter.source || record.source === filter.source) &&
        (filter.hideSnoozedAfter === undefined ||
          !record.snoozedUntil ||
          record.snoozedUntil <= filter.hideSnoozedAfter)
    )
    .sort((a, b) => b.createdAt - a.createdAt)
  if (filter.limit) found = found.slice(0, filter.limit)
  return found
})
jest.mock("@/lib/db/notifications", () => ({
  listNotifications: (filter: NotificationListFilter) => list(filter),
  getNotification: async (id: string) => rows.get(id),
  patchNotification: async (id: string, patch: Partial<NotificationRecord>) => {
    const record = rows.get(id)
    if (record) rows.set(id, { ...record, ...patch })
  },
  deleteNotification: async (id: string) => {
    rows.delete(id)
  },
  clearNotifications: async () => {
    rows.clear()
  },
}))

import { NotificationCenter } from "@/components/notifications/notification-center"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { useNotificationStore } from "@/stores/notifications/notification-store"
import {
  registerNotificationCommand,
  __resetNotificationCommandsForTesting,
} from "@/lib/notifications/action-registry"

const rec = (id: string, overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id,
  source: "system",
  level: "warning",
  title: `Notice ${id}`,
  createdAt: Number(id) || 1,
  updatedAt: Date.now(),
  readState: "unseen",
  count: 1,
  directed: true,
  deliveredVia: ["center"],
  personalContext: { hostOrigin: "fixed-notice" },
  ...overrides,
})

beforeEach(() => {
  rows = new Map()
  list.mockClear()
  __resetNotificationCommandsForTesting()
  useNotificationStore.setState({
    items: [],
    directedUnread: 0,
    ambientUnseen: 0,
    hydrated: true,
    sourceFilter: undefined,
  })
})

it("F20 counterexample: the same failed action remains clickable and can be retried after read", async () => {
  const handler = jest.fn(async () => {
    throw new Error("temporary approval failure")
  })
  registerNotificationCommand("approve", handler)
  const record = rec("1", { actions: [{ id: "approve", command: "approve", label: "Approve" }] })
  rows.set(record.id, record)
  useNotificationStore.getState().ingest(record)
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "Approve" }))
  await waitFor(() => expect(rows.get(record.id)?.readState).toBe("read"))
  await userEvent.click(screen.getByRole("button", { name: "Approve" }))
  expect(handler).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled()
})

it("F21 counterexample: restoring a newer archive admits #101 into the next 100-row query", async () => {
  for (let i = 1; i <= 101; i++) rows.set(String(i), rec(String(i), { readState: "done" }))
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "Archived" }))
  await screen.findByText("Notice 101")
  expect(screen.queryByText("Notice 1")).toBeNull()
  const firstRow = screen
    .getByText("Notice 101")
    .closest('[data-testid="notification-item"]') as HTMLElement
  await userEvent.click(within(firstRow).getByRole("button", { name: "Notification actions" }))
  await userEvent.click(await screen.findByText("Restore to inbox"))
  await waitFor(() => expect(rows.get("101")?.readState).toBe("read"))
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }))
  )
  for (let i = 0; i < 4; i++)
    await userEvent.click(screen.getByRole("button", { name: /^Load more/ }))
  expect(await screen.findByText("Notice 1")).toBeInTheDocument()
})

it("F21 counterexample: confirmed Clear All deletes archives outside the 100-row window", async () => {
  for (let i = 1; i <= 101; i++) rows.set(String(i), rec(String(i), { readState: "done" }))
  render(<NotificationCenter />)
  await userEvent.click(screen.getByRole("button", { name: "More actions" }))
  await userEvent.click(await screen.findByText("Clear all"))
  expect(rows.size).toBe(101)
  await userEvent.click(await screen.findByRole("button", { name: "Clear all" }))
  await waitFor(() => expect(rows.size).toBe(0))
})

it("new defect: a hydrated bell retains the previous account's count across remount and repository switch", async () => {
  rows.set("1", rec("1"))
  await useNotificationStore.getState().hydrate()
  const first = render(<NotificationBell />)
  expect(screen.getByRole("button", { name: "1 unread notifications" })).toBeInTheDocument()
  first.unmount()
  rows = new Map() // The active account database changed; no old data exists in it.
  list.mockClear()
  render(<NotificationBell />)
  expect(screen.getByRole("button", { name: "1 unread notifications" })).toBeInTheDocument()
  expect(list).not.toHaveBeenCalled()
  expect(useNotificationStore.getState().items[0].title).toBe("Notice 1")
})
