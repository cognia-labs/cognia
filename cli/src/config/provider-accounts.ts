/**
 * Named provider accounts (`credentials.json`): which stored key a run uses.
 *
 * A provider entry's own `apiKey` / `authToken` are its `default` account and
 * `accounts` holds the named ones, so a person can keep a personal and a work
 * key for one provider id. The id stays the provider's, so the subscription
 * path, the model catalog, limits and usage go on treating them as one
 * provider.
 *
 * A run picks the account named by, from weakest to strongest, the user
 * config, the project config, `COGNIA_PROVIDER_ACCOUNT`, then
 * `--provider-account` (the last two for the active provider). With nothing
 * named it takes the `default` account, or the only one stored. A provider
 * with several named accounts and no `default` has no stored key until one is
 * chosen, rather than a guessed one.
 */

import {
  DEFAULT_PROVIDER_ACCOUNT,
  type CliConfigFile,
  type CredentialsFile,
  type ProviderAccountSelection,
  type ProviderAccountSource,
} from "./schema"

export type StoredProviderEntry = NonNullable<CredentialsFile["providers"]>[string]

export interface StoredAccount {
  name: string
  apiKey?: string
  authToken?: string
}

/** Every stored account of one provider, `default` first, then by name. */
export function storedAccounts(entry: StoredProviderEntry | undefined): StoredAccount[] {
  if (!entry) return []
  const accounts: StoredAccount[] = []
  if (entry.apiKey || entry.authToken) {
    accounts.push({
      name: DEFAULT_PROVIDER_ACCOUNT,
      ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
      ...(entry.authToken ? { authToken: entry.authToken } : {}),
    })
  }
  for (const name of Object.keys(entry.accounts ?? {}).sort()) {
    const secret = entry.accounts![name]!
    accounts.push({
      name,
      ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
      ...(secret.authToken ? { authToken: secret.authToken } : {}),
    })
  }
  return accounts
}

/** One config layer that may name accounts, in the order they apply. */
export interface AccountLayer {
  source: Extract<ProviderAccountSource, "flag" | "env" | "project-config" | "user-config">
  /** The file or variable, for messages. */
  origin: string
  layer: Pick<CliConfigFile, "providers" | "providerAccount"> | null | undefined
}

/**
 * The account each layer names, per provider, the strongest last.
 * `providerAccount` names the account of `activeProvider`.
 */
export function namedAccounts(
  layers: readonly AccountLayer[],
  activeProvider: string
): Map<string, ProviderAccountSelection> {
  const named = new Map<string, ProviderAccountSelection>()
  for (const { source, origin, layer } of layers) {
    for (const [id, entry] of Object.entries(layer?.providers ?? {})) {
      if (entry?.account) named.set(id, { name: entry.account, source, origin })
    }
    if (layer?.providerAccount)
      named.set(activeProvider, { name: layer.providerAccount, source, origin })
  }
  return named
}

export type AccountChoice =
  | { kind: "account"; account: StoredAccount; selection: ProviderAccountSelection }
  /** Nothing stored, or several named accounts and none chosen. */
  | { kind: "none"; ambiguous?: string[] }

/**
 * The stored account a provider's run uses. Throws when a layer names an
 * account that is not stored: a run must not quietly fall back to another
 * key than the one asked for.
 */
export function chooseAccount(
  providerId: string,
  entry: StoredProviderEntry | undefined,
  named: ProviderAccountSelection | undefined
): AccountChoice {
  const accounts = storedAccounts(entry)
  if (named) {
    const account = accounts.find((candidate) => candidate.name === named.name)
    if (!account) throw new Error(missingAccountMessage(providerId, named, accounts))
    return { kind: "account", account, selection: named }
  }
  const fallback = accounts.find((candidate) => candidate.name === DEFAULT_PROVIDER_ACCOUNT)
  if (fallback)
    return {
      kind: "account",
      account: fallback,
      selection: { name: fallback.name, source: "default" },
    }
  if (accounts.length === 1)
    return {
      kind: "account",
      account: accounts[0]!,
      selection: { name: accounts[0]!.name, source: "only" },
    }
  return accounts.length > 1
    ? { kind: "none", ambiguous: accounts.map((account) => account.name) }
    : { kind: "none" }
}

/** Where a named account choice came from, as one phrase. */
export function describeAccountChoice(selection: ProviderAccountSelection): string {
  switch (selection.source) {
    case "flag":
      return "chosen by --provider-account"
    case "env":
      return "chosen by COGNIA_PROVIDER_ACCOUNT"
    case "project-config":
      return `chosen in project config ${selection.origin ?? ""}`.trimEnd()
    case "user-config":
      return `chosen in ${selection.origin ?? "config.json"}`
    case "default":
      return "the default account"
    case "only":
      return "the only account stored"
  }
}

function missingAccountMessage(
  providerId: string,
  named: ProviderAccountSelection,
  accounts: StoredAccount[]
): string {
  const stored = accounts.length
    ? `stored: ${accounts.map((account) => account.name).join(", ")}`
    : "none is stored"
  return (
    `provider "${providerId}" has no stored account "${named.name}" (${describeAccountChoice(named)}; ${stored}). ` +
    `Save it with: cognia-agent auth login --provider ${providerId} --name ${named.name} --api-key <key>`
  )
}
