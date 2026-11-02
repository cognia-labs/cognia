/** Only attempt metadata crosses IPC; the Rust Host keeps state and PKCE verifier. */
import { googleState, type GooglePendingAttempt } from "./state"

export async function getGoogleOAuthPending(now = Date.now()): Promise<GooglePendingAttempt[]> {
  return (await googleState({ action: "snapshot" })).pending.filter(
    (attempt) => attempt.expiresAt >= now
  )
}

export async function clearGoogleOAuthPending(attemptId: string): Promise<void> {
  await googleState({ action: "cancel", attemptId })
}
