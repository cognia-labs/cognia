/** @jest-environment jsdom */
import type {
  CleanupDetail,
  CleanupOptions,
  CleanupResult,
  LocalPersistenceVisibilityProjection,
  StorageCategory,
  StorageCategoryInfo,
  StorageHealth,
  StorageHealthStatus,
  StorageIssue,
  StorageRecommendation,
  StorageStats,
} from "./types"
import { CATEGORY_INFO } from "./category-info"

describe("lib/storage/types", () => {
  it("maps every StorageCategory to a production descriptor", () => {
    const categories = {
      settings: true,
      session: true,
      chat: true,
      character: true,
      skill: true,
      team: true,
      mcp: true,
      preset: true,
      canvas: true,
      trustedWorkspace: true,
      ttsKey: true,
      backupHistory: true,
      artifact: true,
      vector: true,
      pet: true,
      system: true,
      other: true,
    } satisfies Record<StorageCategory, true>
    expect(Object.keys(CATEGORY_INFO).sort()).toEqual(Object.keys(categories).sort())
  })

  it("StorageCategoryInfo aggregates breakdown data", () => {
    const info: StorageCategoryInfo = {
      category: "chat",
      displayName: "Chats",
      itemCount: 42,
      totalSize: 12345,
      sources: ["sessions", "messages"],
    }
    expect(info.itemCount).toBe(42)
    expect(info.sources).toContain("sessions")
  })

  it("StorageStats stitches total + per-category + backend tiles", () => {
    const stats: StorageStats = {
      total: { used: 100, quota: 200, usagePercent: 50 },
      byCategory: [],
      localStorage: { used: 10 },
      indexedDB: { used: 90 },
      generatedAt: 1700000000000,
    }
    expect(stats.total.used).toBe(100)
    expect(stats.localStorage.used + stats.indexedDB.used).toBe(stats.total.used)
  })

  it("StorageHealth carries status, issues, and recommendations", () => {
    const statuses: StorageHealthStatus[] = ["healthy", "warning", "critical"]
    expect(statuses).toHaveLength(3)
    const issue: StorageIssue = { severity: "high", message: "near quota" }
    const rec: StorageRecommendation = {
      action: "clear-cache",
      description: "Clear cached TTS audio",
      category: "ttsKey",
      estimatedSavings: 1024,
    }
    const health: StorageHealth = {
      status: "warning",
      usagePercent: 88,
      issues: [issue],
      recommendations: [rec],
    }
    expect(health.issues[0]?.severity).toBe("high")
    expect(health.recommendations[0]?.estimatedSavings).toBe(1024)
  })

  it("Cleanup contract: detail + result + options", () => {
    const detail: CleanupDetail = { category: "session", deletedItems: 3, freedSpace: 500 }
    const result: CleanupResult = {
      freedSpace: 500,
      deletedItems: 3,
      details: [detail],
      errors: [],
    }
    expect(result.details[0]?.deletedItems).toBe(3)
    const opts: CleanupOptions = { categories: ["session"], olderThan: 1700000000000 }
    expect(opts.categories).toContain("session")
  })

  it("LocalPersistenceVisibilityProjection allows null recovery and rich domains", () => {
    const proj: LocalPersistenceVisibilityProjection = {
      modeLabel: "Web (Dexie)",
      activeBackendLabel: "web-dexie",
      isDegraded: false,
      summary: "All good.",
      diagnosticMessages: [],
      mirroredDomains: [
        { id: "chat", label: "Chat", status: "completed" },
        { id: "settings", label: "Settings", status: "pending" },
      ],
      reconciliationLabel: "Reconciled (2 domains)",
      recovery: null,
    }
    expect(proj.mirroredDomains).toHaveLength(2)
    expect(proj.recovery).toBeNull()
  })
})

it("supports an explicitly unknown storage health status", () => {
  const health: StorageHealth = {
    status: "unknown",
    usagePercent: 0,
    issues: [],
    recommendations: [],
  }
  expect(health.status).toBe("unknown")
})

it("names Host-managed cleanup availability explicitly", () => {
  const availability: import("./types").StorageCleanupAvailability = "host-managed"
  expect(availability).toBe("host-managed")
})
