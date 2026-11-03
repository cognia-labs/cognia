"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  ChevronDownIcon,
  LinkIcon,
  GitFork as GitForkIcon,
  XIcon,
  MoreHorizontalIcon,
  ArchiveIcon,
  BanIcon,
  LockIcon,
} from "lucide-react"
import { toast } from "sonner"
import { usePlatform } from "@/hooks/use-platform"
import { refreshTemplateOwners } from "@/lib/global-search/providers/library"
import { useScopedTemplateCatalog } from "@/hooks/templates/use-scoped-template-catalog"
import { useTemplateRouteState, type TemplateTab } from "@/hooks/templates/use-template-route-state"
import {
  TEMPLATE_SCOPE_TIERS,
  trustRestatesScope,
  type TemplateScopeTier,
} from "@/lib/templates/scope"
import { useProjectStore } from "@/stores/project/project-store"
import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplateInputSpec,
  TemplateJson,
  TemplatePlatform,
  TemplateVersionBump,
} from "@/lib/templates/contracts"
import {
  TEMPLATE_FULL_DOMAINS,
  isTemplateInputId,
  listTemplateTokens,
} from "@/lib/templates/contracts"
import type { InspectedTemplatePackage } from "@/lib/templates/package"
import type {
  TemplateConflictResolution,
  TemplateDerivedUpdatePlan,
  TemplatePackageVerification,
  TemplatePreflightPlan,
  TemplateUpdatePlan,
} from "@/lib/templates/service"
import type { TemplateDerivation } from "@/lib/templates/repository"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import { makeTemplateDraftId } from "@/lib/templates/draft-id"
import { downloadTemplatePackage, templatePackageFilename } from "@/lib/templates/download-package"
import { createPublisherSigner, publisherFingerprint } from "@/lib/templates/publisher-identity"
import { trustPublisher } from "@/lib/db/trusted-publishers"
import { TemplateDefinitionShareButton } from "@/components/share/template-definition-share-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { isWorkflowNodeGroupDefinition } from "@/lib/workflow/node-groups/materialize"
import { cn } from "@/lib/utils"

import { TemplateBindingField } from "./template-binding-field"
import { TemplateExportDialog, type TemplateExportRequest } from "./template-export-dialog"
import { TemplatePackagesTab } from "./template-packages-tab"
import { TemplateMetadataEditor, type TemplateMetadataDraft } from "./template-metadata-editor"
import { PublishConfirmDialog, type PublishSuggestion } from "./publish-confirm-dialog"
import { InstantiateConfirmDialog } from "./instantiate-confirm-dialog"
import { TemplateInstanceCard } from "./template-instance-card"
import { TemplateDerivedUpdateDialog } from "./template-derived-update-dialog"
import { TemplateOriginCard } from "./template-origin-card"
import { TemplateScopeControl } from "./template-scope-control"
import { TemplateUpdateDialog } from "./template-update-dialog"
import { TemplateUrlImportDialog } from "./template-url-import-dialog"
import { DEFINITION_SHELVES, TemplateDomainIcon, TemplateNavSidebar } from "./template-nav-sidebar"

/** Domains with a real adapter: these can be authored, published, instantiated. */
const FULL_DOMAINS: TemplateDomain[] = [...TEMPLATE_FULL_DOMAINS]

type DefinitionShelf = "library" | "drafts" | "published"

/** The rows a definition shelf lists: drafts (and conflicts), releases, or both. */
function rowsForTab(
  definitions: readonly TemplateDefinitionEnvelope[],
  tab: DefinitionShelf
): TemplateDefinitionEnvelope[] {
  if (tab === "drafts")
    return definitions.filter(
      (definition) => definition.status === "draft" || definition.status === "conflict"
    )
  if (tab === "published") return definitions.filter((definition) => definition.version !== null)
  return [...definitions]
}

/**
 * Where a domain's real editor lives.
 *
 * Two of these used to carry `?mode=template-authoring`, a parameter nothing
 * in the repository reads, and `customMode` pointed at `?section=agent`, which
 * is not a `SettingsSectionId` (the catalog has `agents`, `agent-modes` and
 * `agent-runtime`) so the shell silently fell back to AI connections. A link
 * that lands somewhere unrelated is worse than one that lands on the list.
 */
const EDITOR_ROUTES: Record<string, string> = {
  agentTeam: "/settings?section=squads",
  chatTemplate: "/settings?section=chatTemplates",
  // Document templates are made and used on the Files page (ADR-0223).
  document: "/files",
  workflow: "/workflows",
  subagent: "/me/subagents",
  customMode: "/settings?section=agent-modes",
  character: "/discover?category=characters",
  skill: "/skills",
}

/**
 * Seed payload for a new draft, per domain.
 *
 * The return type is annotated rather than inferred: without it TypeScript
 * unions the seven branch shapes and pads each with the other branches' keys as
 * `name?: undefined`, and a property of type `undefined` is not a `TemplateJson`
 * — so the inferred type could not be assigned to the `payload` field it exists
 * to fill.
 */
function defaultPayload(domain: TemplateDomain, name: string, teamLeadName: string): TemplateJson {
  switch (domain) {
    case "agentTeam":
      return {
        team: { name, description: "", task: "", config: {} },
        lead: { localId: "lead", name: teamLeadName, description: "", config: {} },
        teammates: [],
        tasks: [],
        twinSlots: [],
      }
    case "workflow":
      return { name, nodes: [], edges: [], settings: {}, viewport: { x: 0, y: 0, zoom: 1 } }
    case "subagent":
      return { name, description: "", category: "general", taskTemplate: "", config: {} }
    case "customMode":
      return { name, description: "", type: "custom", tools: [] }
    case "character":
      return { name, systemPrompt: "" }
    case "skill":
      return { name, content: "" }
    default:
      return {}
  }
}

