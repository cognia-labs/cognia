/** Host-only snapshot proofs survive preview caching without entering the wire payload. */
const assertions = new WeakMap<
  object,
  { assertCurrent: () => Promise<void>; fingerprint: string }
>()

/** Shared by the builder and upload boundary without a client/builder import cycle. */
export function bindPersonalShareSnapshot<T extends object>(
  payload: T,
  assertCurrent: () => Promise<void>
): T {
  assertions.set(payload, { assertCurrent, fingerprint: JSON.stringify(payload) })
  return payload
}

export async function assertPersonalShareSnapshot(payload: object): Promise<void> {
  const proof = assertions.get(payload)
  if (
    !proof &&
    ["chat-html", "chat-animated", "chat-md", "chat-json", "chat-text", "chat-quote"].includes(
      (payload as { kind?: string }).kind ?? ""
    )
  )
    throw new Error("Personal chat share snapshot has no Host projection proof")
  if (proof && proof.fingerprint !== JSON.stringify(payload))
    throw new Error("Personal chat share snapshot payload changed after Host projection")
  await proof?.assertCurrent()
}
