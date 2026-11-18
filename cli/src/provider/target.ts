/**
 * Who answers `cognia-agent provider …` (ADR-0163 §8).
 *
 * The provider verbs follow the same Host selection as every other command
 * (`host/resolve.ts`): `--host` / `--profile`, `--endpoint`, `COGNIA_PROFILE`,
 * `COGNIA_ENDPOINT` / `COGNIA_SERVER_URL`, then the active host of the
 * project and user `hosts.json` (`host use`). `--local` answers from this
 * machine whatever is selected, and with nothing selected this machine
 * answers.
 *
 * Selecting a Host does not turn every verb into a Host call. Only `balance`
 * and `probe` have Host commands; the other verbs read this machine's
 * configuration, credentials and database, and say that they did. A Host
 * named explicitly that does not exist is a mistake to report, never a reason
 * to answer from somewhere else.
 *
 * No management credential leaves this process: the Host's own transport
 * carries its token or device key, and nothing is forwarded to an agent.
 */

import type { CliFailure } from "../cli/errors"
import { resolveHost, type HostResolution, type ResolvedHost } from "../host/resolve"

/** Who supplied a report's data. */
export interface ProviderAnswerSource {
  plane: "local" | "host"
  label: string
}

export const LOCAL_ANSWER: ProviderAnswerSource = {
  plane: "local",
  label: "this machine (its own configuration and credentials)",
}

export type ProviderTarget =
  | {
      kind: "local"
      /** `--local`, or no Host is selected anywhere. */
      why: "flag" | "nothing-selected"
    }
  | { kind: "host"; host: ResolvedHost; label: string }

export interface ProviderTargetInput {
  /** `--local`. */
  local?: boolean
  /** `--endpoint`. */
  endpoint?: string
  /** `--host` or `--profile`. */
  profile?: string
  /** `--tenant`. */
  tenantId?: string
  env: Record<string, string | undefined>
  home: string
  cwd: string
  resolve?: typeof resolveHost
}

export type ProviderTargetResult =
  { ok: true; target: ProviderTarget } | { ok: false; failure: CliFailure }

/** `Host "home" (https://…)`, or `Host at https://…` for an unnamed endpoint. */
export function hostTargetLabel(host: ResolvedHost): string {
  return host.name
    ? `Host "${host.name}" (${host.endpoint.value})`
    : `Host at ${host.endpoint.value}`
}

/** The answer source for a report a Host's data fills. */
export function hostAnswer(
  target: Extract<ProviderTarget, { kind: "host" }>
): ProviderAnswerSource {
  return { plane: "host", label: target.label }
}

function namedHostFailure(resolution: HostResolution): CliFailure | undefined {
  const missing = resolution.skipped.find((leg) => leg.leg === "named host")
  if (!missing) return undefined
  return {
    error: missing.reason,
    cause: "invalid-request",
    fix: [
      "pass --host with one of the saved names, or --local to answer from this machine",
      "cognia-agent host add <name> --endpoint <url>",
    ],
    inspect: ["cognia-agent host list"],
  }
}

export function selectProviderTarget(input: ProviderTargetInput): ProviderTargetResult {
  const explicit = input.profile !== undefined || input.endpoint !== undefined
  if (input.local) {
    if (explicit) {
      return {
        ok: false,
        failure: {
          error: "--local answers from this machine, so it cannot be combined with a Host",
          cause: "invalid-request",
          fix: ["drop --local to ask the Host", "or drop --host / --endpoint"],
        },
      }
    }
    return { ok: true, target: { kind: "local", why: "flag" } }
  }
  const resolution = (input.resolve ?? resolveHost)({
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    env: input.env,
    home: input.home,
    cwd: input.cwd,
  })
  if (resolution.conflict) {
    return {
      ok: false,
      failure: {
        error: resolution.conflict.error,
        cause: "invalid-request",
        fix: resolution.conflict.fix,
        inspect: ["cognia-agent host show", "cognia-agent host list"],
      },
    }
  }
  if (resolution.host) {
    return {
      ok: true,
      target: { kind: "host", host: resolution.host, label: hostTargetLabel(resolution.host) },
    }
  }
  const missing = namedHostFailure(resolution)
  if (missing) return { ok: false, failure: missing }
  return { ok: true, target: { kind: "local", why: "nothing-selected" } }
}

/**
 * The line a locally answered verb adds when a Host is selected, so a report
 * never reads as the Host's when it is this machine's.
 */
export function localWhileHostSelected(target: ProviderTarget, reason: string): string | undefined {
  if (target.kind !== "host") return undefined
  return `${target.label} is selected, but ${reason}, so this machine answered`
}
