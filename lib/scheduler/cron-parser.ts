/**
 * Cron Expression Parser
 *
 * Thin wrapper around the `cron-parser` library (OCPS-compliant: optional
 * seconds, `L`, `1L`-`7L`, `#`, ranges/steps/lists/names, predefined macros,
 * timezone + DST). This module keeps a stable, app-specific API surface — the
 * ~11 consumers across scheduler / twin / wiki / workflow-editor UI call these
 * functions and must not change.
 *
 * History: this file used to hand-roll a 5-field parser with a 4-year
 * minute-by-minute search loop, duplicating what `cron-parser` (already a
 * dependency) does correctly. We now delegate to the library and only retain
 * the field-splitting + human-readable describer that the library does not
 * provide.
 *
 * Parity notes vs the old hand-rolled implementation:
 *   - When no `timezone` is supplied we default to the host's local zone so
 *     "0 9 * * *" still means 9am wall-clock locally (the library otherwise
 *     defaults to UTC).
 *   - DOM/DOW both-restricted uses OR/union semantics (Vixie cron), matching
 *     the old behavior — we do NOT enable the library's `strict` mode.
 *   - Impossible expressions (e.g. `0 0 30 2 *`) and parse errors map to
 *     `null` so `calculateNextRunTime` degrades to `undefined` as before.
 *   - The `W` (nearest-weekday) modifier is intentionally rejected with a
 *     clear message: the library does not support it. (Upgrade path: `croner`.)
 */

import { CronExpressionParser } from "cron-parser"

import type { CronParts } from "@/types/scheduler"

/**
 * Predefined macros, mirroring `cron-parser`'s `PredefinedExpressions` so that
 * `parseCronExpression`/`describeCronExpression` agree with what the library
 * actually schedules. Keys are lowercase for case-insensitive matching.
 */
const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 0 1 1 *",
  "@annually": "0 0 0 1 1 *",
  "@monthly": "0 0 0 1 * *",
  "@weekly": "0 0 0 * * 0",
  "@daily": "0 0 0 * * *",
  "@hourly": "0 0 * * * *",
  "@minutely": "0 * * * * *",
  "@secondly": "* * * * * *",
  "@weekdays": "0 0 0 * * 1-5",
  "@weekends": "0 0 0 * * 0,6",
}

/** The host's IANA timezone, used when a caller omits `timezone`. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Detect the unsupported `W` (nearest-weekday) modifier. */
function usesNearestWeekday(expression: string): boolean {
  return /(^|[\s,/-])(\d{1,2}|L)?W\b/i.test(expression)
}

/**
 * Expand a leading macro (`@daily`, …) to its canonical field expression.
 * Returns the input unchanged when it is not a macro.
 */
function expandMacro(expression: string): string {
  const trimmed = expression.trim()
  if (trimmed.startsWith("@")) {
    return CRON_MACROS[trimmed.toLowerCase()] ?? trimmed
  }
  return trimmed
}

/**
 * Parse a cron expression into its named parts. Accepts 5-field
 * (`min hour dom month dow`) and 6-field (`sec min hour dom month dow`) forms,
 * plus predefined macros (which expand to a 6-field form). Returns `null` for
 * any other shape (4-field, 7-field with year, empty, or unparseable).
 *
 * `seconds` is populated only for 6-field/macro input; 5-field input omits it
 * so existing 5-field round-trips stay byte-identical.
 */
export function parseCronExpression(expression: string): CronParts | null {
  if (!expression || !expression.trim()) return null
  const expanded = expandMacro(expression)
  const parts = expanded.split(/\s+/)

  if (parts.length === 5) {
    return {
      minute: parts[0],
      hour: parts[1],
      dayOfMonth: parts[2],
      month: parts[3],
      dayOfWeek: parts[4],
    }
  }

  if (parts.length === 6) {
    return {
      seconds: parts[0],
      minute: parts[1],
      hour: parts[2],
      dayOfMonth: parts[3],
      month: parts[4],
      dayOfWeek: parts[5],
    }
  }

  return null
}

