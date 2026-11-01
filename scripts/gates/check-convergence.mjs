#!/usr/bin/env node
/**
 * ADR-0250 §11 inventories ratchet MEMBERS, not counts: a replacement debt
 * cannot hide behind an unchanged total. Heuristics only nominate candidates;
 * members need a human note (where required), or an exclusion with a reason.
 * Repaid items fail until --write-baseline locks the repayment into the exact
 * inventory. Cross-commit growth is policed separately by
 * scripts/gates/check-baseline-growth.mjs: every inventory's metrics.* is
 * compared with the merge base and growth needs an exception record naming an
 * owner and repayment phase. --write-baseline therefore cannot quietly admit
 * new debt. Mechanical lib and dynamic-Tauri import inventories require no
 * notes; all runtime, queue, cap and run-table nominations require review.
 *
 * pnpm audit:convergence                   # exact sets + classification
 * pnpm audit:convergence:baseline          # refresh; never invent human notes
 * pnpm audit:convergence:report            # metrics + unresolved row types
 * Options: --json, --inventory <name>, --root <fixture repository>
 * Reviewed decisions pin their detector evidence. --write-baseline preserves
 * that evidence; --reconfirm <key> explicitly accepts a reviewed change.
 * --reconfirm-all is only for a refactor whose every affected row was reviewed.
 * Verification aid: CONVERGENCE_HEADLESS_EXCLUSIONS=<path> reads a prospective
 * B6 v1/v2 ledger without changing the worktree's headless registry files.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import ts from "typescript"
import {
  createContext,
  DETECTORS,
  discoverDexieTables,
  runtimeRootCoverage,
  readExclusions,
  manualQueueCandidate,
  ledgerCitation,
  fingerprint,
} from "./convergence/counter.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const INVENTORY_DIR = "scripts/gates/convergence/inventories"
export const INVENTORIES = {
  "runtime-initializers": {
    requiresNote: true,
    description:
      "Imported lib symbols called from provider effects or their local callees, absent from brain calls and headless exclusions. Repay by wiring the effect into the headless registry or classifying it as an explained exclusion.",
  },
  "lib-store-imperative": {
    requiresNote: false,
    description:
      "Non-test lib files importing stores and using getState, setState or subscribe. Repay by moving state ownership into the kernel and consuming an injected or host-neutral interface.",
  },
  "lib-ui-imports": {
    requiresNote: false,
    description:
      "Non-test lib files importing hooks or components, including type-only and dynamic dependencies. Repay by moving shared contracts and runtime logic below the UI layer.",
  },
  "durable-queues": {
    requiresNote: true,
    description:
      "Dexie and Rust SQLite tables with queue names, retry counts, due times, leases or pending states, plus verified manual durable queues. Repay by migrating to the shared durable-queue primitive; explain false positives as exclusions.",
  },
  caps: {
    requiresNote: true,
    description:
      "Numeric concurrency and admission caps plus limiter construction sites in shipped TypeScript and Rust. Repay business caps through the admission limiter; classify native backpressure with the real protected resource and its owner.",
  },
  "run-tables": {
    requiresNote: true,
    description:
      "Run-like Dexie tables by name or row lifecycle fields, with their syntactically verified reference to executionRuns. Repay missing and name-only references through the shared ledger; retain real references or explained exclusions in the inventory.",
  },
  "tauri-dynamic-imports": {
    requiresNote: false,
    description:
      "Renderer files dynamically loading Tauri core/event outside the transport seam owners. Repay by routing through the transport seam; static imports remain host-parity class A's responsibility.",
  },
}

export function computeMetrics(name, members) {
  if (name === "runtime-initializers")
    return {
      members: members.length,
      initializers: new Set(members.map((m) => m.initializer)).size,
      pending: members.filter((m) => m.pendingPhase !== undefined).length,
    }
  if (name === "tauri-dynamic-imports")
    return {
      members: members.length,
      staticAlsoInClassA: members.filter((m) => m.staticAlsoInClassA).length,
    }
  if (name === "lib-store-imperative")
    return {
      static: members.filter((m) => m.imports?.includes("static")).length,
      all: members.length,
    }
  if (name === "lib-ui-imports")
    return {
      static: members.filter((m) => m.imports?.includes("static")).length,
      all: members.length,
      staticExcludingTypeOnly: members.filter((m) => m.imports?.includes("static") && !m.typeOnly)
        .length,
    }
  if (name === "durable-queues")
    return {
      members: members.length,
      dexie: members.filter((m) => m.key.startsWith("dexie:")).length,
      sqlite: members.filter((m) => m.key.startsWith("sqlite:")).length,
      manual: members.filter((m) => m.key.startsWith("manual:")).length,
    }
  if (name === "caps")
    return {
      members: members.length,
      business: members.filter((m) => m.segment === "business").length,
      native: members.filter((m) => m.segment === "native").length,
      unclassified: members.filter((m) => !["business", "native"].includes(m.segment)).length,
    }
  return {
    members: members.length,
    real: members.filter((m) => m.reference === "real").length,
    nameOnly: members.filter((m) => m.reference === "name-only").length,
    none: members.filter((m) => m.reference === "none").length,
  }
}

const textPresent = (s) => typeof s === "string" && s.trim().length > 0
const longText = (s) => typeof s === "string" && s.trim().length >= 20
const referenceValues = ["none", "name-only", "real"]
export const DERIVED_LEDGER_WRITERS = ["ensureRun"]

function bridgeCitations(ctx, note) {
  ctx.bridgeCitations ??= new Map()
  if (ctx.bridgeCitations.has(note)) return ctx.bridgeCitations.get(note)
  const records = []
  for (const match of note.matchAll(/([\w./-]+\.[cm]?[jt]sx?):(\d+)/g)) {
    const file = match[1],
      line = Number(match[2]) - 1
    if (file.startsWith("/") || file.split("/").includes("..") || !ctx.exists(file)) continue
    const ast = ctx.ast(file)
    const scan = (node) => {
      if (
        ts.isCallExpression(node) &&
        line >= ast.getLineAndCharacterOfPosition(node.expression.getStart()).line &&
        line <= ast.getLineAndCharacterOfPosition(node.expression.end).line
      ) {
        const binding = ledgerCitation(ctx, file, node, DERIVED_LEDGER_WRITERS)
        if (binding) records.push(binding)
      }
      ts.forEachChild(node, scan)
    }
    scan(ast)
  }
  const unique = [...new Set(records.map((r) => JSON.stringify(r)))].sort()
  ctx.bridgeCitations.set(note, unique)
  return unique
}
const hasBridgeCitation = (ctx, note) => bridgeCitations(ctx, note).length > 0
function referenceCandidate(ctx, candidate, recorded) {
  if (
    !candidate ||
    !referenceValues.includes(recorded?.referenceOverride) ||
    !longText(recorded.note)
  )
    return candidate
  const bridges = bridgeCitations(ctx, recorded.note)
  return bridges.length
    ? {
        ...candidate,
        evidence: fingerprint(JSON.stringify({ detected: candidate.evidence, bridges })),
      }
    : candidate
}

function manualStillExists(ctx, row) {
  if (
    typeof row.file !== "string" ||
    typeof row.symbol !== "string" ||
    !row.symbol ||
    !ctx.exists(row.file)
  )
    return false
  const path = relative(ctx.root, resolve(ctx.root, row.file))
  return (
    !path.startsWith("..") &&
    new RegExp(`\\b${row.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
      ctx.read(row.file)
    )
  )
}

/** Pure set/schema comparison; disk access for manual entries is injected via ctx. */
export function reconcileInventory(name, candidates, baseline, ctx) {
  const invalid = [],
    members = Array.isArray(baseline?.members) ? baseline.members : [],
    excluded = Array.isArray(baseline?.excluded) ? baseline.excluded : []
  if (
    !baseline ||
    baseline.inventory !== name ||
    !Array.isArray(baseline.members) ||
    !Array.isArray(baseline.excluded)
  )
    invalid.push("missing or malformed inventory envelope")
  const detected = new Map()
  for (const row of candidates) {
    if (detected.has(row.key)) invalid.push(`${row.key}: ambiguous key`)
    detected.set(row.key, row)
  }
  if (name === "runtime-initializers") invalid.push(...runtimeRootCoverage(ctx).invalid)
  const keys = new Set()
  for (const row of [...members, ...excluded]) {
    if (!row || !textPresent(row.key)) {
      invalid.push("missing key")
      continue
    }
    if (keys.has(row.key)) invalid.push(`${row.key}: duplicate key`)
    keys.add(row.key)
  }
  for (const row of members) {
    if (!row || !textPresent(row.key)) continue
    if (!textPresent(row.owner)) invalid.push(`${row.key}: missing owner`)
    if (INVENTORIES[name].requiresNote && !longText(row.note))
      invalid.push(`${row.key}: missing note (human confirmation required)`)
    if (name === "durable-queues") {
      if (!textPresent(row.runner) || !ctx.exists(row.runner))
        invalid.push(`${row.key}: missing or vanished runner file`)
      if (!(
        row.retry === "none" ||
        row.retry === "decideNextAttempt" ||
        (typeof row.retry === "string" && /^custom: .+/.test(row.retry))
      ))
        invalid.push(`${row.key}: missing or invalid retry policy`)
      if (!textPresent(row.idempotency)) invalid.push(`${row.key}: missing idempotency key or none`)
    }
    if (name === "caps") {
      if (!["business", "native"].includes(row.segment))
        invalid.push(`${row.key}: missing or invalid segment`)
      if (row.segment === "native" && !textPresent(row.resource))
        invalid.push(`${row.key}: native cap missing resource`)
    }
    if (name === "run-tables") {
      if (detected.has(row.key))
        detected.set(row.key, referenceCandidate(ctx, detected.get(row.key), row))
      if (
        row.referenceOverride !== undefined &&
        (!referenceValues.includes(row.referenceOverride) ||
          !longText(row.note) ||
          !hasBridgeCitation(ctx, row.note))
      )
        invalid.push(
          `${row.key}: referenceOverride requires a live ledger bridge call at a cited file:line and a reviewed note`
        )
      const expected =
        row.referenceOverride !== undefined &&
        referenceValues.includes(row.referenceOverride) &&
        longText(row.note) &&
        hasBridgeCitation(ctx, row.note)
          ? row.referenceOverride
          : detected.get(row.key)?.reference
      if (!referenceValues.includes(row.reference)) invalid.push(`${row.key}: invalid reference`)
      else if (expected !== undefined && row.reference !== expected)
        invalid.push(`${row.key}: reference drift: recorded ${row.reference}, computed ${expected}`)
    }
    if (name === "durable-queues" && row.key.startsWith("manual:")) {
      if (manualStillExists(ctx, row)) detected.set(row.key, manualQueueCandidate(ctx, row))
      else invalid.push(`${row.key}: manual queue file/symbol vanished or missing`)
    }
  }
  for (const row of excluded)
    if (row && !longText(row.reason))
      invalid.push(`${row.key}: exclusion reason must have at least 20 characters`)
  if (INVENTORIES[name].requiresNote)
    for (const row of [...members, ...excluded]) {
      const current = detected.get(row?.key)
      if (
        current &&
        (!/^[a-f0-9]{16}$/.test(row.evidence ?? "") || row.evidence !== current.evidence)
      )
        invalid.push(`${row.key}: invalid: evidence changed — re-review note/reason`)
    }
  const added = [...detected.keys()].filter((key) => !keys.has(key)).sort()
  const repaid = members
    .filter((row) => row?.key && !detected.has(row.key))
    .map((row) => row.key)
    .sort()
  const stale = excluded
    .filter((row) => row?.key && !detected.has(row.key))
    .map((row) => row.key)
    .sort()
  const editorial = new Map(members.filter((row) => row?.key).map((row) => [row.key, row]))
  const exclusions = new Set(
    excluded.filter((row) => row?.key && longText(row.reason)).map((row) => row.key)
  )
  if (name === "runtime-initializers") {
    const decisions = readExclusions(ctx)
    if (decisions.version === 2) {
      for (const [file, entry] of decisions.pending) {
        if (entry.symbols === "*" || !entry.symbols.size) {
          invalid.push(`${file}: pending requires explicit symbols`)
          continue
        }
        for (const symbol of entry.symbols) {
          const matches = [...detected.values()].filter(
            (row) => row.initializer === file && row.symbol === symbol
          )
          if (!matches.length)
            invalid.push(`${file}#${symbol}: detector miss: pending symbol was not detected`)
          for (const row of matches) {
            const member = editorial.get(row.key)
            if (!member || exclusions.has(row.key))
              invalid.push(`${row.key}: pending symbol must be a member`)
            const sentence = entry.reason?.trim().match(/^.*?[.!?](?=\s|$)|^.+$/)?.[0]
            if (
              !textPresent(entry.phase) ||
              !longText(entry.reason) ||
              !member?.note?.startsWith(`pending:${entry.phase} `) ||
              !sentence ||
              !member.note.includes(JSON.stringify(sentence))
            )
              invalid.push(
                `${row.key}: pending note must start pending:${entry.phase} and quote the reason's first sentence`
              )
            // B6 debt cannot be hidden by a v1 inventory exclusion. Keep the
            // detected metric honest while requiring that editorial migration.
            exclusions.delete(row.key)
          }
        }
      }
      for (const row of detected.values()) {
        if (
          !row.initializer.startsWith("components/providers/initializers/") ||
          exclusions.has(row.key)
        )
          continue
        if (!decisions.pending.get(row.initializer)?.symbols?.has?.(row.symbol))
          invalid.push(`${row.key}: unadjudicated initializer member`)
      }
    }
  }
  const effective = [...detected.values()]
    .filter((row) => !exclusions.has(row.key))
    .map((current) => {
      const recorded = editorial.get(current.key)
      const merged = { ...current }
      for (const field of ["segment", "resource", "referenceOverride", "note", "owner"])
        if (recorded?.[field] !== undefined) merged[field] = recorded[field]
      if (
        name === "run-tables" &&
        referenceValues.includes(merged.referenceOverride) &&
        longText(merged.note) &&
        hasBridgeCitation(ctx, merged.note)
      )
        merged.reference = merged.referenceOverride
      return merged
    })
  const metrics = computeMetrics(name, effective)
  if (!isDeepStrictEqual(baseline?.metrics, metrics))
    invalid.push("invalid: metrics must exactly equal the recomputed effective member metrics")
  if (name === "runtime-initializers") {
    const decisions = readExclusions(ctx)
    if (
      decisions.version === 2 &&
      decisions.pendingCeiling !== undefined &&
      metrics.pending !== decisions.pendingCeiling
    )
      invalid.push(
        `pending ceiling mismatch: detected ${metrics.pending}, pendingCeiling ${decisions.pendingCeiling}`
      )
  }
  return {
    inventory: name,
    metrics,
    added,
    repaid,
    stale,
    invalid,
    ok: !added.length && !repaid.length && !stale.length && !invalid.length,
  }
}

