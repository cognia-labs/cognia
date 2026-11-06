// Typed topics: the kernel's seam for an inverted dependency (ADR-0250 §14).
//
// When a shell or another module needs something a module knows, it must not
// import that module. The module publishes it instead, on a topic it declares
// in `types/<id>/events.ts`, and the reader subscribes by the topic's id. The
// reader then imports only `types/<id>/**`, never the module's code, so the
// dependency points from the publisher to this file and nowhere else.
//
// A topic keeps its latest value. Most of what an inverted reader needs is
// state (how the pet is, whether a feature is on), not a one-off event, and a
// reader that mounts after the last publish still needs the current value. A
// topic nobody has published yet reads as `undefined`, which every reader
// treats as "the publisher is not running here".
//
// Declaring a topic is a type, not a value: the publisher augments `TopicMap`
//
//   declare module "@/lib/runtime/topics" {
//     interface TopicMap { "pet.status": PetStatusTopic }
//   }
//
// so the id and the payload are checked at both ends without the reader
// importing a runtime constant from the publisher.
//
// One store per JavaScript realm: every window keeps its own, and a window
// reads what was published in it. Pure and dependency-free, so every layer may
// publish and subscribe; it lives in the foundation layer for that reason.

/** Every topic's id and payload. Each publisher adds its own entries. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by publishers
export interface TopicMap {}

export type TopicId = keyof TopicMap

type Listener<T> = (value: T | undefined) => void

interface Slot {
  value: unknown
  published: boolean
  listeners: Set<Listener<unknown>>
}

const slots = new Map<string, Slot>()

function slot(id: string): Slot {
  let entry = slots.get(id)
  if (!entry) {
    entry = { value: undefined, published: false, listeners: new Set() }
    slots.set(id, entry)
  }
  return entry
}

function notify(entry: Slot): void {
  // A listener that unsubscribes (or subscribes another) while being told
  // must not change who hears this publish.
  for (const listener of [...entry.listeners]) {
    try {
      listener(entry.value)
    } catch (error) {
      console.error("[topics] a listener threw", error)
    }
  }
}

/** Publish a topic's new value. Listeners hear it synchronously. */
export function publishTopic<K extends TopicId>(id: K, value: TopicMap[K]): void {
  const entry = slot(id)
  if (entry.published && Object.is(entry.value, value)) return
  entry.value = value
  entry.published = true
  notify(entry)
}

/**
 * Withdraw a topic: its publisher stopped. Readers see `undefined` again, as
 * before the first publish.
 */
export function clearTopic(id: TopicId): void {
  const entry = slots.get(id)
  if (!entry || !entry.published) return
  entry.value = undefined
  entry.published = false
  notify(entry)
}

/** The topic's latest value, or `undefined` while nobody publishes it. */
export function readTopic<K extends TopicId>(id: K): TopicMap[K] | undefined {
  return slots.get(id)?.value as TopicMap[K] | undefined
}

/**
 * Hear every later value of a topic (not the current one: read it with
 * `readTopic`). Returns the unsubscribe function.
 */
export function subscribeTopic<K extends TopicId>(
  id: K,
  listener: (value: TopicMap[K] | undefined) => void
): () => void {
  const entry = slot(id)
  const wrapped = listener as Listener<unknown>
  entry.listeners.add(wrapped)
  return () => {
    entry.listeners.delete(wrapped)
  }
}

/** Test helper: forget every topic and listener. */
export function __resetTopicsForTesting(): void {
  slots.clear()
}
