import { defineHostModule } from "@/lib/modules/define"

// The Bot control plane (ADR-0174): installed bots, their triggers, the
// durable delivery queue and the four executors (agent turn, workflow, squad,
// host step), the console, and the installation lifecycle a paired device
// drives through the host. The IM connectors and the workflow plane hand it
// their events through the `bot-dispatch` port, because the executors drive
// both of them (and squads): a direct import back would close a cycle.
export default defineHostModule({
  id: "bot",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // What the runtime, the executors and the console build on (G4 checks this
  // equals what they import).
  dependsOn: [
    "agent",
    "agent-runs",
    "connectors",
    "integrations",
    "outbound",
    "remote-host",
    "share",
    "squads",
    "usage",
    "workflow",
  ],
  // What other modules may import: the run controls, the integration event
  // source, a run's cost for the run detail, and the installation catalog and
  // lifecycle a Host migration moves bots with.
  api: [
    "lib/bot/console/catalog.ts",
    "lib/bot/control-writes/lifecycle-host.ts",
    "lib/bot/control-writes/lifecycle.ts",
    "lib/bot/installed-bot.ts",
    "lib/bot/runtime/run-cost.ts",
    "lib/bot/runtime/run.ts",
    "lib/bot/sources/integration-event.ts",
  ],
  provides: [
    // Inbound IM messages, desktop events and finished runs reach the bots,
    // and a cancelled conversation's deliveries are cancelled, through it.
    { port: "bot-dispatch", load: () => import("./ports/bot-dispatch") },
  ],
  // The companion pulls of the installations, the deliveries and the
  // definitions a paired device's `/bots` renders.
  syncHandlers: {
    tables: ["botInstallations", "botEventDeliveries", "botDefinitions"],
    load: () => import("./sync/sync-handlers"),
  },
})
