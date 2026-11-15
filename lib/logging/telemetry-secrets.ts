import { invoke } from "@tauri-apps/api/core"
import { clearSecret, getSecret, setSecret } from "@/lib/keyring"
import { isTauri } from "@/lib/platform/detect"

export type TelemetrySecretKind = "grafanaCloudApiToken" | "langfuseSecretKey"

const SECRET_REFS = {
  grafanaCloudApiToken: { namespace: "telemetry", key: "grafana-cloud-api-token" },
  langfuseSecretKey: { namespace: "telemetry", key: "langfuse-secret-key" },
} as const

export async function persistTelemetrySecret(
  kind: TelemetrySecretKind,
  value: string
): Promise<void> {
  if (!value) throw new Error("Telemetry secret must not be empty")
  if (kind === "grafanaCloudApiToken" && !isTauri()) {
    throw new Error("Grafana Cloud credentials require the secure desktop Host")
  }
  if (isTauri()) {
    await invoke("telemetry_secret_set", { kind, value })
    return
  }
  await setSecret(SECRET_REFS[kind], value)
}

export async function clearTelemetrySecret(kind: TelemetrySecretKind): Promise<void> {
  if (isTauri()) {
    await invoke("telemetry_secret_clear", { kind })
    return
  }
  await clearSecret(SECRET_REFS[kind])
}

export async function hasTelemetrySecret(kind: TelemetrySecretKind): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>("telemetry_secret_has", { kind })
  }
  return (await getSecret(SECRET_REFS[kind])) !== null
}
