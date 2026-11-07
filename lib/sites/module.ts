import { defineHostModule } from "@/lib/modules/define"

// Cognia Sites (ADR-0084): site projects, confined builds into immutable
// versions, publishing to Cloudflare, and the agent's tools over them.
export default defineHostModule({
  id: "sites",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: [
    "browser",
    "cli-bridge",
    "data",
    "editor",
    "logging",
    "scheduler",
    "share",
    "terminal",
  ],
  // The status badge the device pages show, the build, publish and Cloudflare
  // steps the workflow nodes drive, and the agent's tools.
  api: [
    "components/sites/site-status.tsx",
    "lib/sites/agent-tools.ts",
    "lib/sites/build-inputs.ts",
    "lib/sites/build-version.ts",
    "lib/sites/cloudflare/service.ts",
    "lib/sites/console-model.ts",
    "lib/sites/publish-version.ts",
  ],
  // The agent's Sites tools. Listing reads the user's own rows. Building
  // produces an immutable local version and publishes nothing, so it is
  // allowed: making it ask would turn "prepare a release" into a
  // click-through that trains the user to approve everything. Deploying puts
  // a URL anyone can load in front of the world with no undo, so it asks and
  // counts as outbound. None of the runners takes a cancel signal.
  tools: {
    declare: {
      list_sites: { consent: "allow", effect: "read", cancellable: false },
      build_site: { consent: "allow", effect: "write", cancellable: false },
      deploy_site: { consent: "ask", effect: "outbound", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
