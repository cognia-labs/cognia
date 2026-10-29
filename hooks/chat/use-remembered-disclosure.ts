"use client"

/**
 * React bindings for `lib/chat/disclosure-memory`.
 *
 * Both hooks answer "what did the reader explicitly choose", never "is it
 * open": the caller folds the answer over its own live default
 * (`remembered ?? defaultOpen`), so an untouched disclosure keeps following
 * the tool's state while a chosen one stays where the reader put it — across
 * the remounts the transcript causes on its own.
 *
 * A null key falls back to component-local state, for hosts that render a
 * disclosure outside any conversation (stories, a standalone preview).
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"

import {
  readDisclosure,
  subscribeDisclosure,
  writeDisclosure,
  writeDisclosures,
} from "@/lib/chat/disclosure-memory"

const noopSubscribe = () => () => undefined
const readNothing = () => undefined

/** The explicit choice for one disclosure, and a setter that records one. */
export function useRememberedDisclosure(
  key: string | null
): readonly [boolean | undefined, (open: boolean) => void] {
  const [local, setLocal] = useState<boolean | undefined>(undefined)
  const subscribe = useCallback(
    (listener: () => void) => (key ? subscribeDisclosure(key, listener) : noopSubscribe()),
    [key]
  )
  const read = useCallback(() => (key ? readDisclosure(key) : readNothing()), [key])
  const remembered = useSyncExternalStore(subscribe, read, readNothing)
  const set = useCallback(
    (open: boolean) => {
      if (key) writeDisclosure(key, open)
      else setLocal(open)
    },
    [key]
  )
  return [key ? remembered : local, set] as const
}

/**
 * The explicit choices for a list of disclosures — a tool group's rows. The
 * returned map only holds keys with a choice. Its identity changes only when a
 * choice for one of `keys` changes, so memoized rows keep their props.
 */
export function useRememberedDisclosures(
  keys: readonly string[]
): readonly [ReadonlyMap<string, boolean>, (keys: readonly string[], open: boolean) => void] {
  // One string stands in for the key list, so a fresh array with the same keys
  // (every streamed delta builds one) neither resubscribes nor rebuilds.
  const signature = keys.join("\u0000")
  const stableKeys = useMemo(() => (signature ? signature.split("\u0000") : []), [signature])
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = stableKeys.map((key) => subscribeDisclosure(key, listener))
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
    },
    [stableKeys]
  )
  // A primitive snapshot, so `useSyncExternalStore` compares by value.
  const readSnapshot = useCallback(
    () =>
      stableKeys
        .map((key) => {
          const choice = readDisclosure(key)
          return choice === undefined ? "-" : choice ? "1" : "0"
        })
        .join(""),
    [stableKeys]
  )
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, () => "")
  const choices = useMemo(() => {
    const map = new Map<string, boolean>()
    stableKeys.forEach((key, index) => {
      const flag = snapshot[index]
      if (flag === "1") map.set(key, true)
      else if (flag === "0") map.set(key, false)
    })
    return map
  }, [snapshot, stableKeys])
  const set = useCallback(
    (targets: readonly string[], open: boolean) => writeDisclosures(targets, open),
    []
  )
  return [choices, set] as const
}
