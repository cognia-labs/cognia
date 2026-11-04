import * as catalog from "../config/install-catalog"
import {
  createRuntimeHost as create,
  type RuntimeHostDependencies as CoreDependencies,
} from "@cognia/agent-runtime-kit/lifecycle/runtime-host"
export type { InstallOptions } from "@cognia/agent-runtime-kit/lifecycle/runtime-host"
export type RuntimeHostDependencies = Omit<CoreDependencies, "catalog">
export function createRuntimeHost(deps: RuntimeHostDependencies) {
  return create({ ...deps, catalog })
}
