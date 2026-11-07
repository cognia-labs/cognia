import { defineHostModule } from "@/lib/modules/define"

// Media: native video processing (the media binary transport, frame decode,
// ingest) and the agent's video generation tools (ADR-0205), which drive the
// video job engine in `lib/ai/media/`.
export default defineHostModule({
  id: "media",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["files-library", "images"],
  api: [
    "lib/ai/media/image-generation-sdk.ts",
    "lib/ai/media/video-generation-sdk.ts",
    "lib/ai/media/video-jobs/cancel.ts",
    "lib/ai/media/video-jobs/defaults.ts",
    "lib/ai/media/video-jobs/engine.ts",
    "lib/ai/media/video-jobs/host.ts",
    "lib/ai/media/video-jobs/renderer-host.ts",
    "lib/ai/media/video-jobs/retry.ts",
    "lib/ai/media/video-jobs/types.ts",
    "lib/media/agent-tools.ts",
    "lib/media/transport.ts",
  ],
  // The agent's video tools. `video_generate` asks: each call starts a paid
  // provider job that runs for minutes and cannot always be stopped (Veo and
  // xAI have no remote cancel), so the user sees the prompt before it is
  // spent; "allow always" or a user rule lifts it. `video_status` reads a job
  // of this conversation back and is allowed. Neither runner takes a cancel
  // signal.
  tools: {
    declare: {
      video_generate: { consent: "ask", effect: "write", cancellable: false },
      video_status: { consent: "allow", effect: "read", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
