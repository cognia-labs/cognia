/**
 * `cognia-agent auth <login|status|logout>` — manage provider credentials in
 * `~/.cognia/credentials.json` (0600). Keys never touch the desktop keyring.
 *
 * A run also takes keys from `config.json`, the project's
 * `./.cognia/config.json` and the environment (`../config/load`), and those
 * win over the stored file. `status` names the source a run would use, and
 * `logout` says which sources still supply a key after it removed the stored
 * one, because removing a credential that is still being used elsewhere is
 * not signing out.
 */

import os from "node:os"

import {
  describeProviderCredentials as defaultDescribe,
  fsReader,
  resolveHome,
  type ProviderCredentialSource,
} from "../config/load"
import {
  setCredential as defaultSet,
  deleteCredential as defaultDelete,
  listCredentialProviders as defaultList,
} from "../config/credentials"
import { DEFAULT_PROVIDER } from "../config/schema"
import { flagsMissingValues, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface AuthDeps {
  home?: string
  cwd?: string
  setCredential?: typeof defaultSet
  deleteCredential?: typeof defaultDelete
  listCredentialProviders?: typeof defaultList
  /** Every source of a provider secret (defaults to the real files and env). */
  describeCredentials?: () => Record<string, ProviderCredentialSource[]>
  out?: OutputSink
  /** Env source for the api key fallback. */
  env?: Record<string, string | undefined>
}

/** The Claude subscription token in the environment belongs to this provider only. */
const CLAUDE_TOKEN_PROVIDER = "anthropic"

function describeSource(source: ProviderCredentialSource): string {
  const what = source.kind === "authToken" ? "subscription token" : "api key"
  switch (source.layer) {
    case "env":
      return `${what} from env ${source.origin}`
    case "credentials":
      return `${what} stored in ${source.origin}`
    case "project-config":
      return `${what} in project config ${source.origin}`
    case "user-config":
      return `${what} in ${source.origin}`
  }
}

/** The source a run uses for each kind: the last one applied. */
function effective(sources: ProviderCredentialSource[]): ProviderCredentialSource[] {
  const byKind = new Map<string, ProviderCredentialSource>()
  for (const source of sources) byKind.set(source.kind, source)
  return [...byKind.values()]
}

export async function authCommand(args: ParsedArgs, deps: AuthDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const cwd = deps.cwd ?? process.cwd()
  const setCredential = deps.setCredential ?? defaultSet
  const deleteCredential = deps.deleteCredential ?? defaultDelete
  const listCredentialProviders = deps.listCredentialProviders ?? defaultList
  const describeCredentials =
    deps.describeCredentials ?? (() => defaultDescribe({ home, cwd, env, readFile: fsReader }))

  const missing = flagsMissingValues(args, ["provider", "api-key", "subscription", "auth-token"])
  if (missing.length > 0) {
    out.error(`auth: ${missing.map((name) => `--${name}`).join(", ")} needs a value`)
    return 2
  }
  const provider = stringFlag(args, "provider") ?? DEFAULT_PROVIDER

  switch (args.subcommand) {
    case "login": {
      // A subscription / OAuth token (Claude Pro/Max) authenticates the native
      // path without a metered API key. `--subscription`/`--auth-token` stores
      // it as the provider's `authToken`; `--api-key` stores a metered key.
      // A flag always decides: the environment fills in only when no flag
      // names a secret, so an ambient Claude token can never be saved in
      // place of the key that was passed.
      const flagToken = stringFlag(args, "subscription") ?? stringFlag(args, "auth-token")
      const flagKey = stringFlag(args, "api-key")
      if (flagToken && flagKey) {
        out.error("auth login: pass either --api-key or --subscription, not both")
        return 2
      }
      const envToken =
        provider === CLAUDE_TOKEN_PROVIDER ? env.CLAUDE_CODE_OAUTH_TOKEN?.trim() : undefined
      const envKey = env.COGNIA_LOGIN_API_KEY?.trim()
      if (!flagToken && !flagKey && envToken && envKey) {
        out.error(
          "auth login: both COGNIA_LOGIN_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; " +
            "pass --api-key or --subscription to say which to save"
        )
        return 2
      }
      const authToken = flagToken ?? (flagKey ? undefined : envToken)
      const apiKey = flagKey ?? (flagToken ? undefined : envKey)
      const secret = authToken ?? apiKey
      if (!secret) {
        out.error(
          `auth login: pass --api-key <key>, --subscription <token>, or set ` +
            `COGNIA_LOGIN_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN for "${CLAUDE_TOKEN_PROVIDER}") ` +
            `for provider "${provider}"`
        )
        return 2
      }
      const kind = authToken ? "authToken" : "apiKey"
      try {
        const path = setCredential(home, provider, secret, undefined, { kind })
        const label = kind === "authToken" ? "subscription token" : "api key"
        out.write(`Saved ${label} for "${provider}" to ${path}\n`)
        const winning = effective(describeCredentials()[provider] ?? []).filter(
          (source) => source.kind === kind && source.layer !== "credentials"
        )
        for (const source of winning)
          out.write(`  note: runs use the ${describeSource(source)} instead\n`)
        return 0
      } catch (err) {
        out.error(`auth login failed: ${(err as Error).message}`)
        return 1
      }
    }
    case "status": {
      const stored = listCredentialProviders(home)
      let sources: Record<string, ProviderCredentialSource[]>
      try {
        sources = describeCredentials()
      } catch (err) {
        out.error(`auth status: ${(err as Error).message}`)
        return 1
      }
      const providers = [...new Set([...stored, ...Object.keys(sources)])].sort()
      if (providers.length === 0) {
        out.write("No credentials. Run: cognia-agent auth login --provider <id> --api-key <key>\n")
        return 0
      }
      out.write(
        stored.length > 0
          ? `Stored credentials for: ${stored.join(", ")}\n`
          : "No stored credentials.\n"
      )
      out.write("Credentials a run uses:\n")
      for (const id of providers) {
        const used = effective(sources[id] ?? [])
        out.write(`  ${id}: ${used.length > 0 ? used.map(describeSource).join("; ") : "none"}\n`)
      }
      return 0
    }
    case "logout": {
      deleteCredential(home, provider)
      out.write(`Removed stored credentials for "${provider}"\n`)
      const remaining = (describeCredentials()[provider] ?? []).filter(
        (source) => source.layer !== "credentials"
      )
      if (remaining.length > 0) {
        out.write(
          `  still provided by: ${remaining.map(describeSource).join("; ")}\n` +
            "  unset or remove those to stop runs from using them\n"
        )
      }
      return 0
    }
    default:
      out.error("auth: expected a subcommand — login | status | logout")
      return 2
  }
}