/**
 * Validate a cron expression by delegating to the library parser. Rejects the
 * unsupported `W` modifier and 7-field (year) expressions — neither is
 * representable in the app's `CronParts`/trigger model — with explicit errors.
 */
export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  if (!expression || !expression.trim()) {
    return { valid: false, error: "Invalid format: empty expression" }
  }

  if (usesNearestWeekday(expression)) {
    return {
      valid: false,
      error: "The 'W' (nearest weekday) modifier is not supported",
    }
  }

  const expanded = expandMacro(expression)
  const fieldCount = expanded.split(/\s+/).length
  // The library accepts 7-field (with a year) expressions, but the app model
  // has no year field — reject for representational consistency.
  if (!expanded.startsWith("@") && fieldCount > 6) {
    return {
      valid: false,
      error: "The year field (7-field cron) is not supported",
    }
  }

  try {
    CronExpressionParser.parse(expression, { tz: localTimezone() })
    return { valid: true }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Invalid cron expression",
    }
  }
}

/**
 * Validate the workflow daemon's cross-language cron subset. The general app
 * parser intentionally supports OCPS modifiers such as L and #, while Rust's
 * always-on daemon accepts classic 5/6-field schedules. Keeping this boundary
 * explicit prevents the editor from accepting a trigger the daemon cannot arm.
 */
const WORKFLOW_CRON_MACROS = new Set(["@yearly", "@monthly", "@weekly", "@daily", "@hourly"])
const WORKFLOW_MONTH_NAMES = [
  ["jan", "january"],
  ["feb", "february"],
  ["mar", "march"],
  ["apr", "april"],
  ["may"],
  ["jun", "june"],
  ["jul", "july"],
  ["aug", "august"],
  ["sep", "september"],
  ["oct", "october"],
  ["nov", "november"],
  ["dec", "december"],
]
const WORKFLOW_WEEKDAY_NAMES = [
  ["sun", "sunday"],
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "wednesday"],
  ["thu", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
]

