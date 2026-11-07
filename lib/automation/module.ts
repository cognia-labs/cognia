import { defineHostModule } from "@/lib/modules/define"

// Desktop automation (ADR-0020, ADR-0233, ADR-0234): computer use, skill
// recording, managed and remote desktops, and the agent's managed desktop
// acceptance tools.
export default defineHostModule({
  id: "automation",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["companion", "remote-desktop", "skill-recorder"],
  // Screen OCR reads through the port and fails typed without a provider.
  requires: ["ocr?"],
  // Computer use's client, types and action schemas, the picture-in-picture
  // and stream views the chat mounts, the managed desktop clients the run
  // pages and acceptance card read, the screen OCR the workflow node uses,
  // and the agent's tools.
  api: [
    "hooks/automation/use-computer-use-pip-host.ts",
    "hooks/automation/use-sandbox-connections.ts",
    "hooks/automation/use-sandbox-desktop-stream.ts",
    "hooks/automation/use-session-sandbox-desktop.ts",
    "lib/automation/action-schemas.ts",
    "lib/automation/agent-tools.ts",
    "lib/automation/audit.ts",
    "lib/automation/client.ts",
    "lib/automation/computer-use-pip-resources.ts",
    "lib/automation/computer-use-pip.ts",
    "lib/automation/consent-durations.ts",
    "lib/automation/managed-desktop-acceptance-request.ts",
    "lib/automation/managed-desktop-client.ts",
    "lib/automation/managed-desktop-handoff-client.ts",
    "lib/automation/managed-desktop-results-client.ts",
    "lib/automation/model-frame.ts",
    "lib/automation/ocr-click.ts",
    "lib/automation/ocr-screen.ts",
    "lib/automation/picture-in-picture-layout.ts",
    "lib/automation/sandbox-target.ts",
    "lib/automation/types.ts",
  ],
  // Managed desktop acceptance (ADR-0233 A6). The evidence tools act only for
  // the child session the Host run was attached to (the Host rechecks the
  // delegation and session key), and are allowed: recording a checkpoint or
  // a verdict is what that session exists for, and completing never
  // approves, merges or completes the source task. The proposal reads
  // deliveries and a price and cannot spend, so it never asks. None of the
  // runners takes a cancel signal.
  tools: {
    declare: {
      acceptance_checkpoint: { consent: "allow", effect: "write", cancellable: false },
      acceptance_complete: { consent: "allow", effect: "write", cancellable: false },
      propose_acceptance: { consent: "allow", effect: "read", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
