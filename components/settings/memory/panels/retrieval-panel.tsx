"use client"

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import type {
  MemoryConfig,
  MemoryEmbeddingSource,
  MemoryVectorBackend,
} from "@/types/memory/memory"
import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { GatedGroup, MemoryToggleRow, SliderRow } from "../memory-controls"
import { RecallPreview } from "../recall-preview"
import { RetrievalModeAlert } from "../retrieval-mode-alert"

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  transformersjs: "Xenova/all-MiniLM-L6-v2",
  ollama: "nomic-embed-text",
  openai: "text-embedding-3-small",
  google: "text-embedding-004",
  cohere: "embed-multilingual-v3.0",
  mistral: "mistral-embed",
  voyage: "voyage-3-lite",
}

export interface RetrievalPanelProps {
  config: MemoryConfig
  update: (patch: Partial<MemoryConfig>) => void
  insights: MemoryInsights
}

export function RetrievalPanel({ config, update, insights }: RetrievalPanelProps) {
  const t = useTranslations("settings.memory.retrieval")
  const embeddingSource: MemoryEmbeddingSource = config.embeddingSource ?? "twin"
  const customEmbedding = config.embedding ?? {
    provider: "transformersjs",
    model: DEFAULT_MODEL_BY_PROVIDER.transformersjs,
  }
  const customVectorStore = config.vectorStore ?? { backend: "native" as MemoryVectorBackend }

  const patchEmbedding = (patch: Partial<NonNullable<MemoryConfig["embedding"]>>) => {
    update({
      embedding: {
        provider: customEmbedding.provider,
        model: customEmbedding.model,
        apiKey: customEmbedding.apiKey,
        baseURL: customEmbedding.baseURL,
        dimensions: customEmbedding.dimensions,
        ...patch,
      },
    })
  }

  const patchVectorStore = (patch: Partial<NonNullable<MemoryConfig["vectorStore"]>>) => {
    update({
      vectorStore: {
        ...customVectorStore,
        ...patch,
      },
    })
  }

  return (
    <div className="space-y-4">
      <RetrievalModeAlert
        mode={insights.retrievalMode}
        onEnableHybrid={() => update({ hybridEnabled: true })}
        onAllowCloudEmbedding={() => update({ allowCloudEmbedding: true })}
        configureHref={
          embeddingSource === "custom" ? "/settings?section=memory&memoryTab=retrieval" : "/twin"
        }
        quietWhenHealthy
      />

      <MemoryToggleRow
        id="mem-use"
        label={t("useMemory.label")}
        description={t("useMemory.description")}
        checked={config.useMemory}
        disabled={!config.enabled}
        onCheckedChange={(v) => update({ useMemory: v })}
      />

      <GatedGroup
        gated={!config.enabled || !config.useMemory}
        reason={!config.enabled ? t("gates.memoryOff") : t("gates.recallOff")}
        className="space-y-4 border-l-2 pl-3"
      >
        <div className="space-y-2">
          <MemoryToggleRow
            id="mem-hybrid"
            label={t("hybrid.label")}
            description={t("hybrid.description")}
            checked={config.hybridEnabled}
            onCheckedChange={(v) => update({ hybridEnabled: v })}
          />
          {config.hybridEnabled ? (
            <div className="space-y-3 rounded-md border p-3" data-testid="memory-backend-config">
              <div className="space-y-1.5">
                <Label htmlFor="mem-embedding-source" className="text-sm font-medium">
                  {t("backend.sourceLabel")}
                </Label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("backend.sourceDescription")}
                </p>
                <Select
                  value={embeddingSource}
                  onValueChange={(value) => {
                    const nextSource = value as MemoryEmbeddingSource
                    update({
                      embeddingSource: nextSource,
                      ...(nextSource === "custom" && !config.embedding
                        ? {
                            embedding: {
                              provider: "transformersjs",
                              model: DEFAULT_MODEL_BY_PROVIDER.transformersjs,
                            },
                            vectorStore: config.vectorStore ?? { backend: "native" },
                          }
                        : {}),
                    })
                  }}
                >
                  <SelectTrigger
                    id="mem-embedding-source"
                    className="w-full sm:w-80"
                    aria-label={t("backend.sourceLabel")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="twin">{t("backend.sources.twin")}</SelectItem>
                    <SelectItem value="custom">{t("backend.sources.custom")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {embeddingSource === "custom" ? (
                <div className="grid gap-3 pt-1 @md/memory-pane:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="mem-embedding-provider" className="text-xs font-medium">
                      {t("backend.providerLabel")}
                    </Label>
                    <Select
                      value={customEmbedding.provider}
                      onValueChange={(provider) =>
                        patchEmbedding({
                          provider,
                          model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? customEmbedding.model,
                        })
                      }
                    >
                      <SelectTrigger
                        id="mem-embedding-provider"
                        aria-label={t("backend.providerLabel")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="transformersjs">
                          {t("backend.providers.transformersjs")}
                        </SelectItem>
                        <SelectItem value="ollama">{t("backend.providers.ollama")}</SelectItem>
                        <SelectItem value="openai">{t("backend.providers.openai")}</SelectItem>
                        <SelectItem value="google">{t("backend.providers.google")}</SelectItem>
                        <SelectItem value="cohere">{t("backend.providers.cohere")}</SelectItem>
                        <SelectItem value="mistral">{t("backend.providers.mistral")}</SelectItem>
                        <SelectItem value="voyage">{t("backend.providers.voyage")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="mem-embedding-model" className="text-xs font-medium">
                      {t("backend.modelLabel")}
                    </Label>
                    <Input
                      id="mem-embedding-model"
                      aria-label={t("backend.modelLabel")}
                      value={customEmbedding.model}
                      onChange={(e) => patchEmbedding({ model: e.target.value })}
                      placeholder={t("backend.placeholders.model")}
                    />
                  </div>

                  {customEmbedding.provider !== "transformersjs" ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="mem-embedding-base-url" className="text-xs font-medium">
                          {t("backend.baseUrlLabel")}
                        </Label>
                        <Input
                          id="mem-embedding-base-url"
                          aria-label={t("backend.baseUrlLabel")}
                          value={customEmbedding.baseURL ?? ""}
                          onChange={(e) => patchEmbedding({ baseURL: e.target.value || undefined })}
                          placeholder={
                            customEmbedding.provider === "ollama"
                              ? t("backend.placeholders.ollamaUrl")
                              : t("backend.placeholders.cloudUrl")
                          }
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="mem-embedding-api-key" className="text-xs font-medium">
                          {t("backend.apiKeyLabel")}
                        </Label>
                        <Input
                          id="mem-embedding-api-key"
                          type="password"
                          aria-label={t("backend.apiKeyLabel")}
                          value={customEmbedding.apiKey ?? ""}
                          onChange={(e) => patchEmbedding({ apiKey: e.target.value || undefined })}
                          placeholder={t("backend.placeholders.apiKey")}
                        />
                      </div>
                    </>
                  ) : null}

                  <div className="space-y-1.5">
                    <Label htmlFor="mem-vector-backend" className="text-xs font-medium">
                      {t("backend.vectorStoreLabel")}
                    </Label>
                    <Select
                      value={customVectorStore.backend}
                      onValueChange={(backend) =>
                        patchVectorStore({ backend: backend as MemoryVectorBackend })
                      }
                    >
                      <SelectTrigger
                        id="mem-vector-backend"
                        aria-label={t("backend.vectorStoreLabel")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="native">{t("backend.vectorStores.native")}</SelectItem>
                        <SelectItem value="qdrant">{t("backend.vectorStores.qdrant")}</SelectItem>
                        <SelectItem value="chroma">{t("backend.vectorStores.chroma")}</SelectItem>
                        <SelectItem value="weaviate">
                          {t("backend.vectorStores.weaviate")}
                        </SelectItem>
                        <SelectItem value="milvus">{t("backend.vectorStores.milvus")}</SelectItem>
                        <SelectItem value="pinecone">
                          {t("backend.vectorStores.pinecone")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {customVectorStore.backend === "qdrant" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="mem-vector-url" className="text-xs font-medium">
                        {t("backend.vectorEndpointLabel")}
                      </Label>
                      <Input
                        id="mem-vector-url"
                        aria-label={t("backend.vectorEndpointLabel")}
                        value={customVectorStore.qdrantUrl ?? ""}
                        onChange={(e) =>
                          patchVectorStore({ qdrantUrl: e.target.value || undefined })
                        }
                        placeholder={t("backend.placeholders.qdrantUrl")}
                      />
                    </div>
                  ) : customVectorStore.backend === "chroma" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="mem-vector-url" className="text-xs font-medium">
                        {t("backend.vectorEndpointLabel")}
                      </Label>
                      <Input
                        id="mem-vector-url"
                        aria-label={t("backend.vectorEndpointLabel")}
                        value={customVectorStore.chromaServerUrl ?? ""}
                        onChange={(e) =>
                          patchVectorStore({ chromaServerUrl: e.target.value || undefined })
                        }
                        placeholder={t("backend.placeholders.chromaUrl")}
                      />
                    </div>
                  ) : customVectorStore.backend === "weaviate" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="mem-vector-url" className="text-xs font-medium">
                        {t("backend.vectorEndpointLabel")}
                      </Label>
                      <Input
                        id="mem-vector-url"
                        aria-label={t("backend.vectorEndpointLabel")}
                        value={customVectorStore.weaviateUrl ?? ""}
                        onChange={(e) =>
                          patchVectorStore({ weaviateUrl: e.target.value || undefined })
                        }
                        placeholder={t("backend.placeholders.weaviateUrl")}
                      />
                    </div>
                  ) : customVectorStore.backend === "milvus" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="mem-vector-url" className="text-xs font-medium">
                        {t("backend.vectorEndpointLabel")}
                      </Label>
                      <Input
                        id="mem-vector-url"
                        aria-label={t("backend.vectorEndpointLabel")}
                        value={customVectorStore.milvusAddress ?? ""}
                        onChange={(e) =>
                          patchVectorStore({ milvusAddress: e.target.value || undefined })
                        }
                        placeholder={t("backend.placeholders.milvusAddress")}
                      />
                    </div>
                  ) : customVectorStore.backend === "pinecone" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="mem-vector-url" className="text-xs font-medium">
                        {t("backend.pineconeIndexLabel")}
                      </Label>
                      <Input
                        id="mem-vector-url"
                        aria-label={t("backend.pineconeIndexLabel")}
                        value={customVectorStore.pineconeIndexName ?? ""}
                        onChange={(e) =>
                          patchVectorStore({ pineconeIndexName: e.target.value || undefined })
                        }
                        placeholder={t("backend.placeholders.pineconeIndex")}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <MemoryToggleRow
            id="mem-query-expansion"
            label={t("queryExpansion.label")}
            description={t("queryExpansion.description")}
            checked={config.enableQueryExpansion ?? false}
            onCheckedChange={(v) => update({ enableQueryExpansion: v })}
          />
          <MemoryToggleRow
            id="mem-session-recall"
            label={t("sessionRecall.label")}
            description={t("sessionRecall.description")}
            checked={config.sessionRecallRouting ?? false}
            onCheckedChange={(v) => update({ sessionRecallRouting: v })}
          />
          <MemoryToggleRow
            id="mem-llm-rerank"
            label={t("llmRerank.label")}
            description={t("llmRerank.description")}
            checked={config.llmRerank ?? false}
            onCheckedChange={(v) => update({ llmRerank: v })}
          />
        </div>

        <RecallPreview
          config={config}
          averageTokens={insights.corpus.averageTokens}
          activeCount={insights.corpus.stats.active}
        />

        <SliderRow
          id="mem-topk"
          label={t("topK.label")}
          description={t("topK.description")}
          value={config.retrievalTopK}
          min={1}
          max={32}
          step={1}
          onChange={(v) => update({ retrievalTopK: v })}
        />

        <SliderRow
          id="mem-token-budget"
          label={t("tokenBudget.label")}
          description={t("tokenBudget.description")}
          value={config.recallTokenBudget}
          min={128}
          max={4000}
          step={32}
          onChange={(v) => update({ recallTokenBudget: v })}
        />

        <SliderRow
          id="mem-relevance"
          label={t("relevanceFloor.label")}
          description={t("relevanceFloor.description")}
          value={config.relevanceFloor}
          min={0}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => update({ relevanceFloor: v })}
        />

        <SliderRow
          id="mem-belief-weight"
          label={t("beliefWeight.label")}
          description={t("beliefWeight.description")}
          value={config.beliefRankingWeight ?? 0}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (v === 0 ? t("beliefWeight.off") : v.toFixed(1))}
          onChange={(v) => update({ beliefRankingWeight: Math.round(v * 10) / 10 })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="mem-half-life" className="text-sm font-medium">
            {t("halfLife.label")}
          </Label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("halfLife.description")}
          </p>
          <ClampedNumberInput
            id="mem-half-life"
            aria-label={t("halfLife.label")}
            value={config.decayHalfLifeDays}
            min={1}
            max={3650}
            integer
            className="w-full sm:w-40"
            onCommit={(v) => update({ decayHalfLifeDays: v })}
          />
        </div>
      </GatedGroup>
    </div>
  )
}
