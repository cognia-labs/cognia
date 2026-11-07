/**
 * Squads (ADR-0129 x ADR-0140): the executors a conversation can be handed to.
 *
 * `teamsProvider` next door is a DIFFERENT Team. It reads the Dexie `teams`
 * table, a guild of Characters, and its action switches guild. A Squad is an
 * `AgentTeam` in the zustand store, and typing its name found nothing at all
 * before this: the only way ⌘K reached Squads was the `/squads` page itself,
 * which answers "show me the list", not "open the Review Crew".
 *
 * Workspace-scoped by `projectId`, which is `filter` rather than `demote`
 * because a Squad genuinely belongs to a workspace: `createTeam` stamps the
 * active project and the store purges per project. Out of scope it is noise,
 * not a preference. Reusable templates carry no `projectId`, and `byProjectId`
 * already treats an absent owner as "everywhere", which is what a template is.
 *
 * # Two rows per Squad, not one row with two actions
 *
 * A `GlobalSearchItem` carries exactly ONE `action`, so a control has to be its
 * own row. That is the reason this is shaped the way it is, rather than a
 * preference for verbose results.
 *
 * The control row is scored below its Squad's navigate row, so Enter on a match
 * still opens the Squad and never dispatches anything. The verb is the one the
 * Squad's current status admits (a running Squad offers Pause, never Start), so
 * the palette can never offer a control the console would refuse, and the row
 * says the verb and the Squad name together rather than relying on an icon.
 *
 * The control is the console's own: Start is a person's start attempt
 * (`createSquadStartAttempt`, which routes to a paired Host), Pause and Resume
 * go through `dispatchRunControl` against the Squad's newest run. Both are
 * imported lazily inside the callback on purpose. They pull the orchestration
 * graph, and the command palette opens on every ⌘K. A refusal says so in a
 * toast rather than vanishing with the closed palette.
 * `recents.ts#toStoredAction` returns null for a `callback`, so running one of
 * these never lands in the recents list either.
 */

import { AgentTeamIcon } from "@/components/mobile/mobile-spot-icon"
import { PauseIcon, PlayIcon } from "lucide-react"

import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

import { createListProvider } from "@/lib/global-search/providers/list-provider"
import { byProjectId } from "@/lib/global-search/workspace-scope"
import type {
  GlobalSearchItem,
  GlobalSearchProvider,
  GlobalSearchProviderInput,
} from "@/lib/global-search/types"

export const SQUADS_PROVIDER_ID = "builtin.squads"

/**
 * How far a control row sits below its own Squad's navigate row.
 *
 * Enough that opening the Squad always wins the first position for the same
 * needle, which keeps Enter safe: the default action for a Squad you searched
 * for is to look at it, never to spend tokens on it.
 */
const CONTROL_SCORE_FACTOR = 0.85

export type SquadControlVerb = "start" | "pause" | "resume"

/**
 * The one control a Squad in this state admits.
 *
 * Derived rather than offered as a fixed trio, so the palette can never present
 * a verb the run controls would refuse. `null` is unreachable across today's
 * union and is here so a widened status is silently controlless rather than
 * silently mis-labelled.
 */
export function squadControlVerb(status: AgentTeam["status"]): SquadControlVerb | null {
  switch (status) {
    case "planning":
    case "executing":
      return "pause"
    case "paused":
      return "resume"
    case "idle":
    case "completed":
    case "failed":
    case "cancelled":
      return "start"
    default:
      return null
  }
}

/** Manager verb per control. Same calls the fleet inspector makes. */
export interface SquadPaletteControlDeps {
  start?: (squadId: string) => Promise<{ started: boolean; reason?: string }>
  control?: (
    squadId: string,
    action: "pause" | "resume"
  ) => Promise<{ accepted: boolean; reason?: string }>
  notifyFailure?: (title: string) => void
}

async function defaultPaletteStart(squadId: string) {
  const [{ createSquadStartAttempt }, { detectHostProfile }] = await Promise.all([
    import("@/lib/execution/squad-start-dispatch"),
    import("@/lib/platform/capabilities"),
  ])
  return createSquadStartAttempt({ teamId: squadId, hostProfile: detectHostProfile() }).dispatch()
}

async function defaultPaletteControl(squadId: string, action: "pause" | "resume") {
  const [{ readSquadLatestRun }, { dispatchRunControl }, { detectHostProfile }] = await Promise.all(
    [
      import("@/hooks/squads/use-squad-latest-run"),
      import("@/lib/execution/run-control-dispatch"),
      import("@/lib/platform/capabilities"),
    ]
  )
  const { run } = await readSquadLatestRun(squadId)
  if (!run) return { accepted: false, reason: "run_not_found" }
  return dispatchRunControl({
    runId: run.id,
    action,
    surface: "command-palette",
    hostProfile: detectHostProfile(),
  })
}

async function defaultNotifyFailure(title: string) {
  const { toast } = await import("sonner")
  toast.error(title)
}

/**
 * Run the palette's control for one Squad. A refusal is toasted and thrown, so
 * the palette's action log records its reason too.
 */
