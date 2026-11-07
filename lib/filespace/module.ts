import { defineHostModule } from "@/lib/modules/define"

// A conversation's files (ADR-0222): its FileSpace, the links and live access
// shared from it, and the agent tools over both.
export default defineHostModule({
  id: "filespace",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["account-sync", "artifact", "collab", "data", "share", "terminal"],
  // The Files dock panel and its store, the FileSpace loader, paths, sources
  // and sensitive floor the share picker and the Files page read, the sharing
  // policy and its settings links, the snapshot and live-share doors, the
  // grants client the member host and the share card use, the link helpers
  // the composer and the dock use, and the tool names the result card reads.
  api: [
    "components/filespace/conversation-files-panel.tsx",
    "components/filespace/live-share-credentials.tsx",
    "hooks/filespace/use-conversation-filespace.ts",
    "lib/filespace/agent-tools.ts",
    "lib/filespace/copy-link.ts",
    "lib/filespace/grants-client.ts",
    "lib/filespace/link-params.ts",
    "lib/filespace/load.ts",
    "lib/filespace/open.ts",
    "lib/filespace/paths.ts",
    "lib/filespace/policy.ts",
    "lib/filespace/sensitive.ts",
    "lib/filespace/settings-links.ts",
    "lib/filespace/share-files.ts",
    "lib/filespace/sources.ts",
    "stores/filespace/filespace-panel-store.ts",
  ],
  // The agent's tools over the calling conversation's files (ADR-0222 §9).
  // Reading and taking access away are allowed; giving access away asks on
  // every call and is outbound. None of the runners honour a cancel signal.
  tools: {
    declare: {
      filespace_list: { consent: "allow", effect: "read", cancellable: false },
      filespace_revoke_share: { consent: "allow", effect: "write", cancellable: false },
      filespace_disable_webdav: { consent: "allow", effect: "write", cancellable: false },
      filespace_share: { consent: "per-call", effect: "outbound", cancellable: false },
      filespace_enable_webdav: { consent: "per-call", effect: "outbound", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