export function TemplateStudio() {
  const t = useTranslations("templateStudio")
  const platform = usePlatform()
  const templatePlatform: TemplatePlatform =
    platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const runtime = useMemo(() => getTemplateRuntime(), [])
  // Filters live in the URL, shared with the phone body through
  // `useTemplateRouteState`, so a narrowed catalog is something you can send
  // someone and it opens the same way on either surface.
  const route = useTemplateRouteState()
  const { query, domain, trust, scope: tier } = route
  const { setQuery, setDomain, setTrust, setScope: setTier } = route
  // Scoped, not raw: a definition confined to another workspace is not this
  // workspace's to list, and one this workspace hid should not come back
  // because the Studio asked a different question than the phone did.
  //
  // Queried without the type: the rail counts every type the other filters
  // leave, and the type is applied here, on the same rows.
  const {
    definitions: catalogRows,
    revision,
    tierOf,
    owners,
    hiddenCount,
  } = useScopedTemplateCatalog(
    {
      text: query,
      platform: templatePlatform,
      ...(trust === "all" ? {} : { trust }),
    },
    { tier }
  )
  const definitions = useMemo(
    () =>
      domain === "all"
        ? catalogRows
        : catalogRows.filter((definition) => definition.domain === domain),
    [catalogRows, domain]
  )
  const activeWorkspaceId = useProjectStore((state) => state.activeProjectId)
  const [allWorkspaceInstances, setAllWorkspaceInstances] = useState(false)
  const instanceScope = useMemo(
    () =>
      allWorkspaceInstances || !activeWorkspaceId ? undefined : { projectId: activeWorkspaceId },
    [allWorkspaceInstances, activeWorkspaceId]
  )
  /**
   * WHICH template is selected lives in `?definition=`, the same param the
   * phone body reads.
   *
   * `?definition=` is how /agent-teams, the workflow settings tab and global
   * search hand a template over, and the Studio used to read it once through
   * its own `useSearchParams` and then keep the answer in a local
   * `selectionKey`. So clicking a card changed nothing in the URL: the desktop
   * selection could not be sent to anyone, and a link opened on a phone and on
   * a laptop meant two different things.
   *
   * WHICH ENVELOPE of that id is a second, narrower question the URL should not
   * carry: one definition id holds a draft and every release published from it,
   * and the row the user clicked is one of them. Pinned locally, and only while
   * it still names the selected id — a stale pin from a previous selection
   * simply stops applying, which is what keeps this from fighting the router's
   * own re-render.
   */
  const selectedId = route.definitionId
  const [pinnedEnvelope, setPinnedEnvelope] = useState<{ id: string; contentHash: string }>()
  const selected = useMemo(() => {
    if (!selectedId) return undefined
    const rows = definitions.filter((definition) => definition.id === selectedId)
    const pinned =
      pinnedEnvelope?.id === selectedId
        ? rows.find((definition) => definition.contentHash === pinnedEnvelope.contentHash)
        : undefined
    return pinned ?? rows[0]
  }, [definitions, selectedId, pinnedEnvelope])

  /**
   * Select a definition, and remember which of its envelopes was clicked.
   *
   * Not memoised: `useTemplateRouteState` returns a fresh object every render,
   * so a `useCallback` over it would be a stable-looking identity that changes
   * anyway.
   */
  const selectEnvelope = (definition: TemplateDefinitionEnvelope) => {
    setPinnedEnvelope({ id: definition.id, contentHash: definition.contentHash })
    route.setDefinitionId(definition.id)
  }
  const [packages, setPackages] = useState<
    Awaited<ReturnType<typeof runtime.repository.listPackages>>
  >([])
  const [instances, setInstances] = useState<
    Awaited<ReturnType<typeof runtime.repository.listInstances>>
  >([])
  // Whether the inspector rail's below-`md` Sheet is showing. Desktop ignores
  // it: the rail is always mounted there.
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [draftDescription, setDraftDescription] = useState("")
  const [draftDomain, setDraftDomain] = useState<TemplateDomain>("skill")
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<TemplatePreflightPlan>()
  const [message, setMessage] = useState<string>()
  const [publishSuggestion, setPublishSuggestion] = useState<PublishSuggestion | null>(null)
  const [pendingInstantiate, setPendingInstantiate] = useState<TemplatePreflightPlan>()
  const [updatePlan, setUpdatePlan] = useState<TemplateUpdatePlan>()
  const [derivedPlan, setDerivedPlan] = useState<TemplateDerivedUpdatePlan>()
  const [derivation, setDerivation] = useState<TemplateDerivation>()
  const [upstream, setUpstream] = useState<TemplateDefinitionEnvelope>()
  // Bumped after a merge or a detach so the origin card re-reads. The lineage
  // lives in the repository, not in the catalog the selection comes from, so
  // nothing else would tell this view it changed.
  const [originNonce, setOriginNonce] = useState(0)
  const [pendingImport, setPendingImport] = useState<{
    bytes: Uint8Array
    inspected: InspectedTemplatePackage
    /** Present only for a URL / link import, recorded as `provenance.sourceUrl`. */
    sourceUrl?: string
  }>()
  const [urlImportOpen, setUrlImportOpen] = useState(false)
  /**
   * Whether the user accepted this package's publisher key during THIS import.
   *
   * `inspected.trust` is computed from the manifest alone (`signed-unknown` for
   * any signature), so it cannot notice a ledger write that happened after the
   * inspection. The import itself re-resolves trust from the ledger, so what
   * this flag changes is only what the dialog says while it is open.
   */
  const [publisherTrusted, setPublisherTrusted] = useState(false)
  /** Bumped after a ledger write / key rotation so the Packages tab re-reads. */
  const [trustLedgerNonce, setTrustLedgerNonce] = useState(0)
  const [publisherKeyNonce, setPublisherKeyNonce] = useState(0)
  const [packageReports, setPackageReports] = useState<Record<string, TemplatePackageVerification>>(
    {}
  )
  const [exportOrigin, setExportOrigin] = useState<TemplateDefinitionEnvelope>()
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      runtime.repository.listPackages(),
      runtime.repository.listInstances(instanceScope),
    ]).then(([nextPackages, nextInstances]) => {
      if (!active) return
      setPackages(nextPackages)
      setInstances(nextInstances)
    })
    return () => {
      active = false
    }
  }, [revision, runtime, instanceScope])

  /**
   * The selected definition's fork lineage, and whether upstream has moved.
   *
   * Read here rather than in the inspector because the lineage is repository
   * state, not catalog state: the selection carries the envelope, and the
   * envelope deliberately does not know where it came from.
   */
  const lineageId = selected?.id
  useEffect(() => {
    let active = true
    // The empty case resolves through the same promise rather than clearing
    // synchronously: a bare setState in an effect body cascades renders, and
    // the lint rule that catches it is there for exactly this shape.
    const load = lineageId
      ? Promise.all([
          runtime.service.getDerivation(lineageId),
          runtime.service.findUpstreamUpdate(lineageId),
        ])
      : Promise.resolve([undefined, undefined] as const)
    void load
      .then(([nextDerivation, nextUpstream]) => {
        if (!active) return
        setDerivation(nextDerivation)
        setUpstream(nextUpstream)
      })
      .catch(() => {
        if (!active) return
        setDerivation(undefined)
        setUpstream(undefined)
      })
    return () => {
      active = false
    }
  }, [lineageId, originNonce, revision, runtime])

  /**
   * Run an async handler and report what happened.
   *
   * Seven handlers here were `void fn()` with no catch, and every one of them
   * can throw: `publish` on a revision clash or a bump mismatch,
   * `exportPackage` on a release the repository does not hold (a plugin- or
   * overlay-supplied one always), `instantiate` on any adapter failure,
   * `importPackage` on a signature or bounds violation. All of them surfaced
   * as an unhandled rejection and a UI where nothing happened.
   */
  const guard = useCallback(
    (fn: () => Promise<void>) => () => {
      void fn().catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    []
  )

  /**
   * Released versions per definition, so an instance card can offer the ones it
   * could move to. Derived from the catalog the page already reads rather than
   * a per-card query.
   */
  const releasedVersionsByDefinition = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const definition of definitions) {
      if (!definition.version) continue
      if (definition.status === "yanked" || definition.status === "tombstone") continue
      ;(out[definition.id] ??= []).push(definition.version)
    }
    return out
  }, [definitions])

  const openUpdate = async (instanceId: string, version: string) => {
    setUpdatePlan(await runtime.service.planUpdate(instanceId, version))
  }

  const applyUpdate = async (
    target: TemplateUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => {
    await runtime.service.applyUpdate(target, { confirmed: true, resolutions })
    setUpdatePlan(undefined)
    setMessage(t("messages.updated", { version: target.next.version ?? "" }))
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  const detachInstance = async (instanceId: string) => {
    await runtime.service.detachInstance(instanceId)
    setMessage(t("messages.detached"))
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  /**
   * Fork a published release into a new editable draft. `service.fork` existed
   * with no caller, which is why the only way to base a template on an existing
   * one was to create a blank draft and retype it.
   */
  const forkSelected = async () => {
    if (!selected) return
    const forked = await runtime.service.fork(selected.id, {
      ...(selected.version ? { version: selected.version } : {}),
      newId: makeTemplateDraftId(selected.domain, `${selected.metadata.name} copy`),
    })
    route.setDefinitionId(forked.id)
    setPinnedEnvelope(undefined)
    // Ownership can have changed, and global search reads a snapshot of it.
    await refreshTemplateOwners()
    setMessage(t("messages.forked", { id: forked.id }))
  }

  /**
   * Reconcile a fork with a newer release of what it came from.
   *
   * The lineage and the upstream lookup both come from the service, so the
   * inspector never has to guess which release a fork is measured against.
   */
  const reviewDerivedUpdate = async () => {
    if (!selected) return
    setDerivedPlan(await runtime.service.planDerivedUpdate(selected.id))
  }

  const applyDerivedUpdate = async (
    target: TemplateDerivedUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => {
    await runtime.service.applyDerivedUpdate(target, { confirmed: true, resolutions })
    setDerivedPlan(undefined)
    setOriginNonce((value) => value + 1)
    setMessage(t("origin.merged"))
  }

  const detachDerivation = async () => {
    if (!selected) return
    await runtime.service.detachDerivation(selected.id)
    setOriginNonce((value) => value + 1)
    setMessage(t("origin.detached"))
  }

  /**
   * Confine the selected definition to this workspace, or share it again.
   *
   * `service.setDefinitionWorkspace` shipped with no production caller, so the
   * only moment a template could be confined was the instant it was forked, and
   * nothing could ever undo that. Ownership is a local-row field, so this
   * changes who LISTS the definition and touches neither the envelope nor its
   * content hash.
   */
  const setDefinitionWorkspace = async (workspaceId: string | null) => {
    if (!selected) return
    await runtime.service.setDefinitionWorkspace(selected.id, workspaceId)
    // Global search ranks on a synchronous snapshot of ownership, so it has to
    // be retaken here for the same reason `forkSelected` retakes it.
    await refreshTemplateOwners()
    setMessage(t(workspaceId ? "messages.confined" : "messages.shared"))
  }

  /** Withdraw a release. `deprecate` also had no caller. */
  const deprecateSelected = async (status: "deprecated" | "yanked") => {
    if (!selected?.version) return
    await runtime.service.deprecate(selected.id, selected.version, status)
    setMessage(t(`messages.${status}`))
  }

  const selectDefinition = (definition: TemplateDefinitionEnvelope) => {
    selectEnvelope(definition)
    setBindings({})
    setPlan(undefined)
    setInspectorOpen(true)
  }

  const createDraft = async () => {
    const trimmed = draftName.trim()
    if (!trimmed) return
    const id = makeTemplateDraftId(draftDomain, trimmed)
    await runtime.service.createDraft({
      id,
      domain: draftDomain,
      metadata: { name: trimmed, description: draftDescription.trim() || undefined },
      payload: defaultPayload(draftDomain, trimmed, t("defaults.teamLead")),
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
    })
    setDraftName("")
    setDraftDescription("")
    setCreateOpen(false)
    setMessage(t("messages.draftCreated"))
  }

  const runPreflight = async () => {
    if (!selected) return
    const next = await runtime.service.preflight({
      definitionId: selected.id,
      ...(selected.version ? { version: selected.version } : {}),
      platform: templatePlatform,
      bindings,
    })
    setPlan(next)
  }

  /**
   * `plan.requiresConfirmation` is set whenever a binding resolves a secret or
   * a twin slot, and the preflight alert already says so. The button passed
   * `confirmed: true` unconditionally, so the one gate the plan asks for was
   * answered by the caller on the user's behalf.
   */
  const instantiate = async () => {
    if (!plan) return
    if (plan.status === "needs-confirmation") {
      setPendingInstantiate(plan)
      return
    }
    await commitInstantiate(plan)
  }

  const commitInstantiate = async (target: TemplatePreflightPlan) => {
    await runtime.service.instantiate({ plan: target, confirmed: true })
    setPendingInstantiate(undefined)
    setMessage(t("messages.instantiated"))
    setPlan(undefined)
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  /**
   * Ask for the version, then publish.
   *
   * `service.publish` refuses a `confirmedBump` that does not match its own
   * conservative suggestion, and returns the reasons, precisely so a human sees
   * why a change is major before it becomes major. Fetching the suggestion and
   * handing it straight back satisfied the check and defeated the point.
   */
  const openPublish = async () => {
    if (!selected || selected.status !== "draft") return
    const suggestion = await runtime.service.getPublishSuggestion(selected.id)
    setPublishSuggestion({ ...suggestion, bump: suggestion.bump as TemplateVersionBump })
  }

  const publish = async (bump: TemplateVersionBump) => {
    if (!selected || selected.status !== "draft") return
    const published = await runtime.service.publish(selected.id, {
      expectedRevision: selected.revision,
      confirmedBump: bump,
    })
    setPublishSuggestion(null)
    selectEnvelope(published)
    setMessage(t("messages.published", { version: published.version }))
  }

  /**
   * Persist an edit to the selected draft.
   *
   * `service.saveDraft` had no caller anywhere in the app. The Studio could
   * mint a stub payload (`defaultPayload`) and publish it, but never change
   * what was in it — and the advertised escape hatch, the per-domain "open
   * editor" link, points two of its six domains at `?mode=template-authoring`,
   * a parameter nothing in the repository handles. Templates were write-once
   * from the moment they were created.
   *
   * Errors propagate to the editor, which renders them: `saveDraft` refuses a
   * payload that fails validation and names the reasons, and swallowing that
   * here would leave the user staring at an unchanged box.
   */
  const saveDraft = async (edits: {
    name: string
    description: string
    payload: TemplateJson
    inputs: TemplateInputSpec[]
    metadata: TemplateMetadataDraft
  }) => {
    if (!selected) return
    const saved = await runtime.service.saveDraft(
      {
        ...selected,
        metadata: {
          ...selected.metadata,
          ...edits.metadata.metadata,
          name: edits.name,
          description: edits.description || undefined,
        },
        payload: edits.payload,
        inputs: edits.inputs,
        dependencies: edits.metadata.dependencies,
        capabilities: edits.metadata.capabilities,
        compatibility: edits.metadata.compatibility,
      },
      selected.revision
    )
    // Follows the row that was actually written, id included: a revision clash
    // forks the edit into a conflict draft under a NEW id, so keeping the old
    // `?definition=` would leave the inspector on the row the user did not
    // change.
    selectEnvelope(saved)
    // A revision clash does not fail — `saveDraft` forks the edit into its own
    // conflict draft under a new id. Say so, rather than reporting a plain
    // success against a row the user is no longer looking at.
    setMessage(
      saved.id === selected.id
        ? t("messages.draftSaved")
        : t("messages.draftForked", { id: saved.id })
    )
  }

  /** Every published release, so the export dialog can bundle more than one. */
  const releases = useMemo(
    () => definitions.filter((definition) => Boolean(definition.version)),
    [definitions]
  )

  /** The same list, shaped for an instance card's rebind picker. */
  const rebindTargets = useMemo(
    () =>
      releases.map((definition) => ({
        id: definition.id,
        version: definition.version!,
        name: definition.metadata.name,
        domain: definition.domain as string,
      })),
    [releases]
  )

  /**
   * Export, signed when the dialog asked for it.
   *
   * The signer is resolved HERE rather than in the dialog because
   * `createPublisherSigner` creates the key on first use, and a form that
   * writes a key just by being opened is a form that mints one every time
   * somebody looks at the export options.
   */
  const runExport = async (request: TemplateExportRequest) => {
    const { sign, ...rest } = request
    const signer = sign ? await createPublisherSigner() : undefined
    const exported = await runtime.service.exportPackage({
      ...rest,
      ...(signer ? { signer } : {}),
    })
    setExportOrigin(undefined)
    if (signer) setPublisherKeyNonce((value) => value + 1)
    downloadTemplatePackage(exported.bytes, templatePackageFilename(request.id, request.version))
  }

  const verifyPackage = async (key: string) => {
    const report = await runtime.service.verifyPackage(key)
    setPackageReports((prev) => ({ ...prev, [key]: report }))
    setPackages(await runtime.repository.listPackages())
  }

  const yankPackage = async (key: string, yanked: boolean) => {
    await runtime.service.yankPackage(key, yanked)
    setMessage(t(yanked ? "messages.packageYanked" : "messages.packageUnyanked"))
    setPackages(await runtime.repository.listPackages())
  }

  const removePackage = async (key: string) => {
    const removed = await runtime.service.removePackage(key)
    setMessage(t("messages.packageRemoved", removed))
    setPackageReports((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setPackages(await runtime.repository.listPackages())
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  const reexportPackage = async (key: string) => {
    const exported = await runtime.service.reexportPackage(key)
    downloadTemplatePackage(
      exported.bytes,
      templatePackageFilename(exported.manifest.id, exported.manifest.version)
    )
  }

  const rollbackMigration = async (domain: TemplateDomain) => {
    const rolledBack = await runtime.service.rollbackMigration(domain)
    setMessage(t("messages.migrationRolledBack", { count: rolledBack }))
  }

  /**
   * Discard a draft. Only drafts: a release is immutable by construction and
   * `deprecate` is how one is withdrawn.
   */
  const deleteSelectedDraft = async () => {
    if (!selected || (selected.status !== "draft" && selected.status !== "conflict")) return
    await runtime.service.deleteDraft(selected.id)
    route.setDefinitionId(undefined)
    setPinnedEnvelope(undefined)
    setPlan(undefined)
    setMessage(t("messages.draftDeleted"))
  }

  const rebindInstance = async (instanceId: string, definitionId: string, version: string) => {
    await runtime.service.rebindSource(instanceId, definitionId, version)
    setMessage(t("messages.rebound"))
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  const inspectImport = async (file?: File) => {
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    setPublisherTrusted(false)
    setPendingImport({ bytes, inspected: await runtime.service.inspectPackage(bytes) })
    if (importRef.current) importRef.current.value = ""
  }

  /**
   * A package fetched from a URL joins the file picker's flow at the same
   * point. Fetching is not accepting: the fingerprint dialog is where either
   * one is accepted.
   */
  const inspectUrlImport = async (fetched: { bytes: Uint8Array; sourceUrl: string }) => {
    setPublisherTrusted(false)
    setPendingImport({
      bytes: fetched.bytes,
      inspected: await runtime.service.inspectPackage(fetched.bytes),
      sourceUrl: fetched.sourceUrl,
    })
  }

  const confirmImport = async () => {
    if (!pendingImport) return
    await runtime.service.importPackage(pendingImport.bytes, {
      // A package the user fetched from an address is a link import, and the
      // address is what makes it auditable afterwards.
      source: pendingImport.sourceUrl ? "link" : "file",
      confirmed: true,
      ...(pendingImport.sourceUrl ? { sourceUrl: pendingImport.sourceUrl } : {}),
    })
    setPendingImport(undefined)
    setMessage(t("messages.imported"))
  }

  /**
   * Accept the key that signed this package.
   *
   * Writes the same `trustedPublishers` row the WASM plugin installer writes
   * (base64 public key, SHA-256 of its raw bytes, the author name), so one
   * author is one row whichever kind of artifact introduced them. After this
   * the package resolves to `verified-publisher` on import and on every later
   * Verify.
   */
  const trustImportPublisher = async () => {
    const signature = pendingImport?.inspected.manifest.signature
    if (!signature) return
    await trustPublisher({
      publicKey: signature.publicKey,
      fingerprint: await publisherFingerprint(signature.publicKey),
      ...(signature.publisher ? { authorName: signature.publisher } : {}),
    })
    setPublisherTrusted(true)
    setTrustLedgerNonce((value) => value + 1)
  }

  const shelf = route.tab
  const shelfCounts: Partial<Record<TemplateTab, number>> = {
    library: definitions.length,
    drafts: rowsForTab(definitions, "drafts").length,
    published: rowsForTab(definitions, "published").length,
    packages: packages.length,
    instances: instances.length,
  }
  const definitionShelf = DEFINITION_SHELVES.includes(shelf)
  const filtersActive = route.activeFilterCount > 0 || query.length > 0
  const clearFilters = () => route.clearFilters({ includeQuery: true })

  // The search, scope and trust narrow a shelf of definitions; the type is the
  // rail's facet list. Packages and instances have none of these.
  //
  // The query lives in the URL; the header's search keeps its own draft and
  // waits out an IME, so it is bound straight to the route.
  const controls = definitionShelf ? (
    <div className="flex items-center gap-2">
      <Select value={tier} onValueChange={(value) => setTier(value as typeof tier)}>
        <SelectTrigger size="sm" aria-label={t("filters.scope")} className="w-auto min-w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("filters.allScopes")}</SelectItem>
          {TEMPLATE_SCOPE_TIERS.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`scopes.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={trust} onValueChange={(value) => setTrust(value as typeof trust)}>
        <SelectTrigger size="sm" aria-label={t("filters.trust")} className="w-auto min-w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("filters.allTrust")}</SelectItem>
          {(["built-in", "verified-publisher", "signed-unknown", "unsigned"] as const).map(
            (item) => (
              <SelectItem key={item} value={item}>
                {t(`trust.${item}`)}
              </SelectItem>
            )
          )}
        </SelectContent>
      </Select>
      {filtersActive ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="text-muted-foreground"
          data-testid="template-clear-filters"
        >
          <XIcon className="size-3.5" />
          {t("filters.clear")}
        </Button>
      ) : null}
    </div>
  ) : undefined

  // Laid out like /plugins: a plain header naming the shelf you are on, its
  // filters in the second row, and the shelves themselves in the left rail.
  // The floating header card sat over a band of empty page before the tabs.
  const header = (
    <FeaturePageHeader
      icon={<FileArchiveIcon />}
      title={t("title")}
      description={t("description")}
      status={{ label: t(`tabs.${shelf}`), testId: "template-shelf-badge" }}
      search={
        definitionShelf
          ? {
              value: query,
              onChange: setQuery,
              placeholder: t("filters.search"),
              testId: "template-studio-search",
            }
          : undefined
      }
      controls={controls}
      actions={
        platform === "mobile" ? null : (
          <div className="flex items-center gap-2">
            <input
              ref={importRef}
              type="file"
              accept=".cognia-template,application/zip"
              className="hidden"
              onChange={(event) => guard(() => inspectImport(event.target.files?.[0]))()}
            />
            {/* One Import, two sources: a package file or a link. Two
                side-by-side outline buttons for the same verb read as two
                different features. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" data-testid="template-import-menu">
                  <UploadIcon className="size-4" />
                  {t("actions.import")}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  onSelect={() => importRef.current?.click()}
                  data-testid="template-import-file"
                >
                  <UploadIcon className="size-4" />
                  {t("actions.importFile")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setUrlImportOpen(true)}
                  data-testid="template-import-url"
                >
                  <LinkIcon className="size-4" />
                  {t("actions.importUrl")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      }
      // Authoring is desktop-only; the phone body hands it off instead.
      primaryAction={
        platform === "mobile"
          ? undefined
          : {
              id: "new-draft",
              label: t("actions.newDraft"),
              icon: PlusIcon,
              onSelect: () => setCreateOpen(true),
              testId: "template-new-draft",
            }
      }
    />
  )

  const nav = (
    <TemplateNavSidebar
      shelf={shelf}
      // Controlled by `?tab=`. `useTemplateRouteState` has owned `tab` and
      // `setTab` since the phone body landed: the shelf a user is on is
      // something they can send, and `FeaturePageShell` REMOUNTS its subtree
      // at the breakpoint, so this cannot be component state either.
      onSelectShelf={route.setTab}
      counts={shelfCounts}
      facetDefinitions={definitionShelf ? rowsForTab(catalogRows, shelf as DefinitionShelf) : []}
      domain={domain}
      onSelectDomain={setDomain}
    />
  )

  /**
   * The inspector is the shell's right rail rather than a column inside the
   * centre, and it exists only while a template is picked, like the plugin
   * detail: a quarter of the window reserved for "select a template" is a
   * quarter the grid could use. It closes from its own close button.
   */
  const inspector = selected ? (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <TemplateInspector
        definition={selected}
        bindings={bindings}
        setBindings={setBindings}
        plan={plan}
        mobile={platform === "mobile"}
        tier={tierOf(selected)}
        {...(owners[selected.id] !== undefined ? { ownerWorkspaceId: owners[selected.id] } : {})}
        activeWorkspaceId={activeWorkspaceId}
        onSetWorkspace={(workspaceId) => guard(() => setDefinitionWorkspace(workspaceId))()}
        onPreflight={guard(runPreflight)}
        onInstantiate={guard(instantiate)}
        onPublish={guard(openPublish)}
        onSaveDraft={saveDraft}
        onExport={() => setExportOrigin(selected)}
        onFork={guard(forkSelected)}
        derivation={derivation}
        upstream={upstream}
        onReviewUpdate={guard(reviewDerivedUpdate)}
        onDetach={guard(detachDerivation)}
        onDeprecate={guard(() => deprecateSelected("deprecated"))}
        onYank={guard(() => deprecateSelected("yanked"))}
        onDeleteDraft={guard(deleteSelectedDraft)}
        onClose={platform === "mobile" ? undefined : () => route.setDefinitionId(undefined)}
        t={t}
      />
    </div>
  ) : null

  const rows = definitionShelf ? rowsForTab(definitions, shelf as DefinitionShelf) : []

  return (
    <>
      <FeaturePageShell
        storageId="templates"
        header={header}
        centerClassName="gap-4 overflow-y-auto p-4"
        leftPane={{
          label: t("nav.label"),
          content: nav,
          defaultSize: "13rem",
          minSize: "10rem",
          maxSize: "20rem",
        }}
        rightPane={
          inspector
            ? {
                label: t("inspector.label"),
                content: inspector,
                defaultSize: 32,
                minSize: 24,
                maxSize: 48,
                // Controlled, because the centre pane is what selects the row
                // the rail shows. Left uncontrolled, a tap on a phone-width
                // viewport set the selection in a Sheet nobody had opened, so
                // the card read as a dead end.
                open: inspectorOpen,
                onOpenChange: setInspectorOpen,
              }
            : undefined
        }
      >
        <div className="flex flex-col gap-4" data-testid="template-studio">
          {platform === "mobile" ? (
            <Alert>
              <ExternalLinkIcon />
              <AlertTitle>{t("mobile.title")}</AlertTitle>
              <AlertDescription>{t("mobile.description")}</AlertDescription>
            </Alert>
          ) : null}
          {message ? (
            <Alert>
              <CheckCircle2Icon />
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}

          {definitionShelf ? (
            <>
              {/* Columns follow the pane, not the viewport: beside the
                inspector, `xl:grid-cols-3` cut a 530px column into three
                170px cards and wrapped names over three lines. */}
              <div
                className="grid content-start gap-3 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]"
                data-testid="template-studio-grid"
              >
                {rows.map((definition) => {
                  const isSelected = selected?.contentHash === definition.contentHash
                  const scopeTier = tierOf(definition)
                  return (
                    <div
                      key={`${definition.id}@${definition.version ?? definition.revision}`}
                      role="button"
                      tabIndex={0}
                      // Selection was conveyed by a border alone, and Space did
                      // nothing: a `role="button"` that only answers Enter is
                      // half a button to anyone not using a mouse.
                      aria-pressed={isSelected}
                      data-slot="template-card"
                      className={cn(
                        "group flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        isSelected &&
                          "border-primary/60 bg-primary/[0.04] ring-1 ring-primary/40 hover:border-primary/60 hover:bg-primary/[0.06]"
                      )}
                      onClick={() => selectDefinition(definition)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        selectDefinition(definition)
                      }}
                    >
                      {/* Type above the name, not beside it: a "Subscription
                        preset" badge took half the card and wrapped names
                        like "Baichuan AI (百川智能)" over three lines. */}
                      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <TemplateDomainIcon domain={definition.domain} />
                        <span className="min-w-0 flex-1 truncate">
                          {t(`domains.${definition.domain}`)}
                        </span>
                        {/* Published is what a library row normally is; only
                          a state worth acting on earns a badge. It read
                          "Published" on every card in the Library. */}
                        {definition.status === "published" ? null : (
                          <Badge
                            variant={
                              definition.status === "conflict" || definition.status === "yanked"
                                ? "destructive"
                                : "secondary"
                            }
                            className="shrink-0"
                            data-testid="template-card-status"
                          >
                            {t(`status.${definition.status}`)}
                          </Badge>
                        )}
                      </div>
                      <p className="min-w-0 text-sm font-medium leading-snug break-words">
                        {definition.metadata.name}
                      </p>
                      {/* Omitted rather than "No description": the
                        subscription presets have none, and the same
                        placeholder on every one of them is noise. The
                        inspector still says it. */}
                      {definition.metadata.description ? (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {definition.metadata.description}
                        </p>
                      ) : null}
                      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-[11px] text-muted-foreground">
                        {/* Which shelf this came from. Ownership beats
                          provenance, so a built-in you forked into one
                          workspace reads as that workspace's. */}
                        <span data-testid="template-card-scope">{t(`scopes.${scopeTier}`)}</span>
                        {/* Dropped when it would only restate the scope
                          beside it: a built-in is trusted because it is
                          a built-in, so the row read "Built-in Built in". */}
                        {trustRestatesScope(definition.provenance.trust, scopeTier) ? null : (
                          <>
                            <span aria-hidden>·</span>
                            <span data-testid="template-card-trust">
                              {t(`trust.${definition.provenance.trust}`)}
                            </span>
                          </>
                        )}
                        {/* The release only matters once it can differ:
                          every built-in is v1.0.0, and the same string on
                          174 cards said nothing. */}
                        {definition.version && scopeTier !== "builtin" ? (
                          <span className="ms-auto font-mono tabular-nums">
                            v{definition.version}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("empty.noResults")}</p>
                ) : null}
                {/* Say what the workspace is holding back. A library that
                  quietly omits rows reads as one that lost them. */}
                {hiddenCount > 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="template-hidden-count">
                    {t("filters.hiddenHere", { count: hiddenCount })}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
          {shelf === "packages" ? (
            <TemplatePackagesTab
              packages={packages}
              reports={packageReports}
              onVerify={(key) => guard(() => verifyPackage(key))()}
              onYank={(key, yanked) => guard(() => yankPackage(key, yanked))()}
              onRemove={(key) => guard(() => removePackage(key))()}
              onReexport={(key) => guard(() => reexportPackage(key))()}
              onRollbackMigration={(domain) => guard(() => rollbackMigration(domain))()}
              publisherRefreshToken={publisherKeyNonce}
              trustRefreshToken={trustLedgerNonce}
            />
          ) : null}
          {shelf === "instances" ? (
            <div className="space-y-3" data-testid="template-instances">
              {/* An instance records that a template was used in a particular
                  workspace, so the default view is this one. The toggle exists
                  because "where did I instantiate that" is a real question, and
                  answering it by silently omitting rows is not. */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {allWorkspaceInstances
                    ? t("instances.scopeAll", { count: instances.length })
                    : t("instances.scopeCurrent", { count: instances.length })}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAllWorkspaceInstances((value) => !value)}
                  data-testid="template-instances-scope"
                >
                  {allWorkspaceInstances ? t("instances.showCurrent") : t("instances.showAll")}
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {instances.map((instance) => (
                  <TemplateInstanceCard
                    key={instance.id}
                    instance={instance}
                    availableVersions={
                      releasedVersionsByDefinition[instance.source.definitionId] ?? []
                    }
                    rebindTargets={rebindTargets}
                    onPlanUpdate={(id, version) => guard(() => openUpdate(id, version))()}
                    onDetach={(id) => guard(() => detachInstance(id))()}
                    onRebind={(id, definitionId, version) =>
                      guard(() => rebindInstance(id, definitionId, version))()
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </FeaturePageShell>

      <PublishConfirmDialog
        suggestion={publishSuggestion}
        onOpenChange={(open) => (open ? undefined : setPublishSuggestion(null))}
        onConfirm={(bump) => guard(() => publish(bump))()}
      />
      <TemplateDerivedUpdateDialog
        plan={derivedPlan}
        onOpenChange={(open) => !open && setDerivedPlan(undefined)}
        onConfirm={(target, resolutions) => guard(() => applyDerivedUpdate(target, resolutions))()}
      />
      <TemplateUpdateDialog
        plan={updatePlan}
        onOpenChange={(open) => (open ? undefined : setUpdatePlan(undefined))}
        onConfirm={(target, resolutions) => guard(() => applyUpdate(target, resolutions))()}
      />
      <TemplateExportDialog
        origin={exportOrigin}
        releases={releases}
        onOpenChange={(open) => (open ? undefined : setExportOrigin(undefined))}
        onExport={(request) => guard(() => runExport(request))()}
      />
      <InstantiateConfirmDialog
        plan={pendingInstantiate}
        onOpenChange={(open) => (open ? undefined : setPendingInstantiate(undefined))}
        onConfirm={(target) => guard(() => commitInstantiate(target))()}
      />
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("create.title")}</DialogTitle>
            <DialogDescription>{t("create.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template-domain">{t("create.domain")}</Label>
              <Select
                value={draftDomain}
                onValueChange={(value) => setDraftDomain(value as TemplateDomain)}
              >
                <SelectTrigger id="template-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FULL_DOMAINS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`domains.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-name">{t("create.name")}</Label>
              <Input
                id="template-name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-description">{t("create.templateDescription")}</Label>
              <Textarea
                id="template-description"
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={guard(createDraft)} disabled={!draftName.trim()}>
              {t("actions.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingImport)}
        onOpenChange={(open) => !open && setPendingImport(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("import.title")}</DialogTitle>
            <DialogDescription>{t("import.description")}</DialogDescription>
          </DialogHeader>
          {pendingImport ? (
            <div className="space-y-3 text-sm">
              {/* The alarm state was unconditional, so a correctly signed
                  package from a verified publisher looked exactly as dangerous
                  as an unsigned one, and the four trust levels stopped meaning
                  anything. Only the two the app cannot vouch for are alarming. */}
              <Alert
                variant={
                  !publisherTrusted &&
                  (pendingImport.inspected.trust === "unsigned" ||
                    pendingImport.inspected.trust === "signed-unknown")
                    ? "destructive"
                    : "default"
                }
                data-testid="template-import-trust"
                data-trust={publisherTrusted ? "verified-publisher" : pendingImport.inspected.trust}
              >
                {!publisherTrusted &&
                (pendingImport.inspected.trust === "unsigned" ||
                  pendingImport.inspected.trust === "signed-unknown") ? (
                  <AlertTriangleIcon />
                ) : (
                  <CheckCircle2Icon />
                )}
                <AlertTitle>
                  {t(
                    publisherTrusted
                      ? "trust.verified-publisher"
                      : `trust.${pendingImport.inspected.trust}`
                  )}
                </AlertTitle>
                <AlertDescription>{t("import.inert")}</AlertDescription>
              </Alert>
              <p>{pendingImport.inspected.manifest.name}</p>
              <p>
                {t("import.definitionCount", { count: pendingImport.inspected.definitions.length })}
              </p>
              <p className="break-all font-mono text-xs">{pendingImport.inspected.fingerprint}</p>
              {pendingImport.sourceUrl ? (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {pendingImport.sourceUrl}
                </p>
              ) : null}
              {/* A signature this device has never seen is `signed-unknown`
                  forever unless somebody can say "yes, that is the author".
                  `trustedPublishers` had exactly one writer (the WASM plugin
                  installer) and no reader, so a template package could be
                  signed and still had nowhere to become trusted. */}
              {pendingImport.inspected.trust === "signed-unknown" &&
              pendingImport.inspected.manifest.signature &&
              !publisherTrusted ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {t("import.publisher", {
                      publisher: pendingImport.inspected.manifest.signature.publisher,
                    })}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={guard(trustImportPublisher)}
                    data-testid="template-trust-publisher"
                  >
                    {t("import.trustPublisher")}
                  </Button>
                </div>
              ) : null}
              {publisherTrusted ? (
                <p className="text-xs text-muted-foreground" data-testid="template-publisher-added">
                  {t("import.publisherTrusted")}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingImport(undefined)}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={guard(confirmImport)}>{t("actions.confirmImport")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TemplateUrlImportDialog
        open={urlImportOpen}
        onOpenChange={setUrlImportOpen}
        onFetched={inspectUrlImport}
      />
    </>
  )
}

function TemplateInspector({
  definition,
  bindings,
  setBindings,
  plan,
  mobile,
  tier,
  ownerWorkspaceId,
  activeWorkspaceId,
  onSetWorkspace,
  onPreflight,
  onInstantiate,
  onPublish,
  onSaveDraft,
  onExport,
  onFork,
  derivation,
  upstream,
  onReviewUpdate,
  onDetach,
  onDeprecate,
  onYank,
  onDeleteDraft,
  onClose,
  t,
}: {
  definition?: TemplateDefinitionEnvelope
  bindings: Record<string, string>
  setBindings(value: Record<string, string>): void
  plan?: TemplatePreflightPlan
  mobile: boolean
  /** The selected definition's shelf, for the ownership control. */
  tier?: TemplateScopeTier
  /** The workspace that owns it today, absent when it is shared. */
  ownerWorkspaceId?: string
  activeWorkspaceId?: string | null
  onSetWorkspace(workspaceId: string | null): void
  onPreflight(): void
  onInstantiate(): void
  onPublish(): void
  onSaveDraft(edits: {
    name: string
    description: string
    payload: TemplateJson
    inputs: TemplateInputSpec[]
    metadata: TemplateMetadataDraft
  }): Promise<void>
  onExport(): void
  onFork(): void
  derivation?: TemplateDerivation
  upstream?: TemplateDefinitionEnvelope
  onReviewUpdate(): void
  onDetach(): void
  onDeprecate(): void
  onYank(): void
  onDeleteDraft(): void
  /** Deselect, which puts the library summary back in the rail. */
  onClose?(): void
  t: ReturnType<typeof useTranslations<"templateStudio">>
}) {
  if (!definition) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {t("inspector.empty")}
        </CardContent>
      </Card>
    )
  }
  const catalogOnly = !FULL_DOMAINS.includes(definition.domain)
  /**
   * A node group is `domain: "workflow"` but its payload is a subgraph, not a
   * workflow: no `name`, no `nodes` at the top level the workflow adapter
   * expects. Instantiating one routed that payload into `createWorkflow`, which
   * reads `draft.name.trim()` and threw on `undefined`. Its inputs are also
   * auto-derived graph ports (`input:nodeA:default`), all `required`, so
   * preflight blocked until the user typed values for them. It belongs in the
   * workflow editor's own templates tab, and here it reads only.
   */
  const nodeGroup = isWorkflowNodeGroupDefinition(definition)
  const readOnly = catalogOnly || nodeGroup
  // A published release is immutable by construction (`DexieTemplateRepository`
  // refuses to overwrite one), and a catalog-only row is a projection of a
  // store this platform does not own. That leaves drafts — including the
  // conflict drafts a clashing save produces, which are otherwise unreachable.
  const editable =
    !mobile && !readOnly && (definition.status === "draft" || definition.status === "conflict")
  const releasedRelease = Boolean(definition.version && definition.status === "published")
  const draftLike = definition.status === "draft" || definition.status === "conflict"
  const editorRoute = EDITOR_ROUTES[definition.domain]
  // Everything that is not the next step goes behind ⋯: where its editor
  // lives, and the irreversible ones (deprecate, yank, delete), which used to
  // sit in the open as red text beside the everyday buttons.
  const overflow = !mobile && (Boolean(editorRoute) || releasedRelease || draftLike)
  return (
    <div className="flex flex-col gap-5" data-testid="template-inspector">
      <header className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <TemplateDomainIcon domain={definition.domain} />
          <span className="min-w-0 truncate">{t(`domains.${definition.domain}`)}</span>
          {definition.status === "published" ? null : (
            <Badge variant="secondary" className="shrink-0">
              {t(`status.${definition.status}`)}
            </Badge>
          )}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ms-auto size-7 shrink-0 text-muted-foreground"
              onClick={onClose}
              aria-label={t("inspector.close")}
              data-testid="template-inspector-close"
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
        <h2 className="text-base font-semibold leading-snug break-words">
          {definition.metadata.name}
        </h2>
        {definition.metadata.description ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {definition.metadata.description}
          </p>
        ) : (
          // A placeholder, so it should not read at the weight of a real one.
          <p className="text-xs text-muted-foreground/70 italic">{t("empty.noDescription")}</p>
        )}
        {/* Why there is no "Check plan": a note on the template, not a badge
            in the button row, where it read as one more button. */}
        {readOnly ? (
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="template-read-only"
          >
            <LockIcon className="size-3.5 shrink-0" />
            {nodeGroup ? t("inspector.nodeGroup") : t("inspector.readOnly")}
          </p>
        ) : null}
      </header>

      {/* One row, one size: the next step filled, the rest outlined, the
          rest of the verbs in ⋯. Before, a filled pill, ghost text buttons, a
          tinted share button and a lone link wrapped over three rows. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="template-inspector-actions">
        {readOnly ? null : (
          <Button size="sm" variant={plan ? "outline" : "default"} onClick={onPreflight}>
            {t("actions.preflight")}
          </Button>
        )}
        {plan && plan.status !== "blocked" ? (
          <Button size="sm" onClick={onInstantiate}>
            {t("actions.instantiate")}
          </Button>
        ) : null}
        {!mobile && definition.status === "draft" ? (
          <Button size="sm" variant="outline" onClick={onPublish}>
            {t("actions.publish")}
          </Button>
        ) : null}
        {/* `fork` and `deprecate` shipped with no caller anywhere in the app,
            so the only way to base a template on an existing one was to
            create a blank draft and retype it, and a published release could
            never be withdrawn. */}
        {!mobile && !readOnly ? (
          <Button size="sm" variant="outline" onClick={onFork} data-testid="template-fork">
            <GitForkIcon className="size-4" />
            {t("actions.fork")}
          </Button>
        ) : null}
        {!mobile && definition.version ? (
          <Button size="sm" variant="outline" onClick={onExport}>
            <DownloadIcon className="size-4" />
            {t("actions.export")}
          </Button>
        ) : null}
        {/* Published releases only. A draft has no version, so there is
            nothing stable for a recipient to install or cite, and the share
            builder refuses one for exactly that reason. */}
        {!mobile && releasedRelease ? (
          <TemplateDefinitionShareButton definition={definition} size="sm" />
        ) : null}
        {overflow ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                aria-label={t("inspector.moreActions")}
                data-testid="template-inspector-more"
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {editorRoute ? (
                <DropdownMenuItem asChild>
                  <Link href={editorRoute} data-testid="template-open-editor">
                    <ExternalLinkIcon className="size-4" />
                    {t("actions.openEditor")}
                  </Link>
                </DropdownMenuItem>
              ) : null}
              {editorRoute && (releasedRelease || draftLike) ? <DropdownMenuSeparator /> : null}
              {releasedRelease ? (
                <>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={onDeprecate}
                    data-testid="template-deprecate"
                  >
                    <ArchiveIcon className="size-4" />
                    {t("actions.deprecate")}
                  </DropdownMenuItem>
                  {/* Deprecate and yank are the two halves of
                      `setReleaseStatus`, and only the first had a caller: a
                      release that should never be installed again could only
                      be marked superseded. */}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={onYank}
                    data-testid="template-yank"
                  >
                    <BanIcon className="size-4" />
                    {t("actions.yank")}
                  </DropdownMenuItem>
                </>
              ) : null}
              {/* `repository.deleteDraft` was reachable only from the migration
                  rollback path, so a draft made by mistake, or the conflict
                  draft a clashing save forks off, could be edited forever but
                  never removed. */}
              {draftLike ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={onDeleteDraft}
                  data-testid="template-delete-draft"
                >
                  <Trash2Icon className="size-4" />
                  {t("actions.deleteDraft")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {plan ? (
        <Alert variant={plan.status === "blocked" ? "destructive" : "default"}>
          {plan.status === "blocked" ? <AlertTriangleIcon /> : <CheckCircle2Icon />}
          <AlertTitle>{t(`preflight.${plan.status}`)}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {plan.issues.map((issue) => (
                <li key={`${issue.code}:${issue.path ?? ""}`}>{t(`issues.${issue.code}`)}</li>
              ))}
              {plan.operations.map((operation) => (
                <li key={operation.id}>{t(`operations.${operation.kind}`)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {/* The rest is reference, in sections that share one heading style
          and one rule between them, instead of a raised card, a bordered
          box and a text button each drawn their own way. */}
      {definition.inputs.length > 0 ? (
        <InspectorSection title={t("inspector.inputs")}>
          {definition.inputs.map((input) => (
            <TemplateBindingField
              key={input.id}
              input={input}
              value={bindings[input.id] ?? ""}
              onChange={(next) => setBindings({ ...bindings, [input.id]: next })}
            />
          ))}
        </InspectorSection>
      ) : null}
      <TemplateOriginCard
        variant="section"
        derivation={derivation}
        upstream={upstream}
        onReviewUpdate={onReviewUpdate}
        onDetach={onDetach}
        readOnly={mobile || readOnly}
      />
      {/* Ownership, which is a different question from the fork lineage above
            it: where this definition is LISTED, not where it came from.
            Authoring is desktop-only, and so is this. */}
      {!mobile && tier ? (
        <TemplateScopeControl
          variant="section"
          tier={tier}
          {...(ownerWorkspaceId !== undefined ? { ownerWorkspaceId } : {})}
          activeWorkspaceId={activeWorkspaceId}
          onChange={onSetWorkspace}
        />
      ) : null}
      <InspectorSection title={t("inspector.details")}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">{t("inspector.sourceLabel")}</dt>
          <dd className="min-w-0">
            {definition.provenance.source}
            {/* Where a link- or URL-sourced release actually came from.
                `TemplateProvenance.sourceUrl` has been on the type since the
                platform landed and nothing wrote it, so "source: link" could
                not say WHICH link. Now that the import records it, the
                inspector is where it gets read back. */}
            {definition.provenance.sourceUrl ? (
              <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
                {definition.provenance.sourceUrl}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{t("inspector.idLabel")}</dt>
          <dd className="min-w-0 break-all font-mono text-[11px]">
            {definition.id}
            {definition.version ? `@${definition.version}` : ""}
          </dd>
          <dt className="text-muted-foreground">{t("inspector.hashLabel")}</dt>
          <dd className="min-w-0 truncate font-mono text-[11px]" title={definition.contentHash}>
            {definition.contentHash}
          </dd>
        </dl>
      </InspectorSection>
      <Collapsible className="group/collapsible border-t pt-4">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {editable ? t("draftEditor.title") : t("inspector.payload")}
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {editable ? (
            // Keyed on the content hash so selecting another row — or a save
            // landing a new revision — re-seeds the fields instead of leaving
            // the previous draft's text in the box.
            <TemplateDraftEditor
              key={definition.contentHash}
              definition={definition}
              onSave={onSaveDraft}
              t={t}
            />
          ) : (
            <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(definition.payload, null, 2)}
            </pre>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** One inspector section: a rule, a small heading, the content. */
function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Edit a draft's name, description and payload in place.
 *
 * The payload is edited as JSON rather than through a per-domain form: the six
 * full domains each already own a purpose-built editor, and this is the seam
 * that makes a draft mutable at all. Parse failures and the validation errors
 * `saveDraft` raises are rendered here rather than thrown away — a save that
 * silently does nothing is the failure mode this whole component exists to
 * remove.
 */
function TemplateDraftEditor({
  definition,
  onSave,
  t,
}: {
  definition: TemplateDefinitionEnvelope
  onSave(edits: {
    name: string
    description: string
    payload: TemplateJson
    inputs: TemplateInputSpec[]
    metadata: TemplateMetadataDraft
  }): Promise<void>
  t: ReturnType<typeof useTranslations<"templateStudio">>
}) {
  const [name, setName] = useState(definition.metadata.name)
  const [description, setDescription] = useState(definition.metadata.description ?? "")
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(definition.payload, null, 2))
  const [inputs, setInputs] = useState<TemplateInputSpec[]>(() =>
    structuredClone(definition.inputs)
  )
  const [metadata, setMetadata] = useState<TemplateMetadataDraft>(() => {
    const { name: _name, description: _description, ...rest } = definition.metadata
    return {
      metadata: structuredClone(rest),
      dependencies: structuredClone(definition.dependencies),
      capabilities: [...definition.capabilities],
      compatibility: structuredClone(definition.compatibility),
    }
  })
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  /**
   * The tokens the payload actually uses, split by whether anything declares
   * them — recomputed from the TEXT on every keystroke, so the answer tracks
   * what the user is typing rather than the last thing they saved.
   *
   * Null while the JSON is unparseable: mid-edit is not a moment to complain
   * about missing declarations. `listTemplateTokens` is the same classifier
   * `interpolation.unknown` uses on save, so this list cannot disagree with the
   * error the save would produce — including the workflow domain, where a
   * `{{ $node['a'].output }}` expression belongs to the workflow engine and is
   * not an authoring gap at all.
   */
  const tokens = useMemo(() => {
    let payload: TemplateJson
    try {
      payload = JSON.parse(payloadText) as TemplateJson
    } catch {
      return null
    }
    return listTemplateTokens(
      payload,
      new Set(inputs.map((input) => input.id)),
      definition.domain === "workflow"
    )
  }, [payloadText, inputs, definition.domain])

  // Tokens that could become an input, and tokens that could not. Offering to
  // declare something that would then fail the `input.id` check is worse than
  // not offering, so the two are separated and only the first gets a button.
  const declarable = (tokens?.unknown ?? []).filter(isTemplateInputId)
  const undeclarable = (tokens?.unknown ?? []).filter((token) => !isTemplateInputId(token))

  const patchInput = (index: number, patch: Partial<TemplateInputSpec>) =>
    setInputs((prev) =>
      prev.map((input, i) => (i === index ? ({ ...input, ...patch } as TemplateInputSpec) : input))
    )

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t("draftEditor.nameRequired"))
      return
    }
    let payload: TemplateJson
    try {
      payload = JSON.parse(payloadText) as TemplateJson
    } catch {
      setError(t("draftEditor.invalidJson"))
      return
    }
    setError(undefined)
    setSaving(true)
    try {
      await onSave({ name: trimmed, description: description.trim(), payload, inputs, metadata })
    } catch (err) {
      // `saveDraft` refuses an invalid payload and names every reason. Show it
      // verbatim — a generic "save failed" would hide which field is wrong.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 space-y-3" data-testid="template-draft-editor">
      <div className="space-y-1.5">
        <Label htmlFor={`draft-name-${definition.id}`}>{t("draftEditor.name")}</Label>
        <Input
          id={`draft-name-${definition.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`draft-description-${definition.id}`}>{t("draftEditor.description")}</Label>
        <Input
          id={`draft-description-${definition.id}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`draft-payload-${definition.id}`}>{t("draftEditor.payload")}</Label>
        <Textarea
          id={`draft-payload-${definition.id}`}
          className="max-h-64 min-h-40 overflow-auto font-mono text-xs"
          value={payloadText}
          onChange={(event) => setPayloadText(event.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <Label>{t("inputs.title")}</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setInputs((prev) => [...prev, { id: "", label: "", kind: "string", required: true }])
            }
          >
            <PlusIcon className="size-3.5" />
            {t("inputs.add")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("inputs.hint")}</p>
        {inputs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("inputs.none")}</p>
        ) : (
          inputs.map((input, index) => (
            <TemplateInputRow
              key={index}
              input={input}
              t={t}
              onPatch={(patch) => patchInput(index, patch)}
              onRemove={() => setInputs((prev) => prev.filter((_, i) => i !== index))}
            />
          ))
        )}
        {declarable.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {t("inputs.undeclared", { ids: declarable.join(", ") })}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setInputs((prev) => [
                  ...prev,
                  ...declarable.map((id): TemplateInputSpec => ({
                    id,
                    // The id is the only thing the payload told us; a label
                    // that repeats it is honest, and it is one field to fix.
                    label: id,
                    // Required by default: a token in the payload with nothing
                    // behind it is what `interpolation.unknown` was refusing.
                    required: true,
                    kind: "string",
                  })),
                ])
              }
            >
              {t("inputs.declareAll")}
            </Button>
          </div>
        ) : null}
        {undeclarable.length > 0 ? (
          <p className="text-xs text-destructive">
            {t("inputs.undeclarableHint", { ids: undeclarable.join(", ") })}
          </p>
        ) : null}
      </div>
      <TemplateMetadataEditor value={metadata} onChange={setMetadata} />
      {error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button onClick={() => void save()} disabled={saving}>
        {saving ? t("draftEditor.saving") : t("draftEditor.save")}
      </Button>
    </div>
  )
}

/** Every input kind the contract accepts, in the order the editor offers them. */
const INPUT_KINDS = [
  "string",
  "number",
  "boolean",
  "enum",
  "resource",
  "secretRef",
  "twinSlot",
  "model",
  "provider",
  "tool",
  "skill",
  "character",
  "workflow",
] as const

/** The kinds that carry a free-form resource hint rather than a value. */
const RESOURCE_KINDS = new Set<string>([
  "resource",
  "secretRef",
  "twinSlot",
  "model",
  "provider",
  "tool",
  "skill",
  "character",
  "workflow",
])

/**
 * A default value stored as the type its input declares.
 *
 * Every field in this editor is a text box, so without this a `number` input
 * would carry the string `"3"` — the union permits it and no validator objects,
 * which is exactly how a wrongly-typed value survives all the way to whatever
 * consumes it. Applied on kind change too: switching `string` → `number` must
 * not leave prose sitting in a numeric default.
 */
function coerceInputDefault(
  kind: TemplateInputSpec["kind"],
  raw: string | number | boolean | undefined
): string | number | boolean | undefined {
  if (raw === undefined || raw === "") return undefined
  if (kind === "number") {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (kind === "boolean") return raw === true || raw === "true"
  if (kind === "enum" || RESOURCE_KINDS.has(kind)) return undefined
  return String(raw)
}

function TemplateInputRow({
  input,
  onPatch,
  onRemove,
  t,
}: {
  input: TemplateInputSpec
  onPatch(patch: Partial<TemplateInputSpec>): void
  onRemove(): void
  t: ReturnType<typeof useTranslations<"templateStudio">>
}) {
  const options = input.kind === "enum" ? input.options : []
  const defaultValue = "defaultValue" in input ? input.defaultValue : undefined

  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="template-input-row">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-40 font-mono text-xs"
          aria-label={t("inputs.id")}
          value={input.id}
          onChange={(event) => onPatch({ id: event.target.value })}
        />
        <Input
          className="h-8 min-w-0 flex-1"
          aria-label={t("inputs.label")}
          value={input.label}
          onChange={(event) => onPatch({ label: event.target.value })}
        />
        <Select
          value={input.kind}
          onValueChange={(raw) => {
            const kind = raw as TemplateInputSpec["kind"]
            onPatch({
              kind,
              // An enum with no options is refused by `input.enum-options`, so
              // switching to it seeds one empty choice rather than producing a
              // draft that cannot be saved.
              ...(kind === "enum" ? { options: options.length > 0 ? options : [""] } : {}),
              defaultValue: coerceInputDefault(kind, defaultValue),
            } as Partial<TemplateInputSpec>)
          }}
        >
          <SelectTrigger className="h-8 w-36" aria-label={t("inputs.kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INPUT_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`inputKindNames.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox
            checked={input.required}
            onCheckedChange={(checked) => onPatch({ required: checked === true })}
          />
          {t("inputs.required")}
        </label>
        <Button variant="ghost" size="icon" aria-label={t("inputs.remove")} onClick={onRemove}>
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      {input.kind === "enum" ? (
        <Textarea
          className="min-h-16 text-xs"
          aria-label={t("inputs.options")}
          value={options.join("\n")}
          onChange={(event) =>
            onPatch({
              options: event.target.value.split("\n").map((line) => line.trim()),
            } as Partial<TemplateInputSpec>)
          }
        />
      ) : RESOURCE_KINDS.has(input.kind) ? (
        <Input
          className="h-8"
          aria-label={t("inputs.resourceKind")}
          placeholder={t("inputs.resourceKind")}
          value={"resourceKind" in input ? (input.resourceKind ?? "") : ""}
          onChange={(event) =>
            onPatch({ resourceKind: event.target.value || undefined } as Partial<TemplateInputSpec>)
          }
        />
      ) : input.kind === "boolean" ? (
        <Select
          value={defaultValue === undefined ? "" : String(defaultValue)}
          onValueChange={(value) =>
            onPatch({ defaultValue: value === "true" } as Partial<TemplateInputSpec>)
          }
        >
          <SelectTrigger className="h-8 w-36" aria-label={t("inputs.default")}>
            <SelectValue placeholder={t("inputs.default")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">{t("inputs.booleanTrue")}</SelectItem>
            <SelectItem value="false">{t("inputs.booleanFalse")}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          className="h-8"
          type={input.kind === "number" ? "number" : "text"}
          aria-label={t("inputs.default")}
          placeholder={t("inputs.default")}
          value={defaultValue === undefined ? "" : String(defaultValue)}
          onChange={(event) =>
            onPatch({
              defaultValue: coerceInputDefault(input.kind, event.target.value),
            } as Partial<TemplateInputSpec>)
          }
        />
      )}
    </div>
  )
}