/** Expand the daemon grammar to numeric fields without changing the general parser. */
function workflowCronFields(expression: string): number[][] {
  const trimmed = expression.trim()
  // Match parse_workflow_schedule's case-sensitive modifier guard, including JUL.
  if (!trimmed || /[L#]/.test(trimmed)) throw new Error("Unsupported workflow cron expression")
  if (trimmed.startsWith("@") && !WORKFLOW_CRON_MACROS.has(trimmed)) {
    throw new Error("Unsupported workflow cron macro")
  }
  const fields = expandMacro(trimmed).split(/\s+/)
  if (fields.length === 5) fields.unshift("0")
  if (fields.length !== 6) throw new Error("Workflow cron requires 5 or 6 fields")
  const bounds = [
    [0, 59],
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [1, 7],
  ]
  return fields.map((field, index) => {
    const standardWeekday = index === 5 && !/[a-z]/i.test(field) && field !== "*"
    const [min, max] = standardWeekday ? [0, 7] : bounds[index]
    const names = index === 4 ? WORKFLOW_MONTH_NAMES : index === 5 ? WORKFLOW_WEEKDAY_NAMES : []
    const valueOf = (value: string): number => {
      const number = /^\d+$/.test(value)
        ? Number(value)
        : names.findIndex((aliases) => aliases.includes(value.toLowerCase())) + 1
      if (number < min || number > max || (!/^\d+$/.test(value) && number === 0)) {
        throw new Error("Invalid workflow cron field")
      }
      return number
    }
    const values = new Set<number>()
    for (const segment of field.split(",")) {
      const match = /^(\*|\?|\d+|[a-z]+)(?:-(\d+|[a-z]+))?(?:\/(\d+))?$/i.exec(segment)
      if (!match) throw new Error("Invalid workflow cron field")
      const [, base, end, stepText] = match
      const step = stepText === undefined ? 1 : Number(stepText)
      if (step < 1 || (!standardWeekday && step > max))
        throw new Error("Invalid workflow cron step")
      if (
        base === "?" &&
        ((index !== 3 && !(index === 5 && !standardWeekday)) || end !== undefined)
      )
        throw new Error("Invalid workflow cron wildcard")
      if (/^[a-z]+$/i.test(base) && stepText !== undefined && !end)
        throw new Error("Invalid named workflow cron step")
      if (end && (base === "*" || base === "?")) throw new Error("Invalid workflow cron range")
      if (end && /^\d+$/.test(base) !== /^\d+$/.test(end))
        throw new Error("Invalid workflow cron range")
      const start = base === "*" || base === "?" ? min : valueOf(base)
      const last = end
        ? valueOf(end)
        : base === "*" || base === "?"
          ? standardWeekday
            ? 6
            : max
          : stepText && !standardWeekday
            ? max
            : start
      if (start > last) throw new Error("Invalid workflow cron range")
      for (let value = start; value <= last; value += step) {
        values.add(index === 5 ? (standardWeekday ? value % 7 : value - 1) : value)
      }
    }
    return [...values].sort((a, b) => a - b)
  })
}

export function validateWorkflowCronExpression(expression: string): {
  valid: boolean
  error?: string
} {
  try {
    workflowCronFields(expression)
    return { valid: true }
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "Invalid workflow cron" }
  }
}

/**
 * Get the next occurrence of a cron expression after `fromDate`.
 * @param timezone Optional IANA timezone. When omitted, the host's local zone
 *                 is used so wall-clock fields are interpreted locally.
 * @returns The next fire `Date`, or `null` for invalid/unschedulable input.
 */
export function getNextCronTime(
  expression: string,
  fromDate: Date = new Date(),
  timezone?: string
): Date | null {
  if (usesNearestWeekday(expression)) return null
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: fromDate,
      tz: timezone ?? localTimezone(),
    })
    return interval.next().toDate()
  } catch {
    return null
  }
}

/**
 * Get multiple upcoming occurrences of a cron expression.
 *
 * `endDate` bounds the walk: a yearly expression asked for thousands of fires
 * inside a two-week window returns none instead of walking thousands of years.
 * `workflow` uses the daemon dialect; other callers retain the general dialect.
 */
export function getNextCronTimes(
  expression: string,
  count: number,
  fromDate: Date = new Date(),
  timezone?: string,
  endDate?: Date,
  dialect: "general" | "workflow" = "general"
): Date[] {
  if (count <= 0) return []
  if (dialect === "workflow")
    return getNextWorkflowCronTimes(expression, count, fromDate, timezone, endDate)
  if (usesNearestWeekday(expression)) return []
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: fromDate,
      endDate,
      tz: timezone ?? localTimezone(),
    })
    return interval.take(count).map((d) => d.toDate())
  } catch {
    return []
  }
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>()

