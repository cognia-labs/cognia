/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot, uninstallBot, updateBotInstallation } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetBotsForTesting,
  registerBot,
  unregisterBotsByPlugin,
} from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import { listDesktopEventTypes, watchDesktopEventTypes } from "./desktop-event-types"

const NOW = 1_700_000_000_000

function register(pluginId: string, triggers: PluginBotTriggerDef[]) {
  registerBot(
    "watch",
    {
      id: `${pluginId}:watch`,
      definition: {
        id: "watch",
        name: "Watcher",
        version: "1.0.0",
        executor: "handler",
        triggers,
      } as PluginBotDef,
      handler: jest.fn(),
    },
    { pluginId }
  )
}

function install(id: string, pluginId: string) {
  return installBot({
    id,
    definitionId: `${pluginId}:watch`,
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    now: NOW,
  })
}

/** Resolve once the watcher has reported a set with exactly these types. */
function nextReport(reports: Array<ReadonlySet<string>>, expected: string[]): Promise<void> {
  const want = JSON.stringify([...expected].sort())
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      const last = reports.at(-1)
      if (last && JSON.stringify([...last].sort()) === want) return resolve()
      if (Date.now() - started > 5_000)
        return reject(new Error(`no report of ${want}; last ${JSON.stringify(last && [...last])}`))
      setTimeout(poll, 10)
    }
    poll()
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
}, 15_000)

describe("listDesktopEventTypes", () => {
  it("collects the desktop types an enabled installation's armed triggers name", async () => {
    register("acme", [
      { id: "screen", kind: "event", source: "desktop", types: ["desktop.focus-changed"] },
      { id: "pet", kind: "event", source: "desktop", types: ["desktop.pet.levelUp"] },
      { id: "prs", kind: "event", source: "integration", types: ["pull_request.opened"] },
      {
        id: "off",
        kind: "event",
        source: "desktop",
        types: ["desktop.structure-changed"],
        enabledByDefault: false,
      },
    ])
    await install("boti_1", "acme")

    expect([...(await listDesktopEventTypes())].sort()).toEqual([
      "desktop.focus-changed",
      "desktop.pet.levelUp",
    ])
  })

  it("leaves out an installation whose plugin Bot is not registered", async () => {
    await install("boti_1", "acme")
    expect(await listDesktopEventTypes()).toEqual(new Set())
  })

  it("follows a per-installation trigger override", async () => {
    register("acme", [
      { id: "screen", kind: "event", source: "desktop", types: ["desktop.focus-changed"] },
    ])
    await install("boti_1", "acme")
    await updateBotInstallation("boti_1", { triggerOverrides: { screen: false } })
    expect(await listDesktopEventTypes()).toEqual(new Set())
  })
})

describe("watchDesktopEventTypes", () => {
  it("reports the current types, then each change, and stops when unsubscribed", async () => {
    const reports: Array<ReadonlySet<string>> = []
    const stop = watchDesktopEventTypes((types) => reports.push(types))
    await nextReport(reports, [])

    register("acme", [
      { id: "screen", kind: "event", source: "desktop", types: ["desktop.focus-changed"] },
    ])
    await install("boti_1", "acme")
    await nextReport(reports, ["desktop.focus-changed"])

    unregisterBotsByPlugin("acme")
    await nextReport(reports, [])

    register("acme", [
      { id: "screen", kind: "event", source: "desktop", types: ["desktop.focus-changed"] },
    ])
    await nextReport(reports, ["desktop.focus-changed"])

    await uninstallBot("boti_1")
    await nextReport(reports, [])

    stop()
    const count = reports.length
    register("other", [
      { id: "screen", kind: "event", source: "desktop", types: ["desktop.property-changed"] },
    ])
    await install("boti_2", "other")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reports).toHaveLength(count)
  })

  it("does not report an unchanged set again", async () => {
    register("acme", [
      { id: "screen", kind: "event", source: "desktop", types: ["desktop.focus-changed"] },
    ])
    await install("boti_1", "acme")
    const reports: Array<ReadonlySet<string>> = []
    const stop = watchDesktopEventTypes((types) => reports.push(types))
    await nextReport(reports, ["desktop.focus-changed"])

    // A write that changes nothing the watcher derives.
    await updateBotInstallation("boti_1", { config: { note: "x" } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reports).toHaveLength(1)
    stop()
  })
})
