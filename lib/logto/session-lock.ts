/** Logto compatibility wrapper: preserve its database, store split and errors. */
import { withNamedLock, type NamedLockOptions } from "@/lib/locks/named-lock"

export class LogtoSessionLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LogtoSessionLockError"
  }
}

export type LogtoSessionLockOptions = Pick<NamedLockOptions, "locks" | "allowInProcess" | "waitMs">

export function withLogtoSessionLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  options: LogtoSessionLockOptions = {}
): Promise<T> {
  return withNamedLock(name, task, {
    ...options,
    inProcessFallback: "unserialized",
    isolateByName: false,
    databaseName: "cognia-logto-session-locks",
    stores: ["auth", "refresh"],
    storeName: name.startsWith("cognia-logto-refresh:") ? "refresh" : "auth",
    errorFactory: (message) => new LogtoSessionLockError(message),
  })
}
