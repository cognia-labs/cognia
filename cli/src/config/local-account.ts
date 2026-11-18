/**
 * Which local account a `cognia-agent` command acts for, and where that
 * account's sign-in lives under the cognia home.
 *
 * A local account is the CLI's LocalProfile (ADR-0149 §9): a data partition
 * on the Brain, and the one person signed in to it. `serve`, `account-sync`,
 * `logto` and `host login` all pick it the same way, so naming an account
 * always selects the partition and the person together. There is deliberately
 * no saved "current account": a Brain that restarts must open the partition
 * its Host told it to, never one a terminal switched to since.
 */

import path from "node:path"

import { stringFlag, type ParsedArgs } from "../cli/args"

/**
 * The account a Brain serves when nothing names one. Must stay in lockstep
 * with `HEADLESS_LOCAL_ACCOUNT_ID` in `crates/cognia-server/src/main.rs`.
 */
export const HEADLESS_LOCAL_ACCOUNT_ID = "local_acct_a"

export type LocalAccountSource = "flag" | "env" | "default"

export interface LocalAccount {
  id: string
  /** Where the id came from, so a command can say why it acts for this account. */
  source: LocalAccountSource
}

export type LocalAccountResolution =
  { ok: true; account: LocalAccount } | { ok: false; error: string }

/** Why `id` cannot name an account, or null when it can. */
export function invalidLocalAccountId(id: string): string | null {
  if (id.length === 0) return "an account id cannot be empty"
  if (id.trim() !== id) return `account id "${id}" has leading or trailing whitespace`
  if (id.length > 128) return "an account id is at most 128 characters"
  // Control characters would survive URI encoding into a file name nobody can type.
  if (/[\u0000-\u001f\u007f]/.test(id)) return "an account id cannot contain control characters"
  return null
}

/** `--account`, else `COGNIA_LOCAL_ACCOUNT_ID`, else {@link HEADLESS_LOCAL_ACCOUNT_ID}. */
export function resolveLocalAccount(
  args: ParsedArgs,
  env: Record<string, string | undefined>
): LocalAccountResolution {
  if (args.flags.account === true) {
    return { ok: false, error: "--account needs a value: the local account to act for" }
  }
  const flag = stringFlag(args, "account")
  const fromEnv = env.COGNIA_LOCAL_ACCOUNT_ID
  const account: LocalAccount =
    flag !== undefined
      ? { id: flag, source: "flag" }
      : fromEnv !== undefined && fromEnv !== ""
        ? { id: fromEnv, source: "env" }
        : { id: HEADLESS_LOCAL_ACCOUNT_ID, source: "default" }
  const invalid = invalidLocalAccountId(account.id)
  if (invalid) {
    const where = account.source === "env" ? "COGNIA_LOCAL_ACCOUNT_ID" : "--account"
    return { ok: false, error: `${where}: ${invalid}` }
  }
  return { ok: true, account }
}

/** How a command names where its account came from. */
export function describeLocalAccountSource(source: LocalAccountSource): string {
  switch (source) {
    case "flag":
      return "--account"
    case "env":
      return "COGNIA_LOCAL_ACCOUNT_ID"
    case "default":
      return "default"
  }
}

/** The directory holding every local account's sign-in. */
export function localAccountsRoot(home: string): string {
  return path.join(home, "accounts")
}

declare const accountSignInDirBrand: unique symbol

/**
 * One account's sign-in directory. Branded so a bare home directory can never
 * be passed where an account's is meant: the session store would otherwise
 * read and write the wrong person's files without any error.
 */
export type AccountSignInDir = string & { readonly [accountSignInDirBrand]: true }

/** `<home>/accounts/<encoded id>`; throws on an id {@link invalidLocalAccountId} refuses. */
export function accountSignInDir(home: string, accountId: string): AccountSignInDir {
  const invalid = invalidLocalAccountId(accountId)
  if (invalid) throw new Error(invalid)
  // `.` and `..` survive encodeURIComponent unchanged; spell them so they stay names.
  const encoded =
    accountId === "." ? "%2E" : accountId === ".." ? "%2E%2E" : encodeURIComponent(accountId)
  return path.join(localAccountsRoot(home), encoded) as AccountSignInDir
}

/** The account id a directory name under {@link localAccountsRoot} stands for, or null. */
export function accountIdFromDirName(name: string): string | null {
  let id: string
  try {
    id = decodeURIComponent(name)
  } catch {
    return null
  }
  if (invalidLocalAccountId(id)) return null
  // Only names this module writes count, so a stray directory is not an account.
  return path.basename(accountSignInDir("/", id)) === name ? id : null
}
