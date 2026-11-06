import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
/** Only attempt metadata crosses IPC; the Rust Host keeps state and PKCE verifier. */
import { googleState, type GooglePendingAttempt } from "@/lib/auth-providers/google/state"

export async function getGoogleOAuthPending(
  now = Date.now(),
  credentialContext?: PersonalCredentialContext
): Promise<GooglePendingAttempt[]> {
  return (await googleState({ action: "snapshot" }, credentialContext)).pending.filter(
    (attempt) => attempt.expiresAt >= now
  )
}

export async function clearGoogleOAuthPending(attemptId: string): Promise<void> {
  await googleState({ action: "cancel", attemptId })
}
