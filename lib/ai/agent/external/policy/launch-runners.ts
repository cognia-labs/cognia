/**
 * Launch descriptors for the package runners the host itself admits
 * (`npxPackageAllowlist` in the security policy). A runner is not an engine:
 * its descriptor covers only the runner's own state, and the package it runs
 * matches its own descriptor by launch target.
 */

import type { EngineLaunchDescriptor } from "@cognia/agent-contracts/engine-launch"

export const RUNNER_LAUNCH_DESCRIPTORS: readonly EngineLaunchDescriptor[] = [
  { id: "npx", match: { kind: "base", values: ["npx"] }, stateRoots: [".npm"] },
]
