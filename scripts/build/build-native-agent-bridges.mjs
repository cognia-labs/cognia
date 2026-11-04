import path from "node:path"
import { fileURLToPath } from "node:url"
import { stageNativeAgentBridges } from "./lib/stage-native-agent-bridges.mjs"
import { stageDshOpsRuntime } from "./stage-dsh-ops-runtime.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
// Browser-only development may omit Rust; native package builds remain mandatory.
stageDshOpsRuntime({ root, optional: true })
const result = stageNativeAgentBridges({ root, sidecarOutDir: path.join(root, "sidecar"), pin: process.argv.includes("--pin") })
console.log(`Staged ${Object.keys(result.manifest.bridges).length} verified native bridges and ${Object.keys(result.manifest.dependencyFiles).length} dependency files`)
