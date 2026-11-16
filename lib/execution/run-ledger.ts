/**
 * ADR-0243 §6: one persisted budget (tokens, USD, deadline) for a whole run
 * tree, on the ExecutionRun that declared it.
 *
 * - The pool is found from Host rows only: the nearest ancestor (or the run
 *   itself) carrying `runLedger`. A caller, plugin or model never names it.
 * - An execution reserves before it starts: its own cap, or everything left.
 *   A hold is taken out of the nearest ancestor's live hold, so a turn that
 *   holds the pool can still start children. A reservation that cannot be
 *   granted while a sibling holds the pool waits for a release.
 * - Settling removes the hold. A confirmed stop with known usage charges the
 *   usage; anything else charges the whole hold. Unknown spend is never zero.
 * - Every write is one Dexie rw transaction, so windows and the brain sharing
 *   a database cannot overspend.
 */
import { getDb } from "@/lib/db/schema"
import type {
  ExecutionRun,
  RunBudgetAmountsV1,
  RunBudgetHoldV1,
  RunLedgerV1,
} from "@/types/execution/run"
import { resolveModelPricingUsd, type ResolvePricingOptions } from "@/lib/usage/pricing"
import { holdChildRunOwnership, heldChildRunOwnership } from "./child-run-ownership"

export type RunBudgetRefusal =
  "budget_exhausted" | "deadline_exceeded" | "pricing_unknown" | "cancelled" | "hold_unavailable"

export class RunBudgetError extends Error {
  constructor(readonly reason: RunBudgetRefusal) {
    super(
      reason === "pricing_unknown"
        ? "This run has a USD budget and the model has no price. Set its price first."
        : reason === "budget_exhausted"
          ? "This run's budget is used up."
          : reason === "deadline_exceeded"
            ? "This run's deadline has passed."
            : reason
    )
    this.name = "RunBudgetError"
  }
}

/** Ceilings a run declares for its tree. `deadlineMs` counts from declaration. */
export interface RunBudgetCaps {
  tokens?: number
  costUsd?: number
  deadlineMs?: number
}

/** A granted reservation. `finish` settles it once; later calls do nothing. */
export interface RunBudgetHold {
  readonly rootRunId: string
  readonly holdId: string
  readonly amounts: RunBudgetAmountsV1
  readonly deadlineAt?: number
  report(usage: RunBudgetAmountsV1): Promise<void>
  /** What this hold and everything lent from it spent so far. */
  spent(): Promise<RunBudgetAmountsV1>
  finish(usage: RunBudgetAmountsV1 | undefined, confirmedStopped: boolean): Promise<void>
}

type Db = ReturnType<typeof getDb>
const DIMENSIONS = ["tokens", "costUsd"] as const
const WAIT_MS = 250

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

/** A ceiling: zero and non-finite values mean none, as every setting has it. */
function isCap(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

/** Ancestry from Host rows, the run itself first, up to the pool's root. */
async function poolChain(
  db: Db,
  runId: string
): Promise<{ root: ExecutionRun & { runLedger: RunLedgerV1 }; chain: ExecutionRun[] } | undefined> {
  const chain: ExecutionRun[] = []
  let id: string | undefined = runId
  while (id && chain.length < 64) {
    const run: ExecutionRun | undefined = await db.executionRuns.get(id)
    if (!run) return undefined
    chain.push(run)
    if (run.runLedger) return { root: run as ExecutionRun & { runLedger: RunLedgerV1 }, chain }
    id = run.parentRunId
  }
  return undefined
}

/**
 * The nearest live hold on the chain, the run itself first: a second
 * execution of a run that already holds lends from that hold instead of
 * waiting behind it.
 */
function parentHold(ledger: RunLedgerV1, chain: ExecutionRun[]): string | undefined {
  for (const ancestor of chain) {
    const holdId = Object.keys(ledger.holds).find((id) => ledger.holds[id].runId === ancestor.id)
    if (holdId) return holdId
  }
  return undefined
}

function available(ledger: RunLedgerV1, parentHoldId: string | undefined): RunBudgetAmountsV1 {
  const parent = parentHoldId ? ledger.holds[parentHoldId] : undefined
  const result: RunBudgetAmountsV1 = {}
  for (const field of DIMENSIONS) {
    const base = parent
      ? parent.amounts[field] === undefined
        ? undefined
        : parent.amounts[field]! - (parent.observed?.[field] ?? 0)
      : ledger.limits[field] === undefined
        ? undefined
        : ledger.limits[field]! - ledger.spent[field]
    if (base === undefined) continue
    const lent = Object.values(ledger.holds)
      .filter((hold) => hold.parentHoldId === parentHoldId)
      .reduce((sum, hold) => sum + (hold.amounts[field] ?? 0), 0)
    result[field] = Math.max(0, base - lent)
  }
  return result
}

function holdDeadline(ledger: RunLedgerV1, holdId: string | undefined): number | undefined {
  const deadlines: number[] = []
  if (ledger.deadlineAt !== undefined) deadlines.push(ledger.deadlineAt)
  for (let id = holdId; id; id = ledger.holds[id].parentHoldId) {
    const own = ledger.holds[id].deadlineAt
    if (own !== undefined) deadlines.push(own)
  }
  return deadlines.length ? Math.min(...deadlines) : undefined
}

function wait(signal: AbortSignal | undefined, deadlineAt: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new RunBudgetError("cancelled"))
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      },
      Math.max(1, Math.min(WAIT_MS, (deadlineAt ?? Infinity) - Date.now()))
    )
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

