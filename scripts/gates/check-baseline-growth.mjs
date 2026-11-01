#!/usr/bin/env node
/**
 * Gate: a ratchet baseline may only fall, measured against the merge base.
 *
 * ## Why this exists
 *
 * About twenty gates tolerate known debt through a baseline file: the
 * co-located-test list, host-parity findings, the RPC semantic-parity
 * ceilings, the i18n count, the convergence inventories and so on. Each gate
 * compares the tree against the baseline in the SAME tree, and each has a
 * `--write-baseline` that rewrites the file from the current scan. So a pull
 * request could add new debt and the matching baseline line in one change,
 * and every gate would stay green. The architecture audit of 2026-11-01 (§7)
 * found exactly that: "only fewer" was a convention, because CI never looked
 * at the base commit. ADR-0250 §11 makes it a rule: baselines cannot grow
 * quietly.
 *
 * ## What this checks
 *
 * `scripts/gates/baseline-growth.json` lists every ratchet file and how to
 * measure it (array length, numeric sum, a ceiling value, ...). For each
 * measure the check reads the file at HEAD and at the base commit
 * (`git show <base>:<file>`) and fails when the number rose.
 *
 * A rise is allowed only when the same change adds an exception record under
 * `scripts/gates/baseline-exceptions/<YYYY-MM-DD>-<slug>.json` naming the file,
 * the measure, how much it may grow, an owner and a repayment phase. Only
 * records that do not exist at the base count: an old record cannot be reused
 * to wave through new growth. Records stay in the tree as the history of
 * accepted growth; `--exceptions` prints them for the phase ledger.
 *
 * Stable ratchet ids in both configs preserve the base path across moves.
 * Removing a ratchet, file, measure path or numeric leaf requires a new
 * exception with `allowRemoval: true`; invalid numeric types always fail.
 *
 * A ratchet file absent at the base is reported as introduced and passes: a
 * new gate's first baseline records debt that already existed, and the file
 * itself is reviewed as part of adding the gate. An unapproved removal fails,
 * because the list would then be lying about coverage.
 *
 * `scripts/gates/check-baseline-growth.test.mjs` fails when a `*baseline*`
 * file under `scripts/gates/`, a convergence inventory or a reviewed debt JSON
 * input of a registered gate is neither listed as a ratchet nor recorded under
 * `notRatchets` with a reason. A source scan also checks that new gate debt
 * inputs enter the committed coverage list.
 *
 * ## Which base
 *
 *   1. `--base <ref>`, else `BASELINE_GROWTH_BASE`;
 *   2. in CI, the Quality change plan's `base` (`.cache/ci/changes.json`).
 *      Pull-request runs check out the merge commit, so comparing it with the
 *      PR's base commit is exactly the growth the PR would land;
 *   3. locally, `git merge-base HEAD origin/dev`.
 * A base commit that is not in a shallow clone is fetched with depth 1. If no
 * base can be resolved the check fails on CI pull-request and push runs and
 * is skipped with a notice elsewhere (local, scheduled, manual runs). CI sets
 * `BASELINE_GROWTH_BASE` to the PR base or the push's previous head.
 *
 * Usage:
 *   pnpm audit:baseline-growth
 *   pnpm audit:baseline-growth -- --base origin/dev
 *   pnpm audit:baseline-growth -- --exceptions     # list exception records
 *   pnpm audit:baseline-growth -- --json
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const CONFIG_FILE = "scripts/gates/baseline-growth.json"
export const EXCEPTIONS_DIR = "scripts/gates/baseline-exceptions"
export const MEASURE_KINDS = ["length", "sum", "value", "eachValue", "sumLength"]
/** ADR-0250 §13 phase ids an exception may name as its repayment phase. */
export const REPAYMENT_PHASES = ["0a", "0b", "S1", "1", "2", "3", "4"]
export const MIN_REASON_LENGTH = 20
const EXCEPTION_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.json$/

// ── measuring ───────────────────────────────────────────────────────────────

