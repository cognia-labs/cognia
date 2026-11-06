/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { actorKey } from "./board-model"
import {
  CollabActorRefusedError,
  collabActorRefusal,
  collabAssigneeKey,
  narrowCollabActor,
  readCollabSelf,
} from "./collab-actor"

const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbb"

describe("collabActorRefusal", () => {
  it("lets unassign and any nameable actor through", () => {
    expect(collabActorRefusal(null, null)).toBeNull()
    expect(collabActorRefusal({ kind: "agent", id: "char_7" }, null)).toBeNull()
    expect(collabActorRefusal({ kind: "human", id: BOB }, null)).toBeNull()
    expect(collabActorRefusal({ kind: "human", label: "Me" }, ADA)).toBeNull()
  })

  it("names why an actor cannot cross onto the plane", () => {
    expect(collabActorRefusal({ kind: "human", label: "Me" }, null)).toBe("anonymous-human")
    expect(collabActorRefusal({ kind: "human", label: "Me" }, undefined)).toBe("anonymous-human")
    expect(collabActorRefusal({ kind: "human", id: "local" }, ADA)).toBe("not-a-user-id")
    expect(collabActorRefusal({ kind: "team" }, ADA)).toBe("missing-id")
  })
})

describe("narrowCollabActor", () => {
  it("resolves Me to the signed-in person, labelled with their name, not 'Me'", () => {
    expect(
      narrowCollabActor({ kind: "human", label: "Me" }, { userId: ADA, label: "Ada" })
    ).toEqual({ kind: "human", id: ADA, label: "Ada" })
  })

  it("drops the local label when the person has no name to show", () => {
    expect(narrowCollabActor({ kind: "human", label: "Me" }, { userId: ADA })).toEqual({
      kind: "human",
      id: ADA,
    })
  })

  it("keeps an actor that already names someone, label included", () => {
    const self = { userId: ADA, label: "Ada" }
    expect(narrowCollabActor({ kind: "human", id: BOB, label: "Bob" }, self)).toEqual({
      kind: "human",
      id: BOB,
      label: "Bob",
    })
    expect(narrowCollabActor({ kind: "agent", id: "char_7", label: "Scout" }, null)).toEqual({
      kind: "agent",
      id: "char_7",
      label: "Scout",
    })
  })

  it("throws a typed refusal instead of inventing an id or dropping the actor", () => {
    let caught: unknown
    try {
      narrowCollabActor({ kind: "human", label: "Me" }, null)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CollabActorRefusedError)
    expect(caught).toMatchObject({ reason: "anonymous-human", name: "CollabActorRefusedError" })
    expect(() => narrowCollabActor({ kind: "agent" }, { userId: ADA })).toThrow(
      CollabActorRefusedError
    )
  })
})

describe("collabAssigneeKey", () => {
  it("selects Me for the signed-in person's own id", () => {
    expect(collabAssigneeKey({ kind: "human", id: ADA, label: "Ada" }, ADA, actorKey)).toBe(
      "human:self"
    )
  })

  it("keeps every other actor's own key", () => {
    expect(collabAssigneeKey({ kind: "human", id: BOB }, ADA, actorKey)).toBe(`human:${BOB}`)
    expect(collabAssigneeKey({ kind: "human", id: ADA }, null, actorKey)).toBe(`human:${ADA}`)
    expect(collabAssigneeKey({ kind: "agent", id: "char_7" }, ADA, actorKey)).toBe("agent:char_7")
    expect(collabAssigneeKey(undefined, ADA, actorKey)).toBeNull()
    expect(collabAssigneeKey(null, ADA, actorKey)).toBeNull()
  })
})

describe("readCollabSelf", () => {
  const binding = (over: Record<string, unknown> = {}) => ({
    localAccountId: "acct_1",
    userId: ADA,
    logtoSubject: "sub",
    logtoIssuer: "iss",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  it("reads the active profile's bound person", async () => {
    const get = jest.fn(async () => binding({ displayName: " Ada Lovelace ", email: "a@x.io" }))
    await expect(
      readCollabSelf({ registry: { get } as never, localAccountId: "acct_1" })
    ).resolves.toEqual({ userId: ADA, label: "Ada Lovelace" })
    expect(get).toHaveBeenCalledWith("acct_1")
  })

  it("falls back to the email, then to no label", async () => {
    await expect(
      readCollabSelf({
        registry: { get: async () => binding({ email: "ada@x.io" }) } as never,
        localAccountId: "acct_1",
      })
    ).resolves.toEqual({ userId: ADA, label: "ada@x.io" })
    await expect(
      readCollabSelf({ registry: { get: async () => binding() } as never, localAccountId: "a" })
    ).resolves.toEqual({ userId: ADA })
  })

  it("is null when nobody is signed in", async () => {
    await expect(
      readCollabSelf({ registry: { get: async () => null } as never, localAccountId: "acct_1" })
    ).resolves.toBeNull()
  })

  it("reads the account registry for the active profile when nothing is injected", async () => {
    const db = new CogniaAccountRegistryDB()
    await db.userBindings.put({
      localAccountId: getActiveAccountId(),
      userId: ADA,
      logtoSubject: "sub",
      logtoIssuer: "iss",
      displayName: "Ada",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    try {
      await expect(readCollabSelf()).resolves.toEqual({ userId: ADA, label: "Ada" })
    } finally {
      await db.userBindings.clear()
      db.close()
    }
    await expect(readCollabSelf()).resolves.toBeNull()
  })
})
