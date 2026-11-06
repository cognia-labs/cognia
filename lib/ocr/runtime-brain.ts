/**
 * The OCR runtime on the brain (ADR-0024, ADR-0250 §14): every built-in
 * provider into the shared registry, so the brain's agent tools, connectors
 * and workflows extract on their own. It replaced the brain roster's own
 * `ocr-runtime` registration under the same name, the one operators restart
 * it by. A restart starts from an empty registry.
 */

export async function start(): Promise<() => void> {
  const [{ installOcrRuntime, __resetOcrRuntime }, { __resetSharedOcrRegistry }] =
    await Promise.all([import("./runtime"), import("./registry")])
  await installOcrRuntime()
  return () => {
    __resetOcrRuntime()
    __resetSharedOcrRegistry()
  }
}
