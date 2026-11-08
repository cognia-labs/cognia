/**
 * Test-only helpers for a plugin's own suite.
 *
 * A plugin whose tools persist through `ctx.dexie`, or whose behaviour depends
 * on a session the host owns, cannot be tested against a mock alone — the
 * interesting failures are the ones a fake table hides. But it also must not
 * reach for `getDb()`, which hands over the entire host schema. These are the
 * narrow seams in between.
 *
 * Nothing here is callable in production: `createDbTestFixture` binds Jest
 * lifecycle hooks, and `seedPlatformBoundSession` writes a row no running app
 * would write.
 */

import { getDb } from "@/lib/db/schema"
import { loadPort } from "@/lib/modules/ports"
import type { SeedRunningInboundJobInput } from "@/types/modules/ports/inbound-jobs"

export { createDbTestFixture, DB_TEST_TIMEOUT_MS } from "@/lib/db/test-fixture"
export type { DbTestFixture, DbTestFixtureOptions } from "@/lib/db/test-fixture"

export interface SeedPlatformBoundSessionInput {
  sessionId: string
  /** Omit to seed a session with NO platform binding — an editor-started run. */
  binding?: {
    adapterId: string
    conversationKey: string
    platform: string
  }
}

/**
 * Seed a session that looks like it arrived from an IM conversation.
 *
 * This is the precondition for testing anything that behaves differently for a
 * remote-originated run — approval scoping above all, since the actor scope is
 * derived from the binding's conversation.
 */
export async function seedPlatformBoundSession(
  input: SeedPlatformBoundSessionInput
): Promise<void> {
  const now = Date.now()
  await getDb().sessions.put({
    id: input.sessionId,
    title: "Test",
    createdAt: now,
    updatedAt: now,
    characterId: undefined as never,
    ...(input.binding
      ? {
          platformBinding: {
            adapterId: input.binding.adapterId,
            conversationKey: input.binding.conversationKey,
            platform: input.binding.platform,
            conversationRef: {
              platform: input.binding.platform,
              adapterId: input.binding.adapterId,
            },
          },
        }
      : {}),
  } as never)
}

/**
 * Every callback binding currently recorded — the read that pairs with
 * `recordCallbackBinding`. A plugin that renders an approval asserts on this
 * to prove the tap will come back to the right waitpoint with the right actor
 * scope.
 */
export async function listCallbackBindings(): Promise<
  Array<{ kind: string; [key: string]: unknown }>
> {
  return (await getDb().connectorCallbackBindings.toArray()) as unknown as Array<{
    kind: string
    [key: string]: unknown
  }>
}

export type { SeedRunningInboundJobInput }

/**
 * Seed a conversation with a message currently being processed.
 *
 * This is what makes an approval scoped: the running inbound job carries the
 * VERIFIED sender, and that sender becomes the only person (besides operators)
 * the callback guard will accept a tap from. A test that wants to prove its
 * approval is not tappable by the wrong person needs one of these. The job
 * store is the connectors', reached through the `inbound-jobs` port.
 */
export async function seedRunningInboundJob(
  input: SeedRunningInboundJobInput
): Promise<{ id: string }> {
  const inboundJobs = await loadPort("inbound-jobs")
  if (!inboundJobs) throw new Error("seedRunningInboundJob: no module provides inbound jobs")
  return inboundJobs.seedRunningJob(input)
}