type Admission =
  | { refusal: RunBudgetRefusal }
  | { waitUntil: number | undefined }
  | { parentHoldId: string | undefined; deadlineAt: number | undefined; free: RunBudgetAmountsV1 }

/** Whether a new hold under `chain` would be granted now, waited for or refused. */
function admission(
  ledger: RunLedgerV1,
  chain: ExecutionRun[],
  options: Pick<ReserveRunBudgetOptions, "model" | "pricing">
): Admission {
  const parentHoldId = parentHold(ledger, chain)
  const deadlineAt = holdDeadline(ledger, parentHoldId)
  if (deadlineAt !== undefined && deadlineAt <= Date.now()) return { refusal: "deadline_exceeded" }
  if (
    ledger.limits.costUsd !== undefined &&
    options.model &&
    !resolveModelPricingUsd(options.model.providerId, options.model.modelId, options.pricing)
  )
    return { refusal: "pricing_unknown" }
  const free = available(ledger, parentHoldId)
  if (DIMENSIONS.some((field) => free[field] !== undefined && free[field]! <= 0)) {
    const siblingHolds = Object.values(ledger.holds).some(
      (hold) => hold.parentHoldId === parentHoldId
    )
    return siblingHolds ? { waitUntil: deadlineAt } : { refusal: "budget_exhausted" }
  }
  return { parentHoldId, deadlineAt, free }
}

export interface ReserveRunBudgetOptions {
  /** This execution's own ceiling; without one it takes everything left. */
  caps?: RunBudgetCaps
  /** The model an execution calls; required under a USD limit. */
  model?: { providerId?: string; modelId: string }
  pricing?: ResolvePricingOptions
  signal?: AbortSignal
}

/**
 * Reserve for `runId` from its tree's ledger. Resolves `undefined` when no
 * ancestor declared a budget, which leaves the execution exactly as before.
 */
export async function reserveRunBudget(
  runId: string,
  options: ReserveRunBudgetOptions = {}
): Promise<RunBudgetHold | undefined> {
  const db = getDb()
  const holdId = crypto.randomUUID()
  // The claim outlives this window only as long as the hold: recovery settles
  // a hold nobody claims as an unconfirmed stop.
  const releaseClaim = await holdChildRunOwnership(`budget:${holdId}`)
  try {
    while (true) {
      if (options.signal?.aborted) throw new RunBudgetError("cancelled")
      const attempt = await db.transaction("rw", db.executionRuns, async () => {
        const found = await poolChain(db, runId)
        if (!found) return { none: true as const }
        const ledger = found.root.runLedger
        const admitted = admission(ledger, found.chain, options)
        if ("refusal" in admitted) throw new RunBudgetError(admitted.refusal)
        if ("waitUntil" in admitted) return admitted
        const { parentHoldId, free } = admitted
        const amounts: RunBudgetAmountsV1 = {}
        for (const field of DIMENSIONS) {
          const own = isCap(options.caps?.[field]) ? options.caps![field]! : undefined
          const bound = Math.min(free[field] ?? Infinity, own ?? Infinity)
          if (Number.isFinite(bound)) amounts[field] = bound
        }
        const ownDeadline = isCap(options.caps?.deadlineMs)
          ? Date.now() + options.caps!.deadlineMs!
          : undefined
        const hold: RunBudgetHoldV1 = {
          runId,
          amounts,
          createdAt: Date.now(),
          ...(parentHoldId ? { parentHoldId } : {}),
          ...(ownDeadline !== undefined ? { deadlineAt: ownDeadline } : {}),
        }
        ledger.holds[holdId] = hold
        await db.executionRuns.update(found.root.id, { runLedger: ledger })
        return {
          granted: {
            rootRunId: found.root.id,
            amounts,
            deadlineAt: holdDeadline(ledger, holdId),
          },
        }
      })
      if ("none" in attempt) {
        releaseClaim()
        return undefined
      }
      if ("granted" in attempt) return holdHandle(db, holdId, attempt.granted, releaseClaim)
      await wait(options.signal, attempt.waitUntil)
    }
  } catch (error) {
    releaseClaim()
    throw error
  }
}