/** Resolve a dot path; `""` is the root. Returns `undefined` when absent. */
export function atPath(doc, path) {
  if (!path) return doc
  let cur = doc
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function numericLeaves(value, prefix, out) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${prefix || "."}: expected a finite number`)
    out.push([prefix, value])
  } else if (Array.isArray(value)) value.forEach((v, i) => numericLeaves(v, `${prefix}[${i}]`, out))
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) numericLeaves(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

function sumLengths(value, key) {
  let total = 0
  if (Array.isArray(value)) for (const v of value) total += sumLengths(v, key)
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k === key) {
        if (!Array.isArray(v)) throw new Error(`${key}: expected an array`)
        total += v.length
      } else total += sumLengths(v, key)
    }
  return total
}

/**
 * Measure a parsed document. Returns a map of `measureId` (or
 * `measureId:leafPath` for `eachValue`) to a number; a missing path yields no
 * entry. The comparison separately rejects disappearance at HEAD.
 *
 * @returns {Map<string, number>}
 */
export function measure(doc, m) {
  const out = new Map()
  const target = atPath(doc, m.path ?? "")
  if (target === undefined) return out
  switch (m.kind) {
    case "length":
      if (Array.isArray(target)) out.set(m.id, target.length)
      else if (target && typeof target === "object") out.set(m.id, Object.keys(target).length)
      else throw new Error(`${m.id}: path "${m.path}" is neither an array nor an object`)
      break
    case "sum":
      if (target === null || !["number", "object"].includes(typeof target))
        throw new Error(`${m.id}: expected a numeric tree`)
      out.set(
        m.id,
        numericLeaves(target, "", []).reduce((acc, [, v]) => acc + v, 0)
      )
      break
    case "value":
      if (typeof target !== "number" || !Number.isFinite(target))
        throw new Error(`${m.id}: path "${m.path}" is not a finite number`)
      out.set(m.id, target)
      break
    case "eachValue":
      if (target === null || !["number", "object"].includes(typeof target))
        throw new Error(`${m.id}: expected a numeric tree`)
      for (const [leaf, v] of numericLeaves(target, "", [])) out.set(`${m.id}:${leaf || "."}`, v)
      break
    case "sumLength":
      if (target === null || typeof target !== "object")
        throw new Error(`${m.id}: expected an array or object`)
      out.set(m.id, sumLengths(target, m.key))
      break
    default:
      throw new Error(`${m.id}: unknown measure kind "${m.kind}"`)
  }
  for (const [key, value] of out)
    if (!Number.isFinite(value)) throw new Error(`${key}: expected a finite number`)
  return out
}

// ── config and exceptions ───────────────────────────────────────────────────

/** @returns {string[]} problems */
export function validateConfig(config) {
  const problems = []
  const seen = new Set()
  const ratchetIds = new Set()
  for (const r of config.ratchets ?? []) {
    if (typeof r.id !== "string" || !r.id.trim()) problems.push(`${r.file}: a ratchet has no id`)
    if (ratchetIds.has(r.id)) problems.push(`${r.file}: ratchet id ${r.id} is listed twice`)
    ratchetIds.add(r.id)
    if (!r.file) problems.push("a ratchet entry has no file")
    if (seen.has(r.file)) problems.push(`${r.file} is listed twice`)
    seen.add(r.file)
    if (!Array.isArray(r.measures) || r.measures.length === 0)
      problems.push(`${r.file}: no measures`)
    const ids = new Set()
    for (const m of r.measures ?? []) {
      if (!m.id) problems.push(`${r.file}: a measure has no id`)
      if (ids.has(m.id)) problems.push(`${r.file}: measure ${m.id} is listed twice`)
      ids.add(m.id)
      if (!MEASURE_KINDS.includes(m.kind))
        problems.push(`${r.file}: measure ${m.id} has unknown kind "${m.kind}"`)
      if (m.kind === "sumLength" && !m.key)
        problems.push(`${r.file}: sumLength measure ${m.id} needs a key`)
    }
  }
  for (const n of config.notRatchets ?? []) {
    if (seen.has(n.file)) problems.push(`${n.file} is both a ratchet and a non-ratchet`)
    if (!n.reason || n.reason.length < MIN_REASON_LENGTH)
      problems.push(
        `${n.file}: a non-ratchet needs a reason of at least ${MIN_REASON_LENGTH} characters`
      )
  }
  return problems
}

/**
 * Validate one exception record against the config.
 * @returns {string[]} problems
 */
export function validateException(name, record, config, { historical = false } = {}) {
  const problems = []
  const where = `${EXCEPTIONS_DIR}/${name}`
  if (!EXCEPTION_NAME.test(name)) problems.push(`${where}: name must be <YYYY-MM-DD>-<slug>.json`)
  if (!record || typeof record !== "object" || Array.isArray(record))
    return [...problems, `${where}: must be a JSON object`]
  const ratchets = (config.ratchets ?? []).filter((r) => r.file === record.file)
  if (!record.file) problems.push(`${where}: missing "file"`)
  else if (!ratchets.length && !historical)
    problems.push(`${where}: "${record.file}" is not a listed ratchet file`)
  if (!record.measure) problems.push(`${where}: missing "measure"`)
  else if (ratchets.length && !historical) {
    const base = String(record.measure).split(":")[0]
    if (!ratchets.some((r) => r.measures.some((m) => m.id === base)))
      problems.push(`${where}: "${record.file}" has no measure "${base}"`)
  }
  if (record.allowRemoval !== undefined && record.allowRemoval !== true)
    problems.push(`${where}: "allowRemoval" must be true when supplied`)
  if (
    (record.allowGrowth !== undefined || record.allowRemoval !== true) &&
    (!Number.isInteger(record.allowGrowth) || record.allowGrowth < 1)
  )
    problems.push(`${where}: "allowGrowth" must be a positive integer`)
  if (typeof record.owner !== "string" || !record.owner.trim())
    problems.push(`${where}: missing "owner"`)
  if (!REPAYMENT_PHASES.includes(record.repaymentPhase))
    problems.push(`${where}: "repaymentPhase" must be one of ${REPAYMENT_PHASES.join(", ")}`)
  if (typeof record.reason !== "string" || record.reason.trim().length < MIN_REASON_LENGTH)
    problems.push(`${where}: "reason" must be at least ${MIN_REASON_LENGTH} characters`)
  return problems
}

/**
 * Does an exception for `measure` cover a measured key? `ceilings` covers
 * every `ceilings:*` leaf; `ceilings:opaque-response-schema` covers one leaf.
 */
export function exceptionCovers(exceptionMeasure, key) {
  return exceptionMeasure === key || key.startsWith(`${exceptionMeasure}:`)
}

// ── comparison ──────────────────────────────────────────────────────────────

function removalRow(file, key, base, exceptions, reason) {
  const covering = exceptions.filter(
    (e) => e.file === file && e.allowRemoval === true && exceptionCovers(e.measure, key)
  )
  return {
    file,
    key,
    base,
    head: null,
    delta: null,
    reason,
    status: covering.length ? "excepted" : "removed",
    ...(covering.length ? { allowedBy: covering.map((e) => e.name) } : {}),
  }
}

/** Preserve numeric types even for aggregates, which otherwise hide strings. */
function assertFiniteContinuity(base, head, path = "") {
  if (typeof base === "number" && head !== undefined) {
    if (typeof head !== "number" || !Number.isFinite(head))
      throw new Error(`${path || "."}: expected a finite number`)
  } else if (base && typeof base === "object") {
    if (
      head !== undefined &&
      (head === null || typeof head !== "object") &&
      numericLeaves(base, "", []).length
    )
      throw new Error(`${path || "."}: expected a tree of finite numbers`)
    for (const [key, value] of Object.entries(base)) {
      const next = head && typeof head === "object" ? head[key] : undefined
      assertFiniteContinuity(value, next, path ? `${path}.${key}` : key)
    }
  }
}

/**
 * Compare one ratchet file at base and head. Pure.
 *
 * @param {object} ratchet  config entry
 * @param {object | null} baseDoc  parsed file at the base, or null if absent
 * @param {object | undefined} headDoc  parsed file at HEAD, undefined if absent
 * @param {Array<{ file, measure, allowGrowth?, allowRemoval? }>} exceptions  new records only
 * @param {object} baseRatchet  old definition (paths may have moved)
 * @returns {Array<{ file, key, base, head, delta, status, allowedBy? }>}
 *   status: "ok" | "shrank" | "grew" | "removed" | "excepted" | "introduced"
 */
export function compareRatchet(ratchet, baseDoc, headDoc, exceptions = [], baseRatchet = ratchet) {
  const rows = []
  const measures = new Map([...baseRatchet.measures, ...ratchet.measures].map((m) => [m.id, m]))
  for (const m of measures.values()) {
    const old = baseRatchet.measures.find((old) => old.id === m.id)
    const current = ratchet.measures.find((current) => current.id === m.id)
    if (old && current && old.kind !== current.kind)
      throw new Error(`${m.id}: measure kind changed from ${old.kind} to ${current.kind}`)
    const baseTarget = baseDoc !== null && old ? atPath(baseDoc, old.path ?? "") : undefined
    const headTarget = current ? atPath(headDoc, current.path ?? "") : undefined
    const base = baseTarget === undefined ? new Map() : measure(baseDoc, old)
    if (headTarget === undefined) {
      if (baseTarget === undefined) throw new Error(`${m.id}: measure path is missing at HEAD`)
      const removed = base.size ? base : new Map([[m.id, null]])
      for (const [key, value] of removed)
        rows.push(removalRow(ratchet.file, key, value, exceptions, "measure removed"))
      continue
    }
    if (["sum", "eachValue", "value"].includes(m.kind))
      assertFiniteContinuity(baseTarget, headTarget)
    const head = measure(headDoc, current)
    if (m.kind === "sum" && baseTarget !== undefined) {
      const headLeaves = new Map(numericLeaves(headTarget, "", []))
      for (const [leaf, value] of numericLeaves(baseTarget, "", []))
        if (!headLeaves.has(leaf))
          rows.push(
            removalRow(
              ratchet.file,
              `${m.id}:${leaf || "."}`,
              value,
              exceptions,
              "numeric leaf removed"
            )
          )
    }
    for (const key of new Set([...base.keys(), ...head.keys()])) {
      if (!head.has(key)) {
        rows.push(removalRow(ratchet.file, key, base.get(key), exceptions, "numeric leaf removed"))
        continue
      }
      const headValue = head.get(key)
      const row = { file: ratchet.file, key, base: base.get(key) ?? null, head: headValue }
      if (row.base === null) {
        rows.push({ ...row, delta: null, status: "introduced" })
        continue
      }
      const delta = headValue - row.base
      if (delta <= 0) {
        rows.push({ ...row, delta, status: delta < 0 ? "shrank" : "ok" })
        continue
      }
      const covering = exceptions.filter(
        (e) => e.file === ratchet.file && exceptionCovers(e.measure, key)
      )
      const allowance = covering.reduce((acc, e) => acc + (e.allowGrowth ?? 0), 0)
      if (covering.length && delta <= allowance)
        rows.push({ ...row, delta, status: "excepted", allowedBy: covering.map((e) => e.name) })
      else rows.push({ ...row, delta, status: "grew", allowance })
    }
  }
  return rows
}

// ── git and I/O ─────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

/** Read a file at a commit; null when it does not exist there. */
export function readAtCommit(commit, file, cwd = REPO_ROOT) {
  return tryGit(["show", `${commit}:${file}`], cwd)
}

/**
 * Resolve the base commit SHA. Returns `{ sha, source }` or `{ sha: null,
 * reason }`.
 */
export function resolveBase({ argBase, env = process.env, cwd = REPO_ROOT } = {}) {
  const candidates = []
  const usable = (ref) => typeof ref === "string" && ref.trim() !== "" && !/^0+$/.test(ref.trim())
  if (usable(argBase)) candidates.push([argBase, "--base"])
  else if (usable(env.BASELINE_GROWTH_BASE))
    candidates.push([env.BASELINE_GROWTH_BASE.trim(), "BASELINE_GROWTH_BASE"])
  else {
    const planFile = join(cwd, ".cache/ci/changes.json")
    if (existsSync(planFile)) {
      try {
        const plan = JSON.parse(readFileSync(planFile, "utf8"))
        // A full-mode plan for a real event still records the event base;
        // only a plan whose base is its own head carries no comparison.
        if (usable(plan.base) && plan.base !== plan.head)
          candidates.push([plan.base, "change plan"])
      } catch {
        /* fall through to merge-base */
      }
    }
    if (!candidates.length) {
      const mb = tryGit(["merge-base", "HEAD", "origin/dev"], cwd)?.trim()
      if (mb) candidates.push([mb, "merge-base HEAD origin/dev"])
    }
  }
  for (const [ref, source] of candidates) {
    let sha = tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)?.trim()
    if (!sha && /^[0-9a-f]{40}$/.test(ref)) {
      tryGit(["fetch", "--no-tags", "--depth=1", "origin", ref], cwd)
      sha = tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)?.trim()
    }
    if (sha) return { sha, source }
    return { sha: null, reason: `${source} (${ref}) is not a commit in this clone` }
  }
  return { sha: null, reason: "no base given and no origin/dev to take a merge base from" }
}

/** Exception records at HEAD, each flagged with whether it is new vs base. */
export function readExceptions(baseSha, cwd = REPO_ROOT) {
  const dir = join(cwd, EXCEPTIONS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = `${EXCEPTIONS_DIR}/${name}`
      let record = null
      let parseError = null
      try {
        record = JSON.parse(readFileSync(join(dir, name), "utf8"))
      } catch (error) {
        parseError = String(error.message ?? error)
      }
      const isNew = baseSha ? readAtCommit(baseSha, path, cwd) === null : true
      return { name, path, record, parseError, isNew }
    })
}

export function readConfig(cwd = REPO_ROOT) {
  return JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8"))
}

/**
 * Run the whole check. Returns `{ ok, rows, problems, base }`.
 */
export function analyze({ cwd = REPO_ROOT, argBase, env = process.env } = {}) {
  const config = readConfig(cwd)
  const problems = validateConfig(config)
  const base = resolveBase({ argBase, env, cwd })
  if (!base.sha) return { ok: false, skipped: true, base, rows: [], problems }

  let baseRatchets = []
  try {
    const baseConfigText = readAtCommit(base.sha, CONFIG_FILE, cwd)
    if (baseConfigText !== null) baseRatchets = JSON.parse(baseConfigText).ratchets
    if (!Array.isArray(baseRatchets)) throw new Error("ratchets must be an array")
  } catch (error) {
    problems.push(`${CONFIG_FILE} at base: ${error.message ?? error}`)
    return { ok: false, base, rows: [], problems }
  }
  // Both paths validate a new removal record, including a removed ratchet's
  // old measures. Historical records remain an audit trail, never allowances.
  const exceptionConfig = { ratchets: [...config.ratchets, ...baseRatchets] }

  const exceptionFiles = readExceptions(base.sha, cwd)
  const newExceptions = []
  for (const e of exceptionFiles) {
    if (e.parseError) {
      problems.push(`${e.path}: ${e.parseError}`)
      continue
    }
    const invalid = validateException(e.name, e.record, exceptionConfig, { historical: !e.isNew })
    problems.push(...invalid)
    if (e.isNew && !invalid.length) newExceptions.push({ ...e.record, name: e.name })
  }

  const rows = []
  for (const ratchet of config.ratchets) {
    const previous =
      baseRatchets.find((r) => r.id && r.id === ratchet.id) ??
      baseRatchets.find((r) => r.file === ratchet.file)
    const headPath = join(cwd, ratchet.file)
    try {
      const baseText = readAtCommit(base.sha, previous?.file ?? ratchet.file, cwd)
      const baseDoc = baseText === null ? null : JSON.parse(baseText)
      if (!existsSync(headPath) && baseText === null) {
        problems.push(`${ratchet.file} is listed in ${CONFIG_FILE} but missing at HEAD`)
        continue
      }
      const headDoc = existsSync(headPath) ? JSON.parse(readFileSync(headPath, "utf8")) : undefined
      rows.push(...compareRatchet(ratchet, baseDoc, headDoc, newExceptions, previous ?? ratchet))
    } catch (error) {
      problems.push(`${ratchet.file}: ${error.message ?? error}`)
    }
  }
  for (const previous of baseRatchets) {
    if (
      config.ratchets.some((r) => (previous.id && r.id === previous.id) || r.file === previous.file)
    )
      continue
    for (const m of previous.measures)
      rows.push(removalRow(previous.file, m.id, null, newExceptions, "ratchet removed"))
  }
  const failed = rows.filter((r) => r.status === "grew" || r.status === "removed")
  return {
    ok: failed.length === 0 && problems.length === 0,
    base,
    rows,
    problems,
    exceptions: exceptionFiles,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function printExceptions(cwd) {
  const files = readExceptions(null, cwd)
  if (!files.length) {
    console.log("[baseline-growth] no exception records")
    return
  }
  console.log("| record | file | measure | growth | removal | owner | repayment | reason |")
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const { name, record } of files) {
    const r = record ?? {}
    console.log(
      `| ${name} | ${r.file} | ${r.measure} | +${r.allowGrowth ?? 0} | ${r.allowRemoval === true} | ${r.owner} | ${r.repaymentPhase} | ${String(r.reason ?? "").replace(/\|/g, "\\|")} |`
    )
  }
}

/**
 * Without a base the check cannot run. That is fatal where a base exists by
 * definition (a pull request or a push in CI) and a notice everywhere else
 * (local runs, scheduled and manual CI runs).
 */
export function missingBaseIsFatal(env) {
  return Boolean(env.CI) && ["pull_request", "push"].includes(env.GITHUB_EVENT_NAME ?? "")
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const baseIdx = argv.indexOf("--base")
  const argBase = baseIdx >= 0 ? argv[baseIdx + 1] : undefined
  if (argv.includes("--exceptions")) {
    printExceptions(REPO_ROOT)
    return 0
  }
  const result = analyze({ argBase, env })
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok || (result.skipped && !missingBaseIsFatal(env)) ? 0 : 1
  }
  if (result.skipped) {
    const msg = `[baseline-growth] no base commit: ${result.base.reason}`
    if (missingBaseIsFatal(env)) {
      console.error(`${msg}. A ${env.GITHUB_EVENT_NAME} run must compare against a base; failing.`)
      return 1
    }
    console.log(`${msg}. Skipped; pass --base <ref> to check.`)
    return 0
  }
  console.log(`[baseline-growth] base ${result.base.sha.slice(0, 12)} (${result.base.source})`)
  for (const r of result.rows.filter((row) => row.status !== "ok")) {
    const tag = {
      shrank: "↓",
      introduced: "+new",
      excepted: "excepted",
      grew: "✗ GREW",
      removed: "✗ REMOVED",
    }[r.status]
    const delta = r.delta === null ? "" : ` (${r.delta > 0 ? "+" : ""}${r.delta})`
    const by = r.allowedBy ? ` by ${r.allowedBy.join(", ")}` : ""
    const reason = r.reason ? ` (${r.reason})` : ""
    console.log(
      `  ${tag} ${r.file} ${r.key}: ${r.base ?? "—"} → ${r.head ?? "—"}${delta}${reason}${by}`
    )
  }
  for (const p of result.problems) console.error(`  ✗ ${p}`)
  const grew = result.rows.filter((r) => r.status === "grew")
  if (grew.length) {
    console.error(
      `\n[baseline-growth] ${grew.length} ratchet measure(s) grew. Repay the new debt, or add an exception record under ${EXCEPTIONS_DIR}/ (file, measure, allowGrowth, owner, repaymentPhase, reason).`
    )
  }
  const removed = result.rows.filter((r) => r.status === "removed")
  if (removed.length)
    console.error(
      `[baseline-growth] ${removed.length} removal(s) require an allowRemoval exception under ${EXCEPTIONS_DIR}/.`
    )
  if (result.ok) console.log(`[baseline-growth] ${result.rows.length} measures, none grew`)
  return result.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