export async function runSquadPaletteControl(
  verb: SquadControlVerb,
  squadId: string,
  t: GlobalSearchProviderInput["ctx"]["t"],
  deps: SquadPaletteControlDeps = {}
): Promise<void> {
  const refused =
    verb === "start"
      ? await (deps.start ?? defaultPaletteStart)(squadId).then((outcome) =>
          outcome.started ? undefined : (outcome.reason ?? "start_failed")
        )
      : await (deps.control ?? defaultPaletteControl)(squadId, verb).then((outcome) =>
          outcome.accepted ? undefined : (outcome.reason ?? "control_failed")
        )
  if (refused === undefined) return
  const title = t(`squads.fleet.control.failed.${verb}`)
  if (deps.notifyFailure) deps.notifyFailure(title)
  else void defaultNotifyFailure(title)
  throw new Error(`Squad ${verb} refused: ${refused}`)
}

/** The identity subset the palette needs, never the whole team row. */
export interface SquadSearchRow {
  id: string
  name: string
  description?: string
  status: AgentTeam["status"]
  memberCount: number
  projectId?: string
}

export interface SquadsProviderDeps {
  listSquads: () => readonly AgentTeam[]
  listTeammates: () => readonly AgentTeammate[]
}

export const DEFAULT_SQUADS_PROVIDER_DEPS: SquadsProviderDeps = {
  listSquads: () => Object.values(useAgentTeamStore.getState().teams),
  listTeammates: () => Object.values(useAgentTeamStore.getState().teammates),
}

export function loadSquadSearchRows(
  deps: SquadsProviderDeps = DEFAULT_SQUADS_PROVIDER_DEPS
): SquadSearchRow[] {
  // A synchronous store read can throw before the store has hydrated, and a
  // provider's `load` is cached, so a rejection would blank Squads from the
  // palette until the TTL expires rather than for one keystroke.
  let squads: readonly AgentTeam[]
  let teammates: readonly AgentTeammate[]
  try {
    squads = deps.listSquads()
    teammates = deps.listTeammates()
  } catch (error) {
    console.warn("global-search/squads: store read failed, listing none", error)
    return []
  }

  const memberCounts = new Map<string, number>()
  for (const member of teammates) {
    memberCounts.set(member.teamId, (memberCounts.get(member.teamId) ?? 0) + 1)
  }

  return squads.map((squad) => ({
    id: squad.id,
    name: squad.name,
    ...(squad.description ? { description: squad.description } : {}),
    status: squad.status,
    memberCount: memberCounts.get(squad.id) ?? 0,
    ...(squad.projectId ? { projectId: squad.projectId } : {}),
  }))
}

function createSquadsListProvider(deps: SquadsProviderDeps) {
  return createListProvider<SquadSearchRow>({
    id: SQUADS_PROVIDER_ID,
    kind: "squad",
    load: () => loadSquadSearchRows(deps),
    getTitle: (row) => row.name,
    getSecondary: (row) => row.description,
    // The id is searchable so a `/squads?id=` link pasted from a run row or a
    // notification resolves to the Squad it names.
    getKeywords: (row) => [row.id, row.status],
    workspaceScope: { mode: "filter", belongs: byProjectId((row) => row.projectId) },
    toItem: ({ row, match }, ctx) => ({
      id: `squad:${row.id}`,
      kind: "squad" as const,
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description,
      meta: ctx.t("squads.fleet.memberCount", { count: row.memberCount }),
      icon: { lucide: AgentTeamIcon },
      score: match.score,
      action: { type: "navigate", href: `/squads?id=${encodeURIComponent(row.id)}` },
    }),
  })
}

/**
 * The control row for one matched Squad, or nothing when its state admits no
 * verb. Built from the navigate row so the two always agree about which Squad
 * they name and how well it matched.
 */
function controlItem(
  navigate: GlobalSearchItem,
  row: SquadSearchRow,
  t: GlobalSearchProviderInput["ctx"]["t"]
): GlobalSearchItem | null {
  const verb = squadControlVerb(row.status)
  if (!verb) return null
  return {
    id: `squad:${row.id}:${verb}`,
    kind: "squad" as const,
    // Verb AND name. A row reading only "Start" beside another reading only
    // the Squad's name is two halves of one sentence in a list that scrolls.
    title: t(`squads.fleet.palette.${verb}`, { name: row.name }),
    meta: t("squads.fleet.palette.meta"),
    icon: { lucide: verb === "pause" ? PauseIcon : PlayIcon },
    score: navigate.score * CONTROL_SCORE_FACTOR,
    action: {
      type: "callback" as const,
      run: () => runSquadPaletteControl(verb, row.id, t),
    },
  }
}

export function createSquadsProvider(
  deps: SquadsProviderDeps = DEFAULT_SQUADS_PROVIDER_DEPS
): GlobalSearchProvider {
  const list = createSquadsListProvider(deps)
  return {
    ...list,
    async search(input: GlobalSearchProviderInput) {
      // Half the budget, because every match can produce two rows. Asking the
      // list for `limit` and then doubling would quietly overrun whatever the
      // caller sized its section for.
      const result = await list.search({
        ...input,
        limit: Math.max(1, Math.ceil(input.limit / 2)),
      })
      const byId = new Map(loadSquadSearchRows(deps).map((row) => [row.id, row]))
      const items = result.items.flatMap((item) => {
        const row = byId.get(item.id.slice("squad:".length))
        if (!row) return [item]
        const control = controlItem(item, row, input.ctx.t)
        return control ? [item, control] : [item]
      })
      // `total` and `truncated` still describe matching SQUADS, which is what a
      // "3 more" hint means to a reader. Counting control rows there would
      // report a number that answers no question anyone asked.
      return { ...result, items }
    },
  }
}

export const squadsProvider = createSquadsProvider()

/** What `lib/squads/module.ts` contributes to global search. */
export const searchProviders = [squadsProvider]
