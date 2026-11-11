// Pure-function tests for the scheduling and reminder helpers.

import { execFileSync } from "node:child_process"
import path from "node:path"
import {
  shouldRunScheduledBackup,
  shouldShowReminder,
  pruneScheduledBackups,
  scheduledBackupCompletedAt,
} from "./scheduler"
import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@cognia/agent-config-types"

const DAY = 24 * 60 * 60 * 1000

describe("shouldRunScheduledBackup", () => {
  it("returns false when config is missing or disabled", () => {
    expect(shouldRunScheduledBackup({ config: undefined, lastSuccessAt: undefined })).toBe(false)
    expect(
      shouldRunScheduledBackup({
        config: { enabled: false, intervalDays: 7, retainCount: 5 },
        lastSuccessAt: undefined,
      })
    ).toBe(false)
  })

  it("returns true on first run (no prior success)", () => {
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true },
        lastSuccessAt: undefined,
      })
    ).toBe(true)
  })

  it("returns false until the interval has elapsed", () => {
    const now = 1_000_000_000
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true, intervalDays: 7 },
        lastSuccessAt: now - 6 * DAY,
        now,
      })
    ).toBe(false)
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true, intervalDays: 7 },
        lastSuccessAt: now - 7 * DAY,
        now,
      })
    ).toBe(true)
  })

  it("treats intervalDays <= 0 as disabled", () => {
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true, intervalDays: 0 },
        lastSuccessAt: undefined,
      })
    ).toBe(false)
  })
})

describe("shouldShowReminder", () => {
  const now = 1_000_000_000
  it("returns false when reminderDays is unset or zero", () => {
    expect(
      shouldShowReminder({
        reminderDays: undefined,
        lastSuccessAt: undefined,
        dismissedAt: undefined,
        now,
      })
    ).toBe(false)
    expect(
      shouldShowReminder({
        reminderDays: 0,
        lastSuccessAt: undefined,
        dismissedAt: undefined,
        now,
      })
    ).toBe(false)
  })

  it("returns false when last success is recent", () => {
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 3 * DAY,
        dismissedAt: undefined,
        now,
      })
    ).toBe(false)
  })

  it("returns true when last success is older than the window", () => {
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 8 * DAY,
        dismissedAt: undefined,
        now,
      })
    ).toBe(true)
  })

  it("respects a recent dismissal", () => {
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 30 * DAY,
        dismissedAt: now - DAY,
        now,
      })
    ).toBe(false)
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 30 * DAY,
        dismissedAt: now - 8 * DAY,
        now,
      })
    ).toBe(true)
  })
})

describe("pruneScheduledBackups", () => {
  const candidates = [
    { name: "a", completedAt: 1 },
    { name: "b", completedAt: 5 },
    { name: "c", completedAt: 3 },
    { name: "d", completedAt: 4 },
  ]

  it("returns an empty list when the count is at or below the cap", () => {
    expect(pruneScheduledBackups(candidates, 4)).toEqual([])
    expect(pruneScheduledBackups(candidates, 10)).toEqual([])
  })

  it("returns the oldest candidates when over the cap", () => {
    const out = pruneScheduledBackups(candidates, 2).map((c) => c.name)
    expect(out.sort()).toEqual(["a", "c"])
  })

  it("keeps the just-committed snapshot without changing any candidate timestamps", () => {
    const before = structuredClone(candidates)
    expect(
      pruneScheduledBackups(candidates, 2, "a")
        .map((row) => row.name)
        .sort()
    ).toEqual(["c", "d"])
    expect(candidates).toEqual(before)
  })

  it("treats retainCount<=0 as 'delete all'", () => {
    expect(pruneScheduledBackups(candidates, 0)).toHaveLength(4)
    expect(pruneScheduledBackups(candidates, -1)).toHaveLength(4)
  })
})