/** A sortable wall-clock reading of `date` in `timeZone`: `YYYY-MM-DD HH:MM:SS`. */
function wallClock(date: Date, timeZone: string): string {
  let format = wallClockFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    wallClockFormats.set(timeZone, format)
  }
  const part = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]))
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`
}

/**
 * Rust uses DOM/DOW intersection, skips nonexistent DST wall times, and walks
 * wall-clock times strictly after the anchor's (`next_fire_after` in
 * cron_daemon.rs): inside a repeated fall-back hour a wall time already
 * reached does not fire again, while one still ahead of the anchor's wall
 * clock fires at its first instant after the anchor.
 */
function getNextWorkflowCronTimes(
  expression: string,
  count: number,
  fromDate: Date,
  timezone?: string,
  endDate?: Date
): Date[] {
  try {
    const fields = workflowCronFields(expression)
    const normalized = fields.map((values, index) =>
      values.length === [60, 60, 24, 31, 12, 7][index] ? "*" : values.join(",")
    )
    // Iterate DOM alone to avoid the general parser's DOM/DOW union. Skip a
    // whole local day when DOW disagrees, even for second-granularity crons.
    normalized[5] = "*"
    const zone = timezone ?? localTimezone()
    const interval = CronExpressionParser.parse(normalized.join(" "), {
      currentDate: fromDate,
      endDate: endDate ?? new Date("2101-01-02T00:00:00Z"),
      tz: zone,
    })
    const result: Date[] = []
    let lastWall = wallClock(fromDate, zone)
    while (result.length < count && interval.hasNext()) {
      const next = interval.next()
      if (next.getFullYear() > 2100) break
      if (!fields[5].includes(next.getDay())) {
        next.setHours(23)
        next.setMinutes(59)
        next.setSeconds(59)
        interval.reset(next)
        continue
      }
      if (
        fields[2].includes(next.getHours()) &&
        fields[1].includes(next.getMinutes()) &&
        fields[0].includes(next.getSeconds())
      ) {
        const wall = wallClock(next.toDate(), zone)
        if (wall > lastWall) {
          lastWall = wall
          result.push(next.toDate())
        }
      }
    }
    return result
  } catch {
    return []
  }
}

/**
 * Optional translator passed to {@link describeCronExpression}. Compatible with
 * a next-intl `useTranslations()` / `getTranslations()` return value scoped to
 * the `scheduler.cronDescribe` namespace. When omitted, English fallbacks are
 * used (keeps the function usable outside React / server contexts).
 */
export type CronDescribeTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/**
 * Human-readable description of a cron expression. The library does not provide
 * descriptions, so we build one from the parsed parts. Pass an optional
 * translator (`t`) to localize; without it, English is produced.
 */
export function describeCronExpression(expression: string, t?: CronDescribeTranslator): string {
  const parts = parseCronExpression(expression)
  const tr: CronDescribeTranslator = t ?? ((_key, values) => fallbackDescribe(_key, values))
  if (!parts) return tr("invalid")

  const segments: string[] = []

  // Seconds (only when present and meaningful).
  if (parts.seconds && parts.seconds !== "0" && parts.seconds !== "*") {
    if (parts.seconds.startsWith("*/")) {
      segments.push(tr("everyNSeconds", { n: parts.seconds.slice(2) }))
    } else {
      segments.push(tr("atSecond", { value: parts.seconds }))
    }
  }

  // Minute.
  if (parts.minute === "*") {
    segments.push(tr("everyMinute"))
  } else if (parts.minute.startsWith("*/")) {
    segments.push(tr("everyNMinutes", { n: parts.minute.slice(2) }))
  } else {
    segments.push(tr("atMinute", { value: parts.minute }))
  }

  // Hour.
  if (parts.hour === "*") {
    segments.push(tr("ofEveryHour"))
  } else if (parts.hour.startsWith("*/")) {
    segments.push(tr("everyNHours", { n: parts.hour.slice(2) }))
  } else {
    segments.push(tr("atHour", { value: parts.hour }))
  }

  // Day of month (incl. `L` last-day).
  if (parts.dayOfMonth !== "*") {
    if (/\bL\b/i.test(parts.dayOfMonth)) {
      segments.push(tr("onLastDay"))
    } else if (parts.dayOfMonth.startsWith("*/")) {
      segments.push(tr("everyNDays", { n: parts.dayOfMonth.slice(2) }))
    } else {
      segments.push(tr("onDay", { value: parts.dayOfMonth }))
    }
  }

  // Month.
  if (parts.month !== "*") {
    if (parts.month.startsWith("*/")) {
      segments.push(tr("everyNMonths", { n: parts.month.slice(2) }))
    } else {
      const monthNum = parseInt(parts.month, 10)
      if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
        segments.push(tr("inMonth", { month: MONTH_LABELS[monthNum - 1] }))
      }
    }
  }

  // Day of week (incl. nth `#` and last `L`).
  if (parts.dayOfWeek !== "*") {
    if (parts.dayOfWeek === "1-5") {
      segments.push(tr("onWeekdays"))
    } else if (parts.dayOfWeek === "0,6" || parts.dayOfWeek === "6,0") {
      segments.push(tr("onWeekends"))
    } else if (parts.dayOfWeek.includes("#")) {
      const [dow, nth] = parts.dayOfWeek.split("#")
      const dayNum = parseInt(dow, 10)
      const dayLabel = !isNaN(dayNum) && dayNum >= 0 && dayNum <= 6 ? DAY_LABELS[dayNum] : dow
      segments.push(tr("onNthWeekday", { nth, day: dayLabel }))
    } else if (/\dL$/i.test(parts.dayOfWeek)) {
      const dayNum = parseInt(parts.dayOfWeek, 10)
      const dayLabel =
        !isNaN(dayNum) && dayNum >= 0 && dayNum <= 6 ? DAY_LABELS[dayNum] : parts.dayOfWeek
      segments.push(tr("onLastWeekday", { day: dayLabel }))
    } else {
      const dayNum = parseInt(parts.dayOfWeek, 10)
      if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
        segments.push(tr("onDayOfWeek", { day: DAY_LABELS[dayNum] }))
      }
    }
  }

  return segments.join(" ")
}

