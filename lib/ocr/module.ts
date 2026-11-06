import { defineHostModule } from "@/lib/modules/define"

// OCR (ADR-0024): reading text out of images and PDFs with built-in, native
// and plugin-contributed providers. It provides the `ocr` port
// (`types/modules/ports/ocr.ts`, ADR-0250 §14 M3, after `speech`): the
// agent's screen tools, connectors, captures, twin ingest, attachments,
// workflows, Discover and the plugin API ask for the port instead of
// importing `lib/ocr/`; the composer uses the module's `useOcr` hook. The
// pure engine and the provider registry stay the `@cognia/ocr` package both
// ends share.
export default defineHostModule({
  id: "ocr",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The settings section and its panels. The phone's OCR page is the Me
  // tab's, which shows the same persisted section.
  owns: ["components/settings/ocr/"],
  // The provider brand marks on the settings rail and detail pane.
  dependsOn: ["icons"],
  // What the phone's Me tab shows, and the composer's OCR action state.
  api: ["components/settings/ocr/ocr-section-persisted.tsx", "hooks/use-ocr.ts"],
  provides: [{ port: "ocr", load: () => import("./port") }],
  // Every built-in provider into the shared registry before a surface
  // extracts, on every host. The brain's adapter empties the registry on a
  // restart; a window's keeps it, so plugin providers outlive an account
  // change. The name stays the one brain operators restart it by.
  runtimes: [
    {
      name: "ocr-runtime",
      criticality: "optional",
      boot: "knowledge-agents",
      adapters: {
        brain: { module: "./runtime-brain", hosts: ["brain"] },
        desktop: "./runtime-renderer",
        mobile: "./runtime-renderer",
      },
    },
  ],
})
