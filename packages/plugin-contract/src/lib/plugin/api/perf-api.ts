/**
 * The plugin contract's share of `lib/plugin/api/perf-api.ts`, which re-exports these.
 */
import type {
  PerfFrame,
  PerfSnapshot,
  SpanSnapshot,
  SystemDetails,
  TraceFile,
} from "../../perf/backend/types"

export interface PluginPerfAPI {
  /** Recent ring-buffer samples + current sampler state. */
  snapshot(): Promise<PerfSnapshot>
  /** Span hotspot rows (heaviest-first). */
  hotspots(): Promise<SpanSnapshot[]>
  /** Static host + build details (`null` on web). */
  systemDetails(): Promise<SystemDetails | null>
  /** Flight-recorder trace files on disk. */
  listTraces(): Promise<TraceFile[]>
  /** Subscribe to live `perf://frame` frames. Returns a disposer. */
  subscribe(handler: (frame: PerfFrame) => void): () => void
}