/** English fallback used when no translator is provided. */
function fallbackDescribe(key: string, values?: Record<string, string | number>): string {
  switch (key) {
    case "invalid":
      return "Invalid expression"
    case "everyNSeconds":
      return `every ${values?.n} seconds`
    case "atSecond":
      return `at second ${values?.value}`
    case "everyMinute":
      return "every minute"
    case "everyNMinutes":
      return `every ${values?.n} minutes`
    case "atMinute":
      return `at minute ${values?.value}`
    case "ofEveryHour":
      return "of every hour"
    case "everyNHours":
      return `every ${values?.n} hours`
    case "atHour":
      return `at ${values?.value}:00`
    case "onLastDay":
      return "on the last day of the month"
    case "everyNDays":
      return `every ${values?.n} days`
    case "onDay":
      return `on day ${values?.value}`
    case "everyNMonths":
      return `every ${values?.n} months`
    case "inMonth":
      return `in ${values?.month}`
    case "onWeekdays":
      return "on weekdays"
    case "onWeekends":
      return "on weekends"
    case "onNthWeekday":
      return `on the ${values?.nth} occurrence of ${values?.day}`
    case "onLastWeekday":
      return `on the last ${values?.day} of the month`
    case "onDayOfWeek":
      return `on ${values?.day}`
    default:
      return key
  }
}

/**
 * Format a cron expression for display. Emits 6 fields when `seconds` is
 * present, else 5 — so a 5-field round-trip is byte-identical.
 */
export function formatCronExpression(parts: CronParts): string {
  const tail = `${parts.minute} ${parts.hour} ${parts.dayOfMonth} ${parts.month} ${parts.dayOfWeek}`
  return parts.seconds !== undefined ? `${parts.seconds} ${tail}` : tail
}

/**
 * Check whether a given date matches a cron expression (minute granularity in
 * the supplied/local timezone). No production consumer beyond tests; kept for
 * API stability.
 */
export function matchesCronExpression(expression: string, date: Date, timezone?: string): boolean {
  if (!validateCronExpression(expression).valid) return false
  const target = new Date(date)
  target.setSeconds(0, 0)
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: new Date(target.getTime() - 1000),
      tz: timezone ?? localTimezone(),
    })
    const next = interval.next().toDate()
    next.setSeconds(0, 0)
    return next.getTime() === target.getTime()
  } catch {
    return false
  }
}