/** Keep editorial fields; refresh computed detector fields and remove stale keys. */
export function rewriteInventory(name, candidates, baseline, generatedAt, ctx, confirmation = {}) {
  const previous = new Map((baseline?.members ?? []).map((m) => [m.key, m]))
  const detected = new Map(candidates.map((m) => [m.key, m]))
  if (name === "durable-queues")
    for (const row of previous.values())
      if (row.key.startsWith("manual:") && manualStillExists(ctx, row))
        detected.set(row.key, manualQueueCandidate(ctx, row))
  const evidenceFor = (old, current) =>
    old &&
    (textPresent(old.note) || textPresent(old.reason)) &&
    !confirmation.all &&
    !confirmation.keys?.has(old.key)
      ? old.evidence
      : current.evidence
  const excluded = (baseline?.excluded ?? [])
    .filter(
      (row) =>
        detected.has(row.key) &&
        !(
          name === "runtime-initializers" &&
          readExclusions(ctx).version === 2 &&
          detected.get(row.key).pendingPhase !== undefined
        )
    )
    .map((old) => {
      const row = {
        ...old,
        ...detected.get(old.key),
        reason: old.reason,
        evidence: evidenceFor(old, detected.get(old.key)),
      }
      delete row.note
      return row
    })
    .sort((a, b) => a.key.localeCompare(b.key))
  const exclusions = new Set(excluded.map((m) => m.key))
  const members = [...detected.values()]
    .filter((m) => !exclusions.has(m.key))
    .map((candidate) => {
      const old = previous.get(candidate.key)
      if (name === "run-tables") candidate = referenceCandidate(ctx, candidate, old)
      const row = {
        ...old,
        ...candidate,
        owner: old?.owner ?? candidate.owner,
        note: old?.note ?? "",
        ...(INVENTORIES[name].requiresNote ? { evidence: evidenceFor(old, candidate) } : {}),
      }
      // Every arbitrary editorial field survives via ...old. Detector evidence
      // stays fresh; a justified referenceOverride is the explicit exception.
      if (
        name === "run-tables" &&
        referenceValues.includes(old?.referenceOverride) &&
        longText(old.note) &&
        hasBridgeCitation(ctx, old.note)
      )
        row.reference = old.referenceOverride
      return row
    })
    .sort((a, b) => a.key.localeCompare(b.key))
  return {
    inventory: name,
    description: baseline?.description ?? INVENTORIES[name].description,
    generatedAt,
    metrics: computeMetrics(name, members),
    members,
    excluded,
  }
}

