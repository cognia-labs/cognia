import { defineHostModule } from "@/lib/modules/define"

// The unified template platform (ADR-0100, ADR-0164): one catalog of
// portable definitions (squads, workflows, subagents, modes, characters,
// skills and the catalog-only domains), the service that preflights and
// instantiates them, packages, and the agent's tools over the catalog and
// the user's saved chat templates.
export default defineHostModule({
  id: "templates",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["a2ui", "data", "document-templates", "share", "workflow"],
  // The Squad side of the platform (`types/modules/ports/squad-templates.ts`):
  // squads builds on templates, so the agent-team store is reached through
  // the port. Without it squad templates cannot be instantiated.
  requires: ["squad-templates?"],
  // What other modules may import: the dialogs and instance card other
  // screens embed, the catalog, contracts, domain ports, repository, runtime
  // and service, packages, publisher identity (cogpacks sign with it), shared
  // definitions and drafts, and what the Squad template tools share with
  // these.
  api: [
    "components/templates/publish-confirm-dialog.tsx",
    "components/templates/template-export-dialog.tsx",
    "components/templates/template-instance-card.tsx",
    "components/templates/template-update-dialog.tsx",
    "lib/templates/adapters.ts",
    "lib/templates/agent-tool-kit.ts",
    "lib/templates/contracts.ts",
    "lib/templates/download-package.ts",
    "lib/templates/draft-id.ts",
    "lib/templates/feature-flags.ts",
    "lib/templates/install-shared-definition.ts",
    "lib/templates/legacy-sources.ts",
    "lib/templates/package-manifest.ts",
    "lib/templates/package.ts",
    "lib/templates/publisher-identity.ts",
    "lib/templates/runtime.ts",
    "lib/templates/service.ts",
  ],
  // The agent's template tools, opted in by `selfInvokeTools.templates`.
  // Reads are free. Instantiating asks the plugin consent broker inside the
  // runner (the same prompt `ctx.templates` answers to), so the tier allows
  // it rather than asking twice. None of the runners takes a cancel signal.
  tools: {
    declare: {
      template_list: { consent: "allow", effect: "read", cancellable: false },
      template_get: { consent: "allow", effect: "read", cancellable: false },
      template_instantiate: { consent: "allow", effect: "write", cancellable: false },
      chat_template_list: { consent: "allow", effect: "read", cancellable: false },
      chat_template_get: { consent: "allow", effect: "read", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
