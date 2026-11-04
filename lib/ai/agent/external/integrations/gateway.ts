/** Data/recipe composition only: each integration owns its gateway projection. */
import { codexGatewayProfile } from "@cognia/agent-codex/gateway-config"
import { piGatewayProfile } from "@cognia/agent-pi/gateway-config"
import { opencodeGatewayProfile } from "@cognia/agent-opencode/gateway-config"
import { dshGatewayProfile } from "@cognia/agent-dsh/gateway-config"
import { claudeGatewayProfile } from "@cognia/agent-claude-code/gateway-config"
import { aiderGatewayProfile } from "@cognia/agent-aider/gateway-config"
import { qwenGatewayProfile } from "@cognia/agent-acp/vendors/qwen-gateway"
import { kimiGatewayProfile } from "@cognia/agent-acp/vendors/kimi-gateway"
import { gooseGatewayProfile } from "@cognia/agent-acp/vendors/goose-gateway"
import { copilotGatewayProfile } from "@cognia/agent-acp/vendors/copilot-gateway"
export const gatewayRuntimeProfiles = [
  codexGatewayProfile,
  opencodeGatewayProfile,
  piGatewayProfile,
  claudeGatewayProfile,
  qwenGatewayProfile,
  dshGatewayProfile,
  kimiGatewayProfile,
  gooseGatewayProfile,
  copilotGatewayProfile,
  aiderGatewayProfile,
] as const