function holdHandle(
  db: Db,
  holdId: string,
  granted: { rootRunId: string; amounts: RunBudgetAmountsV1; deadlineAt?: number },
  releaseClaim: () => void
): RunBudgetHold {
  let finished = false
  const mutate = (change: (ledger: RunLedgerV1, hold: RunBudgetHoldV1) => void) =>
    db.transaction("rw", db.executionRuns, async () => {
      const ledger = (await db.executionRuns.get(granted.rootRunId))?.runLedger
      const hold = ledger?.holds[holdId]
      if (!ledger || !hold) return
      change(ledger, hold)
      await db.executionRuns.update(granted.rootRunId, { runLedger: ledger })
    })
  return {
    ...granted,
    holdId,
    report: (usage) =>
      mutate((_ledger, hold) => {
        hold.observed ??= {}
        for (const field of DIMENSIONS)
          if (positive(usage[field]))
            hold.observed[field] = Math.max(hold.observed[field] ?? 0, usage[field]!)
      }),
    spent: async () => {
      const hold = (await db.executionRuns.get(granted.rootRunId))?.runLedger?.holds[holdId]
      const spent: RunBudgetAmountsV1 = {}
      for (const field of DIMENSIONS)
        spent[field] = (hold?.observed?.[field] ?? 0) + (hold?.charged?.[field] ?? 0)
      return spent
    },
    async finish(usage, confirmedStopped) {
      if (finished) return
      finished = true
      try {
        await mutate((ledger) => settle(ledger, holdId, confirmedStopped ? usage : undefined))
      } finally {
        releaseClaim()
      }
    },
  }
}

/** Charge one hold into `spent` and its ancestors' amounts, then remove it. */
function settle(ledger: RunLedgerV1, holdId: string, usage: RunBudgetAmountsV1 | undefined): void {
  const hold = ledger.holds[holdId]
  const children = Object.values(ledger.holds).filter((child) => child.parentHoldId === holdId)
  for (const field of DIMENSIONS) {
    if (hold.amounts[field] === undefined) continue
    const lent = children.reduce((sum, child) => sum + (child.amounts[field] ?? 0), 0)
    const charge = positive(usage?.[field])
      ? usage![field]!
      : Math.max(0, hold.amounts[field]! - lent)
    ledger.spent[field] += charge
    for (let id = hold.parentHoldId; id; id = ledger.holds[id].parentHoldId) {
      const ancestor = ledger.holds[id]
      if (ancestor.amounts[field] !== undefined)
        ancestor.amounts[field] = Math.max(0, ancestor.amounts[field]! - charge)
      ancestor.charged ??= {}
      ancestor.charged[field] = (ancestor.charged[field] ?? 0) + charge
    }
  }
  // A child that outlives its parent (a background dispatch) keeps its own
  // hold, now lent by the nearest surviving ancestor.
  for (const child of children) {
    if (hold.parentHoldId) child.parentHoldId = hold.parentHoldId
    else delete child.parentHoldId
  }
  delete ledger.holds[holdId]
}

function finiteCaps(caps: RunBudgetCaps): RunBudgetCaps {
  return {
    ...(isCap(caps.tokens) ? { tokens: caps.tokens } : {}),
    ...(isCap(caps.costUsd) ? { costUsd: caps.costUsd } : {}),
    ...(isCap(caps.deadlineMs) ? { deadlineMs: caps.deadlineMs } : {}),
  }
}

export interface DeclareRunBudgetOptions {
  /**
   * A person's explicit re-run (ADR-0243 D5): `runId` gets a ledger of its own
   * with a fresh deadline even inside another tree, so it draws on nothing the
   * original run had left. Without caps the ledger has no limits, which still
   * keeps its subtree off the original tree's.
   */
  fresh?: boolean
}

/**
 * Put `caps` on `runId` without taking a hold: a new ledger when no budget is
 * above it (or `fresh`), or a tighter own hold when it already reserved.
 * `false` when a budget is above it and it holds nothing, so the caps need a
 * hold of their own.
 */
