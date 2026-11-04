/**
 * Tauri E2E: plugin runtime registry IPC contracts.
 *
 * `plugin_get_all` and `plugin_runtime_snapshot` are the renderer's read
 * paths into the Rust-side plugin manager. This spec asserts the contracts
 * (return shape + error semantics) so the renderer can rely on them without
 * having to defensively narrow at every call site.
 *
 * Native inventory is independent of renderer Dexie. Query a unique missing
 * id for errors and check any installed snapshot without resetting user data.
 */

import { expect, test } from "../fixtures"

test.describe("tauri: plugin runtime IPC", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("plugin_get_all returns flat inventory entries that resolve by id when installed", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      const list =
        await invoke<Array<{ plugin_id: string; version: string; status: string }>>(
          "plugin_get_all"
        )
      const snapshots = await Promise.all(
        list.map((entry) => invoke("plugin_runtime_snapshot", { pluginId: entry.plugin_id }))
      )
      return { list, snapshots }
    })
    expect(Array.isArray(result.list)).toBe(true)
    expect(result.snapshots).toHaveLength(result.list.length)
    for (const [index, entry] of result.list.entries()) {
      expect(entry).toMatchObject({
        plugin_id: expect.any(String),
        version: expect.any(String),
        status: expect.any(String),
      })
      // Lifecycle status can legitimately advance between the two IPC calls.
      expect(result.snapshots[index]).toMatchObject({
        plugin_id: entry.plugin_id,
        version: expect.any(String),
        status: expect.any(String),
        install_path: expect.any(String),
      })
    }
  })

  test("plugin_runtime_snapshot requires an id and rejects a missing plugin", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      try {
        await invoke("plugin_runtime_snapshot", { pluginId: `e2e-missing-${crypto.randomUUID()}` })
        return { rejected: false, error: "" }
      } catch (error) {
        return { rejected: true, error: String(error) }
      }
    })
    expect(result.rejected).toBe(true)
    expect(result.error).toMatch(/not found/i)
  })
})