function readInventory(root, name) {
  const file = join(root, INVENTORY_DIR, `${name}.json`)
  if (!existsSync(file)) return { baseline: null }
  try {
    return { baseline: JSON.parse(readFileSync(file, "utf8")) }
  } catch (error) {
    return { baseline: null, error: `cannot parse ${name}: ${error.message}` }
  }
}

export function analyze(root = ROOT, names = Object.keys(INVENTORIES)) {
  const ctx = createContext(root),
    reports = [],
    detected = new Map(),
    baselines = new Map(),
    readErrors = []
  for (const name of names) {
    const candidates = DETECTORS[name](ctx),
      { baseline, error } = readInventory(root, name)
    detected.set(name, candidates)
    baselines.set(name, baseline)
    const report = reconcileInventory(name, candidates, baseline, ctx)
    if (error) {
      report.invalid.push(error)
      report.ok = false
      readErrors.push(error)
    }
    reports.push(report)
  }
  const unresolvedRowTypes = names.some((name) => ["durable-queues", "run-tables"].includes(name))
    ? discoverDexieTables(ctx)
        .filter((t) => t.rowFields === null)
        .map(({ key, rowType }) => ({ key, rowType }))
    : []
  return { ctx, reports, detected, baselines, unresolvedRowTypes, readErrors }
}