export async function declareRootRunBudget(
  runId: string,
  caps: RunBudgetCaps,
  options: DeclareRunBudgetOptions = {}
): Promise<boolean> {
  const finite = finiteCaps(caps)
  const capped = Object.keys(finite).length > 0
  if (!capped && !options.fresh) return true
  const db = getDb()
  return db.transaction("rw", db.executionRuns, async () => {
    const run = await db.executionRuns.get(runId)
    if (!run) throw new RunBudgetError("hold_unavailable")
    if (run.runLedger) return true
    const found = await poolChain(db, runId)
    // Uncapped and fresh only matters inside a tree that has a budget.
    if (!capped && !found) return true
    if (found && !options.fresh) {
      const ledger = found.root.runLedger
      const own = Object.values(ledger.holds).find((hold) => hold.runId === runId)
      if (!own) return false
      for (const field of DIMENSIONS) {
        const cap = finite[field]
        if (cap !== undefined) own.amounts[field] = Math.min(own.amounts[field] ?? Infinity, cap)
      }
      if (finite.deadlineMs !== undefined)
        own.deadlineAt = Math.min(own.deadlineAt ?? Infinity, Date.now() + finite.deadlineMs)
      await db.executionRuns.update(found.root.id, { runLedger: ledger })
      return true
    }
    await db.executionRuns.update(runId, {
      runLedger: {
        schemaVersion: 1,
        limits: {
          ...(finite.tokens !== undefined ? { tokens: finite.tokens } : {}),
          ...(finite.costUsd !== undefined ? { costUsd: finite.costUsd } : {}),
        },
        ...(finite.deadlineMs !== undefined ? { deadlineAt: Date.now() + finite.deadlineMs } : {}),
        spent: { tokens: 0, costUsd: 0 },
        holds: {},
      },
    })
    return true
  })
}

/**
 * Declare a tree budget at `runId` for as long as the caller runs it. Inside
 * an existing tree where `runId` holds nothing, the caps become a hold that
 * bounds everything below `runId`. `release` settles that hold when the run
 * ends and says what the declared budget spent: the whole ledger's spend when
 * `runId` owns the ledger, otherwise what was charged under its hold.
 */
export async function declareRunBudget(
  runId: string,
  caps: RunBudgetCaps,
  options: DeclareRunBudgetOptions & { signal?: AbortSignal } = {}
): Promise<() => Promise<RunBudgetAmountsV1 | undefined>> {
  const db = getDb()
  if (await declareRootRunBudget(runId, caps, options))
    return async () => (await db.executionRuns.get(runId))?.runLedger?.spent
  const { signal } = options
  const hold = (await reserveRunBudget(runId, {
    caps: finiteCaps(caps),
    ...(signal ? { signal } : {}),
  }))!
  return async () => {
    const spent = await hold.spent()
    await hold.finish({ tokens: 0, costUsd: 0 }, true)
    return spent
  }
}

/**
 * Why a reservation for `runId` would be refused right now, for a caller that
 * must refuse before it records something it cannot take back. The
 * reservation itself stays the enforcement.
 */
export async function runBudgetRefusal(
  runId: string,
  options: Pick<ReserveRunBudgetOptions, "model" | "pricing"> = {}
): Promise<RunBudgetRefusal | undefined> {
  const db = getDb()
  return db.transaction("r", db.executionRuns, async () => {
    const found = await poolChain(db, runId)
    if (!found) return undefined
    const admitted = admission(found.root.runLedger, found.chain, options)
    return "refusal" in admitted ? admitted.refusal : undefined
  })
}

/** What is left for `runId`'s tree right now, or `undefined` without a budget. */
export async function readRunBudget(
  runId: string
): Promise<
  (RunBudgetAmountsV1 & { spent: RunLedgerV1["spent"]; deadlineAt?: number }) | undefined
> {
  const db = getDb()
  return db.transaction("r", db.executionRuns, async () => {
    const found = await poolChain(db, runId)
    if (!found) return undefined
    const ledger = found.root.runLedger
    return {
      ...available(ledger, parentHold(ledger, found.chain)),
      spent: ledger.spent,
      deadlineAt: holdDeadline(ledger, parentHold(ledger, found.chain)),
    }
  })
}

/**
 * Settle every hold no live process claims as an unconfirmed stop: its whole
 * remaining amount is charged. A host that cannot see claims skips this.
 */
export async function recoverRunBudgetHolds(): Promise<number> {
  const db = getDb()
  const roots = await db.executionRuns.filter((run) => Boolean(run.runLedger)).toArray()
  // Claims are read after the snapshot: a hold granted later is not in it.
  const claims = await heldChildRunOwnership()
  if (!claims) return 0
  let recovered = 0
  for (const root of roots) {
    await db.transaction("rw", db.executionRuns, async () => {
      const ledger = (await db.executionRuns.get(root.id))?.runLedger
      if (!ledger) return
      const orphans = Object.keys(root.runLedger!.holds).filter(
        (id) => ledger.holds[id] && !claims.has(`budget:${id}`)
      )
      for (const id of orphans) {
        settle(ledger, id, undefined)
        recovered += 1
      }
      if (orphans.length) await db.executionRuns.update(root.id, { runLedger: ledger })
    })
  }
  return recovered
}
