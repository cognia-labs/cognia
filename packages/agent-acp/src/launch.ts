/**
 * The launch descriptors the ACP package owns (ADR-0217): every vendor
 * profile's, plus the ACP engines that need no protocol deviation of their own
 * but still write state the sandbox must scope. The host's generator writes
 * them into `protocol/external-agent-launch.json`.
 */

import type { EngineLaunchDescriptor } from "@cognia/agent-contracts/engine-launch"
import { ACP_VENDOR_PROFILES } from "./vendor-profiles"

/** Plain ACP engines: no vendor profile, no documented home variable. */
const PLAIN_ACP_ENGINE_LAUNCH: readonly EngineLaunchDescriptor[] = [
  { id: "gemini", match: { kind: "contains", values: ["gemini"] }, stateRoots: [".gemini"] },
  {
    id: "qwen",
    match: { kind: "contains", values: ["qwen"] },
    stateRoots: [".qwen"],
    isolation: {
      env: { QWEN_HOME: "qwen", QWEN_RUNTIME_DIR: "qwen-runtime" },
      denyReadable: [".qwen"],
    },
  },
  { id: "kiro", match: { kind: "contains", values: ["kiro"] }, stateRoots: [".kiro"] },
  {
    id: "factory-droid",
    match: { kind: "contains", values: ["droid", "factory"] },
    stateRoots: [".factory"],
  },
  { id: "cursor", match: { kind: "contains", values: ["cursor"] }, stateRoots: [".cursor"] },
]

export const ACP_ENGINE_LAUNCH: readonly EngineLaunchDescriptor[] = [
  ...ACP_VENDOR_PROFILES.flatMap((profile) => (profile.launch ? [profile.launch] : [])),
  ...PLAIN_ACP_ENGINE_LAUNCH,
]
