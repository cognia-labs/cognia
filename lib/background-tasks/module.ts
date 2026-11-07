import { defineHostModule } from "@/lib/modules/define"

// Background work an agent leaves running (ADR-0249, ADR-0252 §9): the
// outbox of background subagent runs, shell jobs and monitors, their
// recovery, and the one delivery path that brings each result back into the
// conversation owed it as a framed turn, bounded by the wake limiter, the
// budget and the supervisor's claim.
export default defineHostModule({
  id: "background-tasks",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["chat", "device", "jobs"],
  // What other modules may import: the outbox record and the renderer run
  // registry, the job-end records and their consumer, the wake limiter, and
  // the delivery path a window's chat controller registers its lane with.
  api: [
    "lib/background-tasks/completion-delivery.ts",
    "lib/background-tasks/job-settlement-consumer.ts",
    "lib/background-tasks/job-settlement.ts",
    "lib/background-tasks/redispatch.ts",
    "lib/background-tasks/registry-core.ts",
    "lib/background-tasks/renderer-subagent-registry.ts",
    "lib/background-tasks/result-delivery.ts",
    "lib/background-tasks/wake-policy.ts",
  ],
  // Job ends reach a conversation the Host keeps through the Host's own
  // automated turn. A window consumes the same supervisor events in
  // `BackgroundTaskInitializer` and delivers through its chat controller's
  // lane; the supervisor's claim gives each end to one consumer.
  runtimes: [
    {
      name: "background-job-delivery",
      criticality: "optional",
      adapters: {
        brain: { module: "./runtime-brain", hosts: ["brain"] },
      },
      absent: {
        desktop:
          "A window's consumer runs in BackgroundTaskInitializer, behind the vault unlock and the reachable-supervisor check, and delivers through the chat controller that registers the window's lane; a module runtime here would start a second consumer with no lane of its own.",
        mobile:
          "The phone consumes over its paired Host in the same BackgroundTaskInitializer, delivering through its chat controller's lane.",
      },
    },
  ],
})
