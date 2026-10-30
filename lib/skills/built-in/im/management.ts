/** One shared operator surface; adapters supply named capabilities and codecs. */
import { z } from "zod"
import type { BuiltInSkill } from "../types"
import { registerBuiltInSkill } from "../registry"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { resolveChatCapableAdapter } from "./_helpers"
import {
  CONNECTOR_MANAGEMENT_OPERATIONS,
  connectorManagementIsRead,
  connectorManagementCapability,
  executeConnectorManagement,
  validateConnectorManagementRequest,
} from "@/lib/connectors/management"
import type { ConnectorManagementRequest } from "@/types/connectors/management"

for (const readOnly of [true, false]) {
  const operations = CONNECTOR_MANAGEMENT_OPERATIONS.filter(
    (operation) => connectorManagementIsRead(operation) === readOnly
  )
  const schema = z
    .object({
      adapterId: z.string().optional(),
      operation: z.enum(
        operations as [(typeof operations)[number], ...(typeof operations)[number][]]
      ),
      input: z
        .record(z.string(), z.unknown())
        .describe(
          "Parameters of the named connector operation. Shared contracts are documented in the connector guide; platform wire URLs/headers are never accepted."
        ),
    })
    .strict()
  const skill: BuiltInSkill<typeof schema> = {
    id: readOnly ? "im.query_resource" : "im.manage_resource",
    mcpToolName: readOnly ? "im_query_resource" : "im_manage_resource",
    family: "im",
    platforms: "any",
    requires: [],
    label: readOnly
      ? { en: "Query connector resource", "zh-CN": "查询连接器资源" }
      : { en: "Manage connector resource", "zh-CN": "管理连接器资源" },
    description: readOnly
      ? {
          en: "Read reusable assets, menus, command panels, members, moderation and join requests through a capable running connector.",
          "zh-CN": "通过支持相应能力的连接器查询素材、菜单、指令面板、成员、禁言与入群申请。",
        }
      : {
          en: "Create add-contact invitation links or manage reusable assets, menus, command panels, members, moderation and join policies. Requires explicit confirmation; platform permissions still apply.",
          "zh-CN":
            "生成添加联系人的邀请链接，或管理素材、菜单、指令面板、成员、禁言与入群策略。需要明确确认，仍受平台权限限制。",
        },
    mutation: readOnly ? "read" : "destructive",
    imAccess: "opt-in",
    inputSchema: schema,
    // Named-operation validation below scans every publishable prose field;
    // provider-owned identifiers and explicit image bytes are not prose.
    piiArgFields: ["input"],
    preflight: async (args, ctx) => {
      validateConnectorManagementRequest({
        operation: args.operation,
        input: args.input,
      } as ConnectorManagementRequest)
      const resolved = await resolveChatCapableAdapter(
        ctx,
        [connectorManagementCapability(args.operation)],
        args.adapterId
      )
      args.adapterId = resolved.adapter.id
    },
    execute: async (args, ctx) => {
      const resolved = await resolveChatCapableAdapter(
        ctx,
        [connectorManagementCapability(args.operation)],
        args.adapterId
      )
      return executeConnectorManagement(resolved.adapter, {
        operation: args.operation,
        input: args.input,
      } as ConnectorManagementRequest)
    },
    ...(!readOnly
      ? {
          hitlSurface: (args: z.infer<typeof schema>) =>
            buildConfirmSurface({
              surfaceId: `connector_management_${crypto.randomUUID()}`,
              title: "Manage connector resource",
              summary: `Execute ${args.operation} on the selected connector.`,
              details: [
                { label: "Connector", value: args.adapterId ?? "Current connector" },
                { label: "Operation", value: args.operation },
                {
                  label: "Changes",
                  value: JSON.stringify(args.input, (key, value) =>
                    key === "source"
                      ? "[image source]"
                      : key === "dataBase64"
                        ? "[image bytes]"
                        : value
                  ).slice(0, 6000),
                },
              ],
            }),
        }
      : {}),
  }
  registerBuiltInSkill(skill)
}