describe("scheduledBackupCompletedAt", () => {
  const owner = "a".repeat(64)
  const uuid = "ffffffff-ffff-4fff-bfff-ffffffffffff"
  it("reads the millisecond UTC time independently of the local date prefix and UUID", () => {
    expect(
      scheduledBackupCompletedAt(
        `cognia-backup-2026-11-11-prejoin-20261110T230000123Z-${uuid}-owner-${owner}.enc.cbk`
      )
    ).toBe(Date.parse("2026-11-10T23:00:00.123Z"))
  })
  it("preserves date ordering for interval and legacy pre-join names", () => {
    expect(scheduledBackupCompletedAt(`cognia-backup-2026-11-10-owner-${owner}.enc.cbk`)).toBe(
      new Date(2026, 10, 10).getTime()
    )
    expect(
      scheduledBackupCompletedAt(`cognia-backup-2026-11-09-prejoin-${uuid}-owner-${owner}.enc.cbk`)
    ).toBe(new Date(2026, 10, 9).getTime())
  })
  it("orders mixed legacy and exact times by the local day in Asia/Shanghai", () => {
    // A child gives Node a real TZ, independent of Jest's sandboxed process.env.
    const script = `
      const { scheduledBackupCompletedAt, pruneScheduledBackups } = require(${JSON.stringify(path.resolve(__dirname, "scheduler.ts"))});
      const suffix = '-owner-${owner}.enc.cbk';
      const names = [
        'cognia-backup-2026-11-11' + suffix,
        'cognia-backup-2026-11-11-prejoin-${uuid}' + suffix,
        'cognia-backup-2026-11-11-interval-20261110T160000000Z' + suffix,
        'cognia-backup-2026-11-11-interval-20261110T163000000Z' + suffix,
        'cognia-backup-2026-11-11-prejoin-20261110T170000000Z-${uuid}' + suffix,
        'cognia-backup-2026-11-12-interval-20261111T163000000Z' + suffix,
      ];
      const candidates = names.map(name => ({ name, completedAt: scheduledBackupCompletedAt(name) }));
      const removed = pruneScheduledBackups(candidates, 2);
      const directory = '/backups-20261110T160000000Z-/';
      const midnightRemoved = pruneScheduledBackups(candidates.slice(0, 3).map(row => ({ ...row, name: directory + row.name })), 1);
      process.stdout.write(JSON.stringify({
        offset: new Date('2026-11-11T00:00:00+08:00').getTimezoneOffset(),
        times: candidates.map(row => row.completedAt),
        survivors: names.filter(name => !removed.some(row => row.name === name)),
        midnightSurvivors: names.slice(0, 3).filter(name => !midnightRemoved.some(row => row.name === directory + name)),
      }));
    `
    const result = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
        env: { ...process.env, TZ: "Asia/Shanghai", TSX_DISABLE_CACHE: "1" },
        encoding: "utf8",
        timeout: 15_000,
      })
    )
    expect(result.offset).toBe(-480)
    expect(result.times).toEqual([
      Date.parse("2026-11-11T00:00:00+08:00"),
      Date.parse("2026-11-11T00:00:00+08:00"),
      Date.parse("2026-11-11T00:00:00+08:00"),
      Date.parse("2026-11-11T00:30:00+08:00"),
      Date.parse("2026-11-11T01:00:00+08:00"),
      Date.parse("2026-11-12T00:30:00+08:00"),
    ])
    expect(result.survivors).toEqual([
      `cognia-backup-2026-11-11-prejoin-20261110T170000000Z-${uuid}-owner-${owner}.enc.cbk`,
      `cognia-backup-2026-11-12-interval-20261111T163000000Z-owner-${owner}.enc.cbk`,
    ])
    expect(result.midnightSurvivors).toEqual([
      `cognia-backup-2026-11-11-interval-20261110T160000000Z-owner-${owner}.enc.cbk`,
    ])
  })
  it.each([
    `cognia-backup-2026-11-10-prejoin-20260230T010000123Z-${uuid}-owner-${owner}.enc.cbk`,
    `cognia-backup-2026-02-30-owner-${owner}.enc.cbk`,
    `cognia-backup-2026-11-10-interval-20260230T010000123Z-owner-${owner}.enc.cbk`,
    "cognia-backup-2026-11-10.enc.cbk",
    "notes.txt",
  ])("leaves files with unknown or invalid times alone: %s", (name) => {
    expect(scheduledBackupCompletedAt(name)).toBeNull()
  })
})
