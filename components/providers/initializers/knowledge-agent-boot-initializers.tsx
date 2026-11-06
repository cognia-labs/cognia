"use client"

import { useEffect } from "react"

import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { ProjectKnowledgeWorkerInitializer } from "@/components/shell/project-kb-worker-initializer"
import { TwinWorkerInitializer } from "@/components/twin/twin-worker-initializer"
import { ExternalAgentInitializer } from "./external-agent-initializer"
import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"
import { ModuleRuntimeHost } from "./module-runtime-host"
import { CloudIdentityInitializer } from "./cloud-identity-initializer"
import { SftpTransferInitializer } from "./sftp-transfer-initializer"
import { TemplatePlatformInitializer } from "./template-platform-initializer"
import { VectorCredentialMigrationInitializer } from "./vector-credential-migration-initializer"

export function KnowledgeAgentBootInitializers() {
  useEffect(() => markBootCapabilityReady("knowledge-agents"), [])
  return (
    <>
      <CloudIdentityInitializer />
      <ExternalAgentInitializer />
      {/* Module runtimes that wait for this group (ADR-0250 §14), among them
          the ordered Squad bootstrap that owns the Squad mirror, runtime and
          recovery (ADR-0169, `lib/squads/module.ts`), and the OCR provider
          install (`lib/ocr/module.ts`). */}
      <ModuleRuntimeHost boot="knowledge-agents" />
      <MemoryJobWorkerInitializer />
      <TwinWorkerInitializer />
      <ProjectKnowledgeWorkerInitializer />
      <VectorCredentialMigrationInitializer />
      <TemplatePlatformInitializer />
      <SftpTransferInitializer />
    </>
  )
}

export default KnowledgeAgentBootInitializers
