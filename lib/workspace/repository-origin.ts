/**
 * One repository's identity, from however its remote is spelled (ADR-0147,
 * 2026-11-08 amendment).
 *
 * A consumer repository declares what it depends on by remote identity
 * (`"dependsOn": [{ "repository": "github.com/org/sdk" }]`), and a workspace's
 * roots are matched against it by the remote their checkout reads. The same
 * repository arrives as `git@github.com:Org/SDK.git`, `ssh://git@github.com/
 * org/sdk`, `https://user@github.com/org/sdk.git/` or the bare form above, so
 * both sides are reduced to one canonical `host/path` before they are
 * compared:
 *
 *  - the scheme, user info, port and a trailing `.git` or `/` are dropped (the
 *    ssh and https endpoints of one host differ only in those);
 *  - host and path are lower-cased (GitHub, GitLab and Gitea resolve names
 *    case-insensitively);
 *  - the whole path is kept, so a GitLab subgroup (`group/sub/repo`) and a
 *    GitHub Enterprise host are identities of their own.
 *
 * A local path, a `file://` URL or anything without a host and a path has no
 * remote identity and parses to null: matching against it would be a guess.
 * Two different repositories never share an identity; one repository served
 * from two hosts (a mirror) has two, and a consumer names the one it uses.
 */

export interface RepositoryOrigin {
  /** Lower-cased host, without user info or port. */
  host: string
  /** Lower-cased path segments after the host, without `.git`. */
  path: string
}

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/

/** The canonical identity of `remote`, or null when it has none. */
export function parseOrigin(remote: string | null | undefined): RepositoryOrigin | null {
  const value = remote?.trim()
  if (!value) return null
  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.protocol === "file:") return null
    host = url.hostname
    path = decodeURIComponent(url.pathname)
  } else {
    const scp = SCP_LIKE.exec(value)
    if (scp && !/^[a-z]$/i.test(scp[1]!)) {
      // `git@host:org/repo`. A single letter before the colon is a Windows
      // drive (`C:\repo`), not a host.
      host = scp[1]!
      path = scp[2]!
    } else {
      // The declaration form, `host/org/repo`, with no scheme.
      const slash = value.indexOf("/")
      if (slash <= 0) return null
      host = value.slice(0, slash)
      path = value.slice(slash + 1)
      // A host has a dot or is `localhost`; `org/repo` alone names nothing.
      if (!host.includes(".") && host.toLowerCase() !== "localhost") return null
    }
  }
  host = host.toLowerCase().replace(/\.$/, "")
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length > 0) {
    const last = segments.length - 1
    segments[last] = segments[last]!.replace(/\.git$/i, "")
    if (!segments[last]) segments.pop()
  }
  if (!host || segments.length < 2) return null
  if (segments.some((segment) => segment === "." || segment === "..")) return null
  return { host, path: segments.join("/").toLowerCase() }
}

/** `host/path`, the form a declaration names a repository by. */
export function originKey(origin: RepositoryOrigin): string {
  return `${origin.host}/${origin.path}`
}

/** Whether two remotes name the same repository. False when either has no identity. */
export function sameRepository(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = parseOrigin(a)
  const right = parseOrigin(b)
  return Boolean(left && right && originKey(left) === originKey(right))
}