function options(argv) {
  const opts = {
    root: ROOT,
    names: Object.keys(INVENTORIES),
    write: false,
    report: false,
    json: false,
    confirmation: { keys: new Set(), all: false },
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") continue
    if (arg === "--write-baseline") opts.write = true
    else if (arg === "--report") opts.report = true
    else if (arg === "--json") opts.json = true
    else if (arg === "--reconfirm-all") opts.confirmation.all = true
    else if (arg === "--reconfirm" && argv[i + 1]) opts.confirmation.keys.add(argv[++i])
    else if (arg === "--root" && argv[i + 1]) opts.root = resolve(argv[++i])
    else if (arg === "--inventory" && argv[i + 1]) {
      const name = argv[++i]
      if (!(name in INVENTORIES)) throw new Error(`unknown inventory: ${name}`)
      opts.names = [name]
    } else throw new Error(`unknown or incomplete argument: ${arg}`)
  }
  if (opts.write && opts.report) throw new Error("choose --write-baseline or --report")
  if (!opts.write && (opts.confirmation.all || opts.confirmation.keys.size))
    throw new Error("--reconfirm requires --write-baseline")
  return opts
}

export function main(argv = [], output = console) {
  const started = performance.now()
  try {
    const opts = options(argv)
    const analysis = analyze(opts.root, opts.names)
    if (opts.write) {
      if (analysis.readErrors.length) throw new Error(analysis.readErrors.join("; "))
      for (const name of opts.names) {
        const baseline = analysis.baselines.get(name)
        if (!analysis.ctx.exists(`${INVENTORY_DIR}/${name}.json`)) continue
        if (
          !baseline ||
          baseline.inventory !== name ||
          !Array.isArray(baseline.members) ||
          !Array.isArray(baseline.excluded)
        )
          throw new Error(
            `${name}: malformed inventory envelope; refusing to overwrite reviewed decisions`
          )
        const keys = new Set()
        for (const row of [...baseline.members, ...baseline.excluded]) {
          if (!row || !textPresent(row.key))
            throw new Error(`${name}: missing key; refusing to overwrite reviewed decisions`)
          if (keys.has(row.key))
            throw new Error(
              `${name}: duplicate key ${row.key}; refusing to overwrite reviewed decisions`
            )
          keys.add(row.key)
        }
      }
      for (const key of opts.confirmation.keys)
        if (
          ![...analysis.detected.values()].some((rows) => rows.some((row) => row.key === key)) &&
          ![...analysis.baselines.values()].some((b) =>
            b?.members?.some(
              (row) =>
                row.key === key && key.startsWith("manual:") && manualStillExists(analysis.ctx, row)
            )
          )
        )
          throw new Error(`unknown --reconfirm key: ${key}`)
      const discoveryErrors = analysis.reports.flatMap((r) =>
        r.invalid.filter(
          (e) =>
            e.includes("ambiguous key") ||
            e.includes("runtime root") ||
            e.includes("detector miss") ||
            e.includes("pending ceiling")
        )
      )
      if (opts.names.includes("runtime-initializers"))
        discoveryErrors.push(...runtimeRootCoverage(analysis.ctx).invalid)
      if (discoveryErrors.length) throw new Error(discoveryErrors.join("; "))
      // Fixture repositories need not be Git repos. The sentinel is explicit;
      // real baseline writes always record the current Git HEAD.
      let commit
      try {
        commit = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: opts.root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim()
      } catch {
        if (existsSync(join(opts.root, ".git"))) throw new Error("cannot resolve baseline commit")
        commit = "unversioned-fixture"
      }
      const generatedAt = { commit, date: new Date().toISOString().slice(0, 10) }
      mkdirSync(join(opts.root, INVENTORY_DIR), { recursive: true })
      for (const report of analysis.reports) {
        const name = report.inventory
        const baseline = rewriteInventory(
          name,
          analysis.detected.get(name),
          analysis.baselines.get(name),
          generatedAt,
          analysis.ctx,
          opts.confirmation
        )
        writeFileSync(
          join(opts.root, INVENTORY_DIR, `${name}.json`),
          JSON.stringify(baseline, null, 2) + "\n"
        )
        report.metrics = baseline.metrics
        if (!opts.json)
          output.log(
            `[convergence] ${name}: added ${report.added.length}, removed ${report.repaid.length + report.stale.length}`
          )
      }
    }
    const report = {
      inventories: Object.fromEntries(analysis.reports.map((r) => [r.inventory, r])),
      unresolvedRowTypes: analysis.unresolvedRowTypes,
      elapsedMs: Math.round(performance.now() - started),
    }
    if (opts.json) output.log(JSON.stringify(report, null, 2))
    else if (opts.report) {
      output.log("inventory | metrics\n--- | ---")
      for (const row of analysis.reports)
        output.log(
          `${row.inventory} | ${Object.entries(row.metrics)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}`
        )
      for (const row of analysis.reports)
        if (!row.ok)
          output.log(
            `[convergence] ${row.inventory}: added=${row.added.length}, repaid=${row.repaid.length}, stale=${row.stale.length}, invalid=${row.invalid.length}`
          )
      output.log(`\nUnresolved row types (${report.unresolvedRowTypes.length}):`)
      for (const row of report.unresolvedRowTypes)
        output.log(`  ${row.key}: ${row.rowType ?? "<no typed row>"}`)
      output.log(`\n[convergence] ${report.elapsedMs} ms`)
    } else if (!opts.write) {
      for (const row of analysis.reports) {
        if (row.added.length)
          output.error(
            `[convergence] new ${row.inventory} member(s) — added (new debt):\n  ${row.added.join("\n  ")}`
          )
        if (row.repaid.length)
          output.error(
            `[convergence] ${row.inventory} repaid — run \`pnpm audit:convergence:baseline\` to lock it in:\n  ${row.repaid.join("\n  ")}`
          )
        if (row.stale.length)
          output.error(
            `[convergence] ${row.inventory} stale exclusion(s):\n  ${row.stale.join("\n  ")}`
          )
        if (row.invalid.length)
          output.error(`[convergence] ${row.inventory} invalid:\n  ${row.invalid.join("\n  ")}`)
      }
      if (analysis.reports.every((r) => r.ok))
        output.log(`[convergence] OK: inventories exact and valid (${report.elapsedMs} ms)`)
    }
    return opts.write || opts.report || analysis.reports.every((r) => r.ok) ? 0 : 1
  } catch (error) {
    output.error(`[convergence] invalid: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
