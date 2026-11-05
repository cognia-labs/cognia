/**
 * Lark's passive-transport liveness ping, contributed to the connector
 * heartbeat (`lib/connectors/health/passive-heartbeat.ts`) by
 * `./contribution.ts`, which also says which rows are passive (webhook mode).
 *
 * After a quiet spell the heartbeat asks `/bot/v3/info` whether the app's
 * credentials still work.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantToken } from "@/lib/auth-providers/feishu/auth"

export async function pingLark(row: AdapterInstanceRow): Promise<boolean> {
  try {
    const appId = (await connectorsKeyringGet(row.id, "appId")) ?? ""
    const appSecret = (await connectorsKeyringGet(row.id, "appSecret")) ?? ""
    if (!appId || !appSecret) return false
    const tat = await getTenantToken({ appId, appSecret }, "adapter-admin")
    if (!tat) return false
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: `Bearer ${tat}` },
      timeoutMs: 5_000,
    })
    return resp.status >= 200 && resp.status < 300
  } catch {
    return false
  }
}
