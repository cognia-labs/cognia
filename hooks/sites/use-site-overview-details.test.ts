/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

const useLiveQueryMock = jest.fn()
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))

jest.mock("@/lib/db/sites", () => ({
  listSiteVersionsByIds: jest.fn(async () => []),
  listRecentSiteOperations: jest.fn(async () => []),
}))

import * as db from "@/lib/db/sites"
import type { SiteDeploymentRow, SiteOperationRow, SiteVersionRow } from "@/types/sites"
import {
  SITE_OVERVIEW_RECENT_OPERATIONS,
  groupRecentOperations,
  useSiteOverviewDetails,
} from "./use-site-overview-details"

function deployment(id: string, versionId: string): SiteDeploymentRow {
  return {
    id,
    siteId: `site_${id}`,
    versionId,
    environmentRevisionId: "env_1",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  }
}

function operation(id: string, siteId: string): SiteOperationRow {
  return {
    id,
    siteId,
    type: "deploy",
    executionTargetKey: "local",
    idempotencyKey: id,
    inputDigest: "e",
    status: "succeeded",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function capture() {
  let run: (() => Promise<unknown>) | undefined
  let deps: unknown[] | undefined
  useLiveQueryMock.mockImplementation((fn: () => Promise<unknown>, dependencies: unknown[]) => {
    run = fn
    deps = dependencies
    return undefined
  })
  return () => ({ run: run!, deps: deps! })
}

beforeEach(() => {
  jest.clearAllMocks()
  useLiveQueryMock.mockReturnValue(undefined)
})

it("reads the versions the live deployments serve, once each, and the recent journal", async () => {
  const read = capture()
  renderHook(() =>
    useSiteOverviewDetails([
      deployment("d2", "version_b"),
      deployment("d1", "version_a"),
      deployment("d3", "version_a"),
    ])
  )
  await read().run()
  expect(db.listSiteVersionsByIds).toHaveBeenCalledWith(["version_a", "version_b"])
  expect(db.listRecentSiteOperations).toHaveBeenCalledWith(SITE_OVERVIEW_RECENT_OPERATIONS)
  // Keyed on the ids, so a new array with the same deployments reads nothing new.
  expect(read().deps).toEqual(["version_a\nversion_b"])
})

it("asks for no version when nothing is live", async () => {
  const read = capture()
  renderHook(() => useSiteOverviewDetails([]))
  await read().run()
  expect(db.listSiteVersionsByIds).toHaveBeenCalledWith([])
})

it("indexes the resolved snapshot by version and by Site", () => {
  const version = { id: "version_a", siteId: "site_1", sequence: 4 } as SiteVersionRow
  useLiveQueryMock.mockReturnValue({
    versions: [version],
    operations: [operation("op_2", "site_1"), operation("op_1", "site_1")],
  })
  const { result } = renderHook(() => useSiteOverviewDetails([deployment("d1", "version_a")]))
  expect(result.current.versionsById.get("version_a")).toBe(version)
  expect(result.current.operationsBySite.get("site_1")?.map((row) => row.id)).toEqual([
    "op_2",
    "op_1",
  ])
})

it("is empty before the first snapshot resolves", () => {
  const { result } = renderHook(() => useSiteOverviewDetails([]))
  expect(result.current.versionsById.size).toBe(0)
  expect(result.current.operationsBySite.size).toBe(0)
})

describe("groupRecentOperations", () => {
  it("keeps each Site's newest few, in the order given", () => {
    const grouped = groupRecentOperations(
      [
        operation("a1", "site_a"),
        operation("b1", "site_b"),
        operation("a2", "site_a"),
        operation("a3", "site_a"),
      ],
      2
    )
    expect(grouped.get("site_a")?.map((row) => row.id)).toEqual(["a1", "a2"])
    expect(grouped.get("site_b")?.map((row) => row.id)).toEqual(["b1"])
  })
})
