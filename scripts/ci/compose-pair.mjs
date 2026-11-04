#!/usr/bin/env node
/**
 * Print a fresh owner invitation from a Host running under Compose, for the
 * real Web ↔ Headless lanes (`dual-host.yml`, `compose-e2e.yml`).
 *
 *   node scripts/ci/compose-pair.mjs <service> <device-name> [pair flags...]
 *
 * Runs `cognia-server pair --json --direct` in the service. `pair` prints a
 * `cgnp4` invitation when the Host sits in a relay room and a `cgnp3` one when
 * it does not (ADR-0170, ADR-0224 A2); the Web client redeems either, and
 * `--direct` keeps a relay-less Host from refusing. A refusal fails with the
 * Host's own reason instead of an empty payload. Run it from the Compose
 * project directory. The invitation is an owner credential: callers mask it.
 */

import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const INVITATION = /^cgnp[34]\|[A-Za-z0-9_-]+$/

/** The invitation from `pair --json`'s stdout, or a thrown reason. */
export function invitationFromPairJson(stdout) {
  const line = String(stdout)
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .at(-1)
  if (!line) throw new Error("pair printed no JSON answer")
  const answer = JSON.parse(line)
  if (answer.status === "refused")
    throw new Error(`pair refused (${answer.cause}): ${answer.message}`)
  if (answer.status !== "issued" || !INVITATION.test(answer.invitation ?? ""))
    throw new Error(`pair answered without a usable invitation (status ${answer.status})`)
  return answer.invitation
}

export function pairArguments(service, deviceName, extra = []) {
  if (!service || !deviceName)
    throw new Error("usage: compose-pair.mjs <service> <device-name> [pair flags...]")
  return [
    "compose",
    "exec",
    "-T",
    service,
    "cognia-server",
    "pair",
    "--json",
    "--direct",
    "--device-name",
    deviceName,
    ...extra,
  ]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [service, deviceName, ...extra] = process.argv.slice(2)
    const stdout = execFileSync("docker", pairArguments(service, deviceName, extra), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    })
    process.stdout.write(invitationFromPairJson(stdout) + "\n")
  } catch (error) {
    console.error(`[compose-pair] ${error.message}`)
    process.exitCode = 1
  }
}
