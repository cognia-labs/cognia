// The `eval-benchmarks` capability port (ADR-0250 §14): turn another
// module's material into an ordinary, editable Eval dataset. The eval module
// (`lib/eval/module.ts`) provides it. The twin's persona tab asks for it
// instead of importing `lib/ai/eval/`, because eval already depends on the
// twin (it reads the twin's profile); with no provider the tab offers no
// benchmark button.

export interface EvalBenchmarkCreated {
  datasetId: string
  caseCount: number
}

export interface EvalBenchmarksPort {
  /** Build a dataset from a twin's current profile and return where it landed. */
  createTwinBenchmark(twinId: string): Promise<EvalBenchmarkCreated>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "eval-benchmarks": EvalBenchmarksPort
  }
}
