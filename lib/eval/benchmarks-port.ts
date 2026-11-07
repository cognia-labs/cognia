// The eval module's implementation of the `eval-benchmarks` port
// (`types/modules/ports/eval-benchmarks.ts`, ADR-0250 §14).

import type { EvalBenchmarksPort } from "@/types/modules/ports/eval-benchmarks"
import { createTwinBenchmark } from "@/lib/ai/eval/twin-benchmark"

export const port: EvalBenchmarksPort = {
  createTwinBenchmark: (twinId) => createTwinBenchmark(twinId),
}
