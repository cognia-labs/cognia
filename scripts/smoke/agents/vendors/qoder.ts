/**
 * Qoder CLI: its custom state root (QODER_CONFIG_DIR) must be provisioned by
 * the sandbox, its CLI login methods advertised, and a shell
 * QODER_PERSONAL_ACCESS_TOKEN must never leak into the probe.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { VendorSmoke } from "../generic"
import { check, overrideEnv, type SmokeContext } from "../kit"

function configRoot(context: SmokeContext): string {
  return context.live
    ? path.join(os.homedir(), ".qoder")
    : path.join(context.scratch, "qoder-state")
}

function qoderEnv(context: SmokeContext): Record<string, string> {
  // The probe must not inherit a credential from the shell's Qoder environment.
  overrideEnv(context, { QODER_PERSONAL_ACCESS_TOKEN: "" })
  return { QODER_CONFIG_DIR: configRoot(context), QODER_PERSONAL_ACCESS_TOKEN: "" }
}

export const qoder: VendorSmoke = {
  runtimeId: "qoder",
  agentName: "qoder-cli",
  isolateHome: false,
  isolatedEnv: qoderEnv,
  liveEnv: qoderEnv,
  prepareSession: (adapter, sessionId) => adapter.setSessionMode(sessionId, "default"),
  async run(context, { adapter, sessionId }) {
    check(
      adapter
        .getAuthMethods()
        .some((method) => ["qodercli-login", "qodercli-login-terminal"].includes(method.id)),
      `No Qoder login method advertised: ${JSON.stringify(adapter.getAuthMethods())}`
    )
    check(
      fs.existsSync(configRoot(context)),
      "The sandbox did not provision Qoder's custom state root"
    )
    if (!context.live) check(!sessionId, "Qoder opened a session without authentication")
    return { customStateRoot: true, loginMethods: true }
  },
}
