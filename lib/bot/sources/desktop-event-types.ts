/**
 * Which `desktop.*` event types the installed Bots listen for.
 *
 * The desktop has two producers of Bot `desktop` events: the UI automation
 * runner (`desktop.<kind>`, `lib/workflow/runtime/desktop-event-trigger.ts`)
 * and the pet (`desktop.pet.<kind>`, `lib/pet/workflow-trigger.ts`). The pet
 * bus is in-process and cheap, so the pet hands over every lifecycle event it
 * projects; the UI automation watcher is an OS subscription, so the runner
 * subscribes it only for the types an enabled installation's armed trigger
 * names. This module answers that from the same resolution the router uses
 * (`resolveInstalledBot`, then `bindingsForInstalledBot`), so the subscription
 * and the routing cannot disagree about which Bots are listening.
 */

import Dexie from "dexie"
import { loggers } from "@cognia/logging"
import { getDb } from "@/lib/db/schema"
import { listBotInstallations } from "@/lib/db/bot-installations"
import { subscribeBots } from "@/lib/plugin/registries/bot-registry"
import { isRunnableBot, resolveInstalledBot } from "@/lib/bot/installed-bot"
import { bindingsForInstalledBot } from "@/lib/bot/events/dispatch"

const log = loggers.scheduler

/**
 * The `desktop` event types the enabled, runnable installations' armed
 * triggers name. An installation that does not resolve (its plugin is not
 * loaded) or cannot run listens for nothing, exactly as the router skips it.
 */
export async function listDesktopEventTypes(): Promise<Set<string>> {
  const types = new Set<string>()
  for (const installation of await listBotInstallations({ status: "enabled" })) {
    const resolved = await resolveInstalledBot(installation)
    if (!resolved || !isRunnableBot(resolved)) continue
    for (const { trigger } of bindingsForInstalledBot(resolved)) {
      if (trigger.kind !== "event" || trigger.source !== "desktop") continue
      for (const type of trigger.types) types.add(type)
    }
  }
  return types
}

/**
 * Call `listener` with the current types once they are known, then again
 * whenever they change: on any write to the installations or the local Bot
 * definitions, and on any plugin Bot registering or leaving. Recomputations
 * run one at a time and an unchanged set is not reported again. Returns the
 * unsubscribe.
 */
export function watchDesktopEventTypes(listener: (types: ReadonlySet<string>) => void): () => void {
  let active = true
  let reported: string | undefined
  let chain = Promise.resolve()

  const refresh = () => {
    chain = chain
      .then(async () => {
        if (!active) return
        const types = await listDesktopEventTypes()
        const key = JSON.stringify([...types].sort())
        if (!active || key === reported) return
        reported = key
        listener(types)
      })
      .catch((error: unknown) =>
        log.warn?.("bot desktop event types: recompute failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      )
  }

  // `Dexie.liveQuery` rather than a named import: see the note in
  // `lib/workflow/runtime/desktop-event-trigger.ts` on Dexie's CJS build.
  const subscription = Dexie.liveQuery(() =>
    Promise.all([getDb().botInstallations.toArray(), getDb().botDefinitions.toArray()])
  ).subscribe({
    next: refresh,
    error: (error: unknown) =>
      log.warn?.("bot desktop event types: liveQuery failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  })
  const unsubscribeBots = subscribeBots(refresh)
  refresh()

  return () => {
    active = false
    subscription.unsubscribe()
    unsubscribeBots()
  }
}
