/** @jest-environment node */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "glob"
import ts from "typescript"

const ROOT = join(__dirname, "..", "..")

// Exact call/property inventories require review even when a new bypass is
// added beside an already filtered path. UI loaders, canonical CRUD/import,
// owner export and transport-only plumbing are included, not directory-exempt.
// Their consumers are pinned separately below at the model boundary.
// Dev additions: restart reads only a row's timestamp and writes a static notice;
// room hand-off transcripts retain control parts and marks for decide/delivery;
// catch-up is an explicit owner read; background/room delivery has no personal
// reader. Centralized steer calls still pass through IPC's visibility check.
// Memory additions: the job fence reads only source existence/session identity;
// workflow recall filters through its Host execution reader. Memory tool windows
// filter their exact selected rows and receipt returned evidence before output.
const REVIEWED_SITES: Record<string, string> = {
  "cli/src/agent/cli-host-runtime.ts": "complete:1",
  "cli/src/agent/external-agent-session.ts":
    "prepareCliPersonalHistory:2;resume:externalSessionId:8;steerSession:1",
  "cli/src/agent/external-session-link.ts": "resume:externalSessionId:1",
  "cli/src/agent/personal-history.ts":
    "prepareCliPersonalMessages:1;preparePersonalHistory:1;readTranscript:1;resume:forkFromSessionId:1;resume:initialConversation:1;resume:resumeSessionId:1;withholdForReaders:1",
  "cli/src/agent/rpc/runtime-service.ts": "steerSession:1",
  "cli/src/agent/run.ts": "resume:sdkSessionId:1",
  "cli/src/agent/session-runner.ts":
    "prepareCliPersonalHistory:3;readTranscriptTail:1;restoreRuntimeHistory:1;resume:initialConversation:3;resume:resumeSessionId:6;resume:runtimeHistory:5;resume:sdkSessionId:11",
  "cli/src/agent/session-store/legacy.ts": "resume:sdkSessionId:2",
  "cli/src/agent/tool-host/mcp-status.ts": "resume:externalSessionId:1",
  "cli/src/agent/transcript.ts": "iterTranscriptEntries:2",
  "cli/src/api/generated/command-index.ts":
    "resume:externalSessionId:6;resume:forkFromSessionId:2;resume:resumeSessionId:2;resume:sdkSessionId:5",
  "cli/src/cli/handoff-cmd.ts":
    "buildHandoffContext:2;complete:1;prepareCliPersonalMessages:1;prepareHandoffContext:1;readTranscript:3",
  "cli/src/cli/run-command.ts": "resume:sdkSessionId:2",
  "cli/src/tui/clipboard-image.ts": "complete:1",
  "cli/src/tui/components/App.tsx": "iterTranscriptEntries:1",
  "cli/src/tui/components/app/use-apply-effect.ts": "resumeSession:1",
  "cli/src/tui/components/sessions-list.ts": "iterTranscriptEntries:1",
  "cli/src/tui/input/ai-complete.ts": "complete:2",
  "cli/src/tui/input/inline-suggest.ts": "readTranscript:1;withholdForReaders:1",
  "cli/src/tui/runtime/export-controller.ts": "readTranscript:1",
  "cli/src/tui/runtime/plan-controller.ts": "prepareCliPersonalMessages:1",
  "cli/src/twin/context-client.ts": "withholdForReaders:1",
  "components/agent-builder/agent-builder-chat.tsx": "listMessages:1",
  "components/agent/external-agent/goose-session-controls.tsx": "resume:externalSessionId:1",
  "components/agent/external-agent/manager.tsx": "resumeSession:1",
  "components/agent/external-agent/session-panel.tsx":
    "compactSession:2;resume:externalSessionId:1",
  "components/chat/chat-view.tsx": "listMessages:2",
  "components/chat/companion-transcript-messages.tsx": "stored-message-read:1",
  "components/chat/message-parts/compact-boundary-part.tsx": "restoreSession:1",
  "components/chat/session-settings-sheet.tsx": "resume:sdkSessionId:2",
  "components/chat/shared-session-panel.tsx": "stored-message-read:2",
  "components/context-workbench/resource-workbench-chat-panel.tsx": "listMessages:1",
  "components/execution/run-im-origin.tsx": "stored-message-read:1",
  "components/settings/agent-runtime/sdk-bound-conversations.ts": "resume:sdkSessionId:5",
  "components/settings/agent-runtime/sdk-session-manager.tsx": "resume:sdkSessionId:6",
  "components/settings/agent-runtime/tabs/sessions-tab.tsx": "resume:sdkSessionId:4",
  "components/settings/agent-runtime/tabs/sidecar-tab.tsx": "resume:sdkSessionId:2",
  "components/workflow/editor/right-sidebar/chat-tab.tsx": "listMessages:1",
  "hooks/agent/use-external-agent-models.ts": "resume:externalSessionId:2",
  "hooks/agent/use-external-agent.ts": "compactSession:1;resumeSession:1",
  "hooks/analysis/use-session-report.ts": "listMessages:1",
  "hooks/canvas/use-canvas-suggestions.ts": "generateObject:1",
  "hooks/chat/claude-chat-events.ts": "listMessages:1;resume:sdkSessionId:1",
  "hooks/chat/claude-chat-send-options.ts":
    "convertToModelMessages:1;listMessages:2;preparePersonalHistory:4;renderBranchSeed:1;resume:expectedRuntimeSessionId:3;resume:forkFromSessionId:5;resume:forkedFromSdkSessionId:1;resume:initialConversation:4;resume:resumeSessionId:5;resume:sdkSessionId:9",
  "hooks/chat/claude-chat-turn-tasks.ts": "prepareOwnerHistory:2",
  "hooks/chat/use-claude-chat-controller.ts":
    "buildHandoffContext:1;compactSession:1;listMessages:5;prepareHandoffContext:1;preparePersonalDerivedHistory:3;preparePersonalHistory:10;renderTranscript:2;resume:externalSessionId:6;resume:forkFromSessionId:2;resume:forkedFromSdkSessionId:2;resume:initialConversation:1;resume:resumeSessionId:4;resume:sdkSessionId:2;steerSession:1;stored-message-read:1",
  "hooks/chat/use-composer-ghost-text.ts": "complete:2;prepareOwnerHistory:1",
  "hooks/chat/use-conversation-summary-draft.ts":
    "preparePersonalHistory:1;renderConversationSegments:1",
  "hooks/chat/use-follow-up-suggestions.ts": "prepareOwnerHistory:1",
  "hooks/chat/use-session-desktop-handoffs.ts": "listMessages:1",
  "hooks/chat/use-sessions.ts": "listMessages:2",
  "hooks/connectors/use-history-hydration.ts": "stored-message-read:1",
  "hooks/data/use-remote-session-stream.ts": "listMessages:2",
  "lib/a2ui/from-execution/enhance.ts": "complete:1",
  "lib/account-sync/data/tables.ts": "resume:forkedFromSdkSessionId:1;resume:sdkSessionId:1",
  "lib/agent/composition/verified-fresh-agent.ts": "resume:resumeSessionId:1",
  "lib/agent/plan/planner.ts": "complete:2;preparePersonalDerivedHistory:1",
  "lib/agent/plan/step-dispatch.ts": "preparePersonalDerivedHistory:1",
  "lib/agent/thread-browser.ts": "listMessages:1",
  "lib/ai/agent/agent-executor.ts":
    "complete:2;resume:sdkSessionId:2;streamText:1;withholdForReaders:1",
  "lib/ai/agent/execution/agent-execution-handle.ts": "compactSession:1;steerSession:1",
  "lib/ai/agent/external/manager.ts": "compactSession:1;resumeSession:2",
  "lib/ai/agent/external/runtimes/remote/remote-execute.ts": "resume:externalSessionId:4",
  "lib/ai/agent/external/runtimes/remote/remote-run-client.ts": "resume:externalSessionId:5",
  "lib/ai/agent/external/runtimes/remote/remote-run-service.ts": "resume:externalSessionId:24",
  "lib/ai/agent/external/session/chat-decision-bridge.ts": "resume:externalSessionId:4",
  "lib/ai/agent/recovery/reconcile-crashed-runs.ts": "resume:sdkSessionId:11",
  "lib/ai/chat/sdk-event-mapper.ts": "resume:sdkSessionId:6",
  "lib/ai/chat/standalone-engine.ts":
    "complete:1;convertToModelMessages:1;preparePersonalHistory:3;resume:sdkSessionId:1",
  "lib/ai/eval/browser-execution.ts":
    "complete:1;personalEvalCaseForRun:2;personalEvalSampleForRun:1;preparePersonalDerivedHistory:2",
  "lib/ai/eval/calibration/runner.ts": "preparePersonalDerivedHistory:1",
  "lib/ai/eval/service.ts":
    "personalEvalCaseForRun:3;personalEvalSampleForRun:1;preparePersonalDerivedHistory:2;preparePersonalHistory:1",
  "lib/ai/eval/targets/chat.ts":
    "personalEvalSampleForRun:1;preparePersonalDerivedHistory:1;preparePersonalHistory:1",
  "lib/ai/eval/targets/model.ts": "generateText:1",
  "lib/ai/eval/targets/team.ts": "personalEvalSampleForRun:1",
  "lib/ai/eval/targets/workflow.ts": "personalEvalSampleForRun:1",
  "lib/ai/eval/trace-prompt.ts": "listMessages:1",
  "lib/ai/generation/canvas-actions.ts": "generateText:1;streamText:1",
  "lib/ai/generation/run-title-task.ts": "prepareOwnerDerivedHistory:1",
  "lib/ai/generation/summarize-material.ts": "complete:1",
  "lib/ai/generation/summarizer.ts": "renderConversationSegments:1",
  "lib/ai/generation/template-assist.ts": "generateObject:2;generateText:1",
  "lib/ai/generation/title.ts": "complete:1",
  "lib/ai/generation/turn-label.ts": "complete:1",
  "lib/ai/ledgered-generation-seam.ts": "complete:1",
  "lib/ai/operations/handlers/ai-sdk-surface.ts": "generateObject:1;generateText:1;streamText:1",
  "lib/ai/providers/bedrock-connection.ts": "generateText:1",
  "lib/ai/providers/host-connection.ts": "complete:1",
  "lib/ai/routing/difficulty-judge.ts": "complete:1",
  "lib/background-tasks/host-delivery-lane.ts": "listMessages:1;preparePersonalDerivedHistory:1",
  "lib/best-of-n/projection.ts": "stored-message-read:1",
  "lib/best-of-n/runtime.ts": "complete:1",
  "lib/boot/startup-recovery.ts": "complete:1",
  "lib/browser-companion/host-dispatch.ts": "stored-message-read:1",
  "lib/chat/attached-session.ts":
    "listMessages:2;prepareOwnerHistory:1;preparePersonalHistory:1;renderBranchSeed:2",
  "lib/chat/branch-session.ts":
    "renderBranchSeed:1;renderTranscript:2;resume:forkedFromSdkSessionId:1;resume:sdkSessionId:2;stored-message-read:1",
  "lib/chat/branch-whole-conversation.ts": "listMessages:1",
  "lib/chat/completion/enhance.ts": "complete:2",
  "lib/chat/completion/inline/ai-provider.ts": "complete:1;resolveRecentMessages:1",
  "lib/chat/completion/suggestions.ts": "complete:2",
  "lib/chat/dispatch-to-codex-app.ts":
    "buildHandoffContext:2;listMessages:1;preparePersonalDerivedHistory:1;preparePersonalHistory:1;resume:sdkSessionId:1",
  "lib/chat/handoff-context.ts": "buildHandoffContext:2",
  "lib/chat/import-handoff-session.ts": "buildHandoffContext:1;stored-message-read:1",
  "lib/chat/mentions/entity-sources.ts": "preparePersonalDerivedHistory:1;stored-message-read:1",
  "lib/chat/mentions/entity-transcript.ts": "preparePersonalHistory:1",
  "lib/chat/mentions/message-reference.ts": "preparePersonalHistory:3;stored-message-read:4",
  "lib/chat/mentions/prompt-reference.ts": "preparePersonalHistory:2;stored-message-read:2",
  "lib/chat/mentions/result-reference.ts": "preparePersonalHistory:1;stored-message-read:1",
  "lib/chat/mirror-truncate.ts": "stored-message-read:1",
  "lib/chat/room/runner.ts":
    "complete:1;listMessages:13;preparePersonalDerivedHistory:2;preparePersonalHistory:2",
  "lib/chat/selection/message-excerpt.ts": "stored-message-read:1",
  "lib/chat/selection/run-selection-action.ts":
    "complete:1;preparePersonalHistory:1;renderConversationSegments:1;stored-message-read:1",
  "lib/chat/session-aside-context.ts": "resume:sdkSessionId:1",
  "lib/chat/turn-route/history.ts":
    "buildHandoffContext:1;prepareHandoffContext:1;preparePersonalHistory:1",
  "lib/chat/working-set.ts": "stored-message-read:1",
  "lib/claude/agents/dispatch-agent-handler.ts": "preparePersonalDerivedHistory:1",
  "lib/claude/build-options.ts":
    "preparePersonalDerivedHistory:1;preparePersonalHistory:2;resume:forkFromSessionId:2;resume:forkedFromSdkSessionId:6;resume:resumeSessionId:2;resume:sdkSessionId:4;withPersonalMemoryVisibility:1;withPersonalRerankerVisibility:1",
  "lib/claude/ipc.ts":
    "listMessages:1;preparePersonalHistory:1;resume:expectedRuntimeSessionId:2;resume:forkFromSessionId:1;resume:initialConversation:6;resume:resumeSessionId:1",
  "lib/claude/permissions/command-judge.ts": "complete:1",
  "lib/claude/run-and-capture.ts":
    "resume:externalSessionId:1;resume:resumeSessionId:1;resume:sdkSessionId:7",
  "lib/claude/team-primary-router.ts": "complete:1",
  "lib/cli-bridge/handlers/twin-context.ts":
    "preparePersonalHistory:2;withPersonalRerankerVisibility:1",
  "lib/collab/shared-chat-sync.ts": "stored-message-read:1",
  "lib/collab/shared-reference-scan.ts": "stored-message-read:2",
  "lib/collab/shared-room-catch-up.ts": "complete:1;prepareOwnerHistory:1",
  "lib/collab/shared-run-coordinator.ts": "listMessages:1",
  "lib/companion/desktop-message-source.ts": "preparePairedOwnerHistory:3;stored-message-read:7",
  "lib/companion/desktop-write-source.ts": "resume:externalSessionId:3",
  "lib/connectors/adapters/lark/run-presentation/driver.ts": "complete:1",
  "lib/connectors/automation-control.ts": "complete:1",
  "lib/connectors/bus.ts": "stored-message-read:8",
  "lib/connectors/history-recovery.ts": "stored-message-read:1",
  "lib/connectors/inbox-writes/local.ts": "stored-message-read:1",
  "lib/connectors/message-placement.ts": "stored-message-read:1",
  "lib/connectors/room/im-room-delivery-lane.ts": "preparePersonalDerivedHistory:1",
  "lib/connectors/runtime.ts":
    "preparePersonalDerivedHistory:1;preparePersonalHistory:2;resume:forkedFromSdkSessionId:1;resume:sdkSessionId:8;stored-message-read:8",
  "lib/connectors/session-bindings.ts": "stored-message-read:4",
  "lib/context-workbench/aside-context-dispatch.ts": "resume:sdkSessionId:1",
  "lib/data/apply-package.ts": "stored-message-read:1",
  "lib/data/import-merge.ts": "stored-message-read:2",
  "lib/db/chat-search-text.ts": "stored-message-read:1",
  "lib/db/connector-inbound-jobs.ts": "stored-message-read:1",
  "lib/db/memory-governance.ts": "stored-message-read:1",
  "lib/db/messages.ts": "stored-message-read:15",
  "lib/db/mobile-outbound-queue.ts": "stored-message-read:1",
  "lib/db/plugin-bridge.ts": "stored-message-read:6",
  "lib/db/resource-workbench-sessions.ts": "resume:forkedFromSdkSessionId:1;resume:sdkSessionId:3",
  "lib/db/sessions.ts": "resume:forkedFromSdkSessionId:2;resume:sdkSessionId:6",
  "lib/dev/expose-test-globals.tsx": "stored-message-read:1",
  "lib/execution/personal-visibility.ts":
    "prepareOwnerDerivedHistory:1;prepareOwnerHistory:2;preparePairedOwnerHistory:1;preparePersonalHistory:2;resume:forkedFromSdkSessionId:1;resume:sdkSessionId:1;stored-message-read:1;withholdForReaders:1",
  "lib/execution/promote-to-pane.ts": "listMessages:1",
  "lib/execution/run-retrospective.ts": "complete:1",
  "lib/execution/steer.ts": "steerSession:1",
  "lib/export/batch/batch-export.ts": "listMessages:1",
  "lib/external-services/sync/core.ts": "complete:1",
  "lib/files-library/sources.ts": "stored-message-read:1",
  "lib/fleet/acp-fleet-projection.ts": "resume:externalSessionId:3",
  "lib/gateway/runtime-bridge.ts": "generateText:1",
  "lib/git/ai-commit.ts": "complete:1",
  "lib/git/ai-explain.ts": "complete:1",
  "lib/git/ai-review.ts": "complete:1",
  "lib/goal/judge.ts": "complete:1",
  "lib/goal/subgoals.ts": "complete:1",
  "lib/harness/runtime/model-call.ts": "complete:1",
  "lib/headless/person-agent/index.ts":
    "listMessages:1;preparePersonalHistory:1;renderTranscript:1",
  "lib/headless/person-restart.ts": "stored-message-read:1",
  "lib/inbox/manual-send.ts": "stored-message-read:1",
  "lib/integrations/events.ts": "listMessages:1",
  "lib/island/owner.ts": "resume:externalSessionId:2",
  "lib/issues/ai-issue-assist.ts": "complete:5",
  "lib/media/agent-tools.ts": "listMessages:2;preparePersonalHistory:1",
  "lib/memory/agent-tools.ts":
    "preparePersonalDerivedHistory:1;preparePersonalHistory:2;stored-message-read:6",
  "lib/memory/backfill/backfill-service.ts": "listMessages:1;preparePersonalHistory:1",
  "lib/memory/lifecycle/job-worker.ts": "listMessages:1;preparePersonalHistory:1",
  "lib/memory/lifecycle/revalidate-claim.ts": "stored-message-read:3",
  "lib/memory/runtime/build-deps.ts": "preparePersonalHistory:1;stored-message-read:2",
  "lib/memory/write/run-episodic-distill.ts": "complete:1",
  "lib/memory/write/run-memory-extraction.ts": "withPersonalMemoryVisibility:1",
  "lib/memory/write/run-project-mining.ts": "withPersonalMemoryVisibility:1",
  "lib/perf/operation-performance.ts": "complete:4",
  "lib/pet/bubbles/speak.ts": "complete:2",
  "lib/pet/soul/generate-soul.ts": "complete:1",
  "lib/plugin/agent-sdk/context-providers.ts":
    "filterSharedMemoryEntriesForRun:1;preparePersonalHistory:2;withPersonalRerankerVisibility:1",
  "lib/plugin/agent-sdk/session.ts": "listMessages:2;preparePersonalHistory:2",
  "lib/plugin/api/agent-turn.ts": "resume:sdkSessionId:1;stored-message-read:5",
  "lib/plugin/api/external-agent-api.ts": "resumeSession:1",
  "lib/plugin/bridge/ai-providers-bridge.ts": "complete:1",
  "lib/plugin/bridge/sync-bridge.ts": "complete:1",
  "lib/plugin/core/manager.ts": "complete:1",
  "lib/plugin/runtime/renderer-host-runtime.ts": "streamText:1",
  "lib/plugin/vscode-shim/chat-turn.ts":
    "listMessages:1;preparePersonalHistory:3;resume:sdkSessionId:1",
  "lib/project-coordinator/agent-tools.ts":
    "listMessages:1;preparePersonalDerivedHistory:1;preparePersonalHistory:1",
  "lib/project-coordinator/continue-as-project.ts":
    "buildHandoffContext:1;listMessages:1;preparePersonalDerivedHistory:1;preparePersonalHistory:1",
  "lib/provider-diagnostics/benchmark.ts": "streamText:1",
  "lib/radar/generate.ts": "complete:1",
  "lib/reply-copilot/draft-candidates.ts": "complete:1",
  "lib/reply-copilot/load-context.ts": "prepareOwnerHistory:1;withPersonalMemoryVisibility:1",
  "lib/router-fusion/api/run-api-host.ts": "listMessages:1",
  "lib/router-fusion/calls/role-call-executor.ts": "generateText:1;streamText:1",
  "lib/router-fusion/db/outbox-appliers.ts": "stored-message-read:1",
  "lib/router-fusion/gate/utility-ledger.ts": "complete:2",
  "lib/router-fusion/routing/llm-classifier.ts": "complete:1",
  "lib/scm/review/review-agent.ts": "complete:1",
  "lib/session-import/codec-types.ts": "resume:sdkSessionId:2",
  "lib/session-import/index.ts": "buildHandoffContext:1",
  "lib/session-import/native-resume.ts": "resumeSession:1",
  "lib/session-import/to-parts.ts": "buildHandoffContext:1",
  "lib/skills/recording/controller.ts": "prepareOwnerDerivedHistory:1",
  "lib/skills/recording/generate-skill.ts": "complete:1",
  "lib/skills/session-suggestion.ts":
    "listMessages:1;prepareOwnerDerivedHistory:1;prepareOwnerHistory:1",
  "lib/slash-commands/actions/diagnostics.ts": "compactSession:1;resume:sdkSessionId:2",
  "lib/squads/agent-team-runtime-deps.ts": "visibleTeamDerivedTextForTeam:2",
  "lib/squads/auto/assess-routing.ts": "complete:1",
  "lib/squads/auto/clarify-objective.ts": "complete:1",
  "lib/squads/auto/compose-roster.ts": "complete:1",
  "lib/squads/auto/decompose-tasks.ts": "complete:1",
  "lib/squads/collaboration-tools.ts":
    "filterSharedMemoryEntriesForRun:1;preparePersonalDerivedHistory:1",
  "lib/squads/delegation-orchestrator.ts": "preparePersonalDerivedHistory:1",
  "lib/squads/durable/replan-checkpoint.ts": "readDependencyResultsForRun:1",
  "lib/squads/ledger/progress-ledger.ts": "readDependencyResultsForRun:1",
  "lib/squads/memory/shared-memory-orchestrator.ts":
    "filterSharedMemoryEntriesForRun:1;preparePersonalDerivedHistory:1",
  "lib/squads/room-handoff/decide.ts": "preparePersonalDerivedHistory:1",
  "lib/squads/room-handoff/transcript.ts": "listMessages:1",
  "lib/squads/team-run-context.ts": "preparePersonalDerivedHistory:2;visibleTeamDerivedText:1",
  "lib/squads/teammate/child-controls.ts": "steerSession:2",
  "lib/squads/teammate/dispatch-teammate.ts":
    "complete:2;steerSession:1;visibleTeamDerivedText:2;visibleTeamTurn:3",
  "lib/squads/teammate/twin-context.ts":
    "preparePersonalHistory:1;withPersonalRerankerVisibility:1",
  "lib/squads/workflow-nodes/index.ts": "readDependencyResultsForRun:1;visibleTeamDerivedText:1",
  "lib/squads/workflow-nodes/team-ops.ts": "preparePersonalDerivedHistory:1",
  "lib/sync/desktop-sync-source.ts": "preparePairedOwnerHistory:3;stored-message-read:6",
  "lib/sync/handlers/messages.ts": "stored-message-read:1",
  "lib/sync/host-state-service.ts": "listMessages:1;prepareOwnerHistory:1;stored-message-read:6",
  "lib/sync/host-state-store.ts": "stored-message-read:4",
  "lib/sync/session-history.ts": "stored-message-read:1",
  "lib/tasks/spawn-task-dispatch.ts": "listMessages:2;preparePersonalHistory:1;renderBranchSeed:1",
  "lib/terminal/ai-shell/error-advisor.ts": "complete:1",
  "lib/terminal/ai-shell/plan-generator.ts": "complete:1",
  "lib/terminal/completion/ai-provider.ts": "complete:1",
  "lib/thread-handoff/orchestrator.ts": "listMessages:1;resume:sdkSessionId:4",
  "lib/thread-handoff/service.ts": "resume:sdkSessionId:1",
  "lib/twin/distill/agents/entity-merge-agent.ts": "complete:1",
  "lib/twin/distill/agents/evaluator.ts": "complete:1",
  "lib/twin/distill/agents/knowledge-agent.ts": "complete:1",
  "lib/twin/distill/agents/playbook-agent.ts": "complete:1",
  "lib/twin/distill/agents/style-agent.ts": "complete:1",
  "lib/twin/distill/agents/synthesizer.ts": "complete:1",
  "lib/twin/distill/llm.ts": "generateText:1;streamText:1",
  "lib/twin/job-worker.ts": "complete:1",
  "lib/twin/runtime/reranker.ts": "complete:1",
  "lib/voice/live/persist-turns.ts": "listMessages:1",
  "lib/voice/live/runtime-bindings.ts": "listMessages:2;prepareOwnerHistory:1",
  "lib/web/web-tools-core.ts": "complete:1",
  "lib/wiki/agents/index-page-agent.ts": "complete:1",
  "lib/wiki/agents/module-article-agent.ts": "complete:1",
  "lib/work-submission/paired-turn-adapter.ts": "stored-message-read:1",
  "lib/workflow/nodes/actions/memory-recall.ts": "withPersonalMemoryVisibility:1",
  "lib/workflow/nodes/ai/ai-prompt-routed.ts": "complete:3",
  "lib/workflow/nodes/ai/ai-prompt-v2.ts": "complete:1",
  "lib/workflow/nodes/ai/executors.ts": "complete:1",
  "lib/workflow/nodes/sessions/index.ts":
    "listMessages:4;preparePersonalDerivedHistory:1;preparePersonalHistory:3",
  "lib/workflow/nodes/teams/index.ts": "listMessages:1",
  "packages/agent-acp/src/isolated-adapter.ts": "compactSession:1;resumeSession:1",
  "packages/agent-crush/src/events.ts": "stored-message-read:2",
  "packages/agent-opencode/src/client.ts": "getSessionMessages:1",
  "packages/agent-opencode/src/v2-auth.ts": "complete:1",
  "packages/agent-opencode/src/v2-client.ts": "resumeSession:1",
  "packages/agent-pi/src/rpc-client.ts": "resumeSession:3",
  "packages/document/src/parsers/csv-parser.ts": "generateText:1",
  "packages/eval-core/src/scorers/judge.ts": "complete:1",
  "packages/eval-core/src/scorers/rag.ts": "complete:1",
  "packages/memory/src/consolidate/consolidator.ts": "complete:1",
  "packages/memory/src/extract/extractor.ts": "complete:1",
  "packages/memory/src/extract/project-extractor.ts": "complete:1",
  "packages/memory/src/retrieve/llm-rerank.ts": "complete:1",
  "packages/provider-embedding/src/chunking.ts": "generateText:1",
  "packages/rag/src/answer-grounding.ts": "generateText:1",
  "packages/rag/src/contextual-retrieval.ts": "generateText:2",
  "packages/rag/src/query-expansion.ts": "generateText:5",
  "packages/rag/src/rag-evaluator.ts": "generateText:1",
  "packages/rag/src/reranker.ts": "generateText:1",
  "packages/rag/src/retrieval-grader.ts": "generateText:1",
  "plugins/config-governance/src/runtime/adherence.ts": "complete:1",
  "plugins/config-governance/src/runtime/audit.ts": "complete:2",
  "sidecar/src/host/commands/send.ts":
    "resume:expectedRuntimeSessionId:2;resume:forkFromSessionId:1;resume:initialConversation:7;resume:resumeSessionId:1;resume:sdkSessionId:1",
  "sidecar/src/host/control/handle.ts": "resume:sdkSessionId:3",
  "sidecar/src/host/sessions/lifecycle.ts": "restoreConversation:1;resume:initialConversation:1",
  "sidecar/src/runtimes/ai-sdk/events.ts": "resume:sdkSessionId:6",
  "sidecar/src/runtimes/ai-sdk/index.ts":
    "restoreConversation:2;resume:initialConversation:2;resume:sdkSessionId:4",
  "sidecar/src/runtimes/claude-agent-sdk/options.ts":
    "resume:forkFromSessionId:2;resume:resumeSessionId:1",
  "sidecar/src/runtimes/claude-agent-sdk/pump.ts": "resume:sdkSessionId:1",
  "sidecar/src/runtimes/claude-agent-sdk/session-api.ts": "getSessionMessages:1",
  "sidecar/src/runtimes/claude-agent-sdk/warm-pool.ts":
    "resume:forkFromSessionId:1;resume:resumeSessionId:1",
  "sidecar/src/shared/pending.ts": "complete:1",
}

const HISTORY_CALLS = new Set([
  "listMessages",
  "getSessionMessages",
  "compactSession",
  "restoreSession",
  "steerSession",
  "readTranscript",
  "readTranscriptTail",
  "iterTranscriptEntries",
  "readSessionMessages",
  "convertToModelMessages",
  "renderBranchSeed",
  "renderTranscript",
  "renderConversationSegments",
  "buildHandoffContext",
  "prepareHandoffContext",
  "resolveRecentMessages",
  "streamText",
  "generateText",
  "streamObject",
  "generateObject",
  "complete",
  "preparePersonalHistory",
  "preparePersonalDerivedHistory",
  "prepareOwnerHistory",
  "prepareOwnerDerivedHistory",
  "preparePairedOwnerHistory",
  "withholdForReaders",
  "prepareCliPersonalHistory",
  "prepareCliPersonalMessages",
  "withPersonalMemoryVisibility",
  "withPersonalRerankerVisibility",
  "visibleTeamDerivedText",
  "visibleTeamDerivedTextForTeam",
  "visibleTeamTurn",
  "readDependencyResultsForRun",
  "filterSharedMemoryEntriesForRun",
  "personalEvalCaseForRun",
  "personalEvalSampleForRun",
])
const RESUME_KEYS = new Set([
  "resumeSessionId",
  "forkFromSessionId",
  "forkedFromSdkSessionId",
  "expectedRuntimeSessionId",
  "sdkSessionId",
  "externalSessionId",
  "runtimeHistory",
  "initialConversation",
])
const RESUME_CALLS = new Set(["resumeSession", "restoreRuntimeHistory", "restoreConversation"])

function contextSites(text: string): string {
  const source = ts.createSourceFile("boundary.ts", text, ts.ScriptTarget.Latest, true)
  const counts: Record<string, number> = {}
  const aliases = new Map<string, string>()
  const tables = new Set<string>()
  const name = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    )
      return node.argumentExpression.text
    return undefined
  }
  const isTable = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return tables.has(node.text)
    if (ts.isPropertyAccessExpression(node))
      return node.name.text === "messages" || isTable(node.expression)
    if (ts.isElementAccessExpression(node))
      return name(node) === "messages" || isTable(node.expression)
    if (ts.isCallExpression(node))
      return (
        isTable(node.expression) ||
        (name(node.expression) === "table" &&
          node.arguments.some((a) => ts.isStringLiteral(a) && a.text === "messages"))
      )
    return false
  }
  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const original = name(node.initializer)
        if (original) aliases.set(node.name.text, original)
        if (isTable(node.initializer)) tables.add(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements)
          if (ts.isIdentifier(element.name))
            aliases.set(
              element.name.text,
              element.propertyName?.getText(source).replace(/["']/g, "") ?? element.name.text
            )
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  const add = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const called = name(node.expression)
      if (called && (HISTORY_CALLS.has(called) || RESUME_CALLS.has(called))) add(called)
      if (
        called &&
        ["toArray", "first", "get", "bulkGet"].includes(called) &&
        isTable(node.expression)
      )
        add("stored-message-read")
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      RESUME_KEYS.has(name(node) ?? "")
    )
      add(`resume:${name(node)}`)
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = node.name.getText(source).replace(/["']/g, "")
      if (RESUME_KEYS.has(key)) add(`resume:${key}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return Object.keys(counts)
    .sort()
    .map((key) => `${key}:${counts[key]}`)
    .join(";")
}

function sources() {
  return globSync("{components,hooks,lib,packages,plugins,stores,cli,sidecar/src}/**/*.{ts,tsx}", {
    cwd: ROOT,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/__tests__/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/*.d.ts",
    ],
  }).sort()
}

it("requires review for each added stored-history, model-context or engine-resume boundary", () => {
  const actual: Record<string, string> = {}
  for (const file of sources()) {
    const sites = contextSites(readFileSync(join(ROOT, file), "utf8"))
    if (sites) actual[file] = sites
  }
  expect(actual).toEqual(REVIEWED_SITES)
})

it("detects new paths, aliases, table aliases and retained-memory assignments", () => {
  expect(contextSites("import { listMessages as load } from './db'; load('s')")).toBe(
    "listMessages:1"
  )
  expect(contextSites("const {listMessages: load} = deps; load('s'); load('t')")).toBe(
    "listMessages:2"
  )
  expect(contextSites("const rows=db['messages']; rows.toArray()")).toBe("stored-message-read:1")
  expect(contextSites("const load=deps.listMessages; load('s')")).toBe("listMessages:1")
  expect(contextSites("options['resumeSessionId']=oldId; manager.resumeSession(oldId)")).toBe(
    "resume:resumeSessionId:1;resumeSession:1"
  )
  expect(contextSites("streamText({messages: stored})")).toBe("streamText:1")
})

it("keeps the explicit interim owner helper as the only paired history entry", () => {
  for (const file of [
    "lib/sync/desktop-sync-source.ts",
    "lib/companion/desktop-message-source.ts",
  ]) {
    const source = readFileSync(join(ROOT, file), "utf8")
    expect(source).toContain("preparePairedOwnerHistory")
    expect(source).not.toMatch(/\bprepare(?:Personal|Owner)(?:Derived)?History\s*\(/)
    expect(source).toContain("projectPersonalSessionHistory")
  }
  const host = readFileSync(join(ROOT, "lib/execution/personal-visibility.ts"), "utf8")
  expect(host).toContain("SecurityStore::is_owner_device(tenant, device)")
  expect(host).toContain("return prepareOwnerHistory(messages)")
})

function digestComparisonCount(text: string): number {
  const source = ts.createSourceFile("resume.ts", text, ts.ScriptTarget.Latest, true)
  let count = 0
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind
      )
    ) {
      const pair = [node.left.getText(source), node.right.getText(source)]
      if (pair.every((operand) => /[Vv]isibilityDigest/.test(operand))) count++
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

it("requires an actual digest comparison before retaining each engine's opaque memory", () => {
  const engines = [
    "hooks/chat/claude-chat-send-options.ts",
    "lib/claude/ipc.ts",
    "hooks/chat/use-claude-chat-controller.ts",
    "cli/src/agent/session-runner.ts",
    "cli/src/agent/external-agent-session.ts",
    "sidecar/src/host/commands/send.ts",
    "sidecar/src/host/sessions/lifecycle.ts",
    "lib/headless/person-agent/runner.ts",
    "lib/squads/teammate/dispatch-teammate.ts",
    "lib/ai/chat/standalone-engine.ts",
  ]
  for (const file of engines)
    expect({
      file,
      checked: digestComparisonCount(readFileSync(join(ROOT, file), "utf8")) > 0,
    }).toEqual({ file, checked: true })
  expect(
    digestComparisonCount(
      "options.resumeSessionId = saved.id; options.personalVisibilityDigest = fresh.visibilityDigest"
    )
  ).toBe(0)
  expect(
    digestComparisonCount(
      "if(saved.personalVisibilityDigest !== fresh.visibilityDigest) rebuild() "
    )
  ).toBe(1)
})

// These are the reviewed model-facing owners, rather than UI/export readers.
// Pure renderers (handoff-context, generation/summarizer) receive only filtered
// inputs from these boundaries. Canonical branch/thread-browser promotions
// retain marks for the destination builder; local search indexing is rechecked
// at project-history-tool and mention/reference readers before model use.
const FILTER_BOUNDARIES: Record<string, string[]> = {
  "lib/background-tasks/host-delivery-lane.ts": ["preparePersonalDerivedHistory", "sourceRunIds"],
  "lib/background-tasks/result-delivery.ts": ["entry.squadHandoff?.squadRunId"],
  "lib/background-tasks/room-delivery-lane.ts": [
    "...(personalRunIds?.length ? { personalRunIds } : {})",
  ],
  "lib/collab/shared-room-catch-up.ts": ["prepareOwnerHistory"],
  "lib/connectors/room/im-room-delivery-lane.ts": [
    "preparePersonalDerivedHistory",
    'executionRunId: ""',
  ],
  "lib/connectors/runtime.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
    "personalExecutionRunId: executionRunId",
    ".finally(cancelUnstartedReply)",
  ],
  "lib/execution/launch-child-run.ts": [
    "await startJobEngine(target, grants, {",
    "personalContext,",
  ],
  "lib/squads/ports/twin-answer.ts": ["personalContext: input.personalContext"],
  "lib/squads/room-handoff/decide.ts": [
    "preparePersonalDerivedHistory",
    "executionRunId: delegation.runId",
  ],
  "cli/src/agent/rpc/runtime-service.ts": [
    "assertPersonalControlOwner",
    "HOST_OWNED_TRANSCRIPT_CONTROL",
  ],
  "cli/src/tui/runtime/plan-controller.ts": ["prepareCliPersonalMessages"],
  "lib/plugin/agent-sdk/session.ts": ["preparePersonalHistory", "pluginExecutionContext"],
  "lib/ai/agent/agent-executor.ts": ["withholdForReaders"],
  "lib/agent/plan/planner.ts": ["preparePersonalDerivedHistory"],
  "lib/agent/plan/step-dispatch.ts": ["preparePersonalDerivedHistory"],
  "lib/agent/plan/plan-teammate-context.ts": ["personalExecutionRunId"],
  "lib/squads/agent-team-runtime-deps.ts": ["visibleTeamDerivedTextForTeam"],
  "lib/squads/delegation-orchestrator.ts": [
    "preparePersonalDerivedHistory",
    "visibleDelegationPrompt",
    "personalExecutionRunId",
  ],
  "lib/squads/durable/replan-checkpoint.ts": ["readDependencyResultsForRun"],
  "lib/squads/ledger/progress-ledger.ts": ["readDependencyResultsForRun"],
  "lib/squads/workflow-nodes/index.ts": ["visibleTeamDerivedText"],
  "lib/squads/workflow-nodes/team-ops.ts": ["preparePersonalDerivedHistory"],
  "lib/squads/collaboration-tools.ts": [
    "preparePersonalDerivedHistory",
    "filterSharedMemoryEntriesForRun",
  ],
  "lib/squads/teammate/twin-context.ts": [
    "preparePersonalHistory",
    "withPersonalRerankerVisibility",
  ],
  "cli/src/twin/context-client.ts": ["withholdForReaders"],
  "lib/cli-bridge/handlers/twin-context.ts": [
    "preparePersonalHistory",
    'executionRunId: host?.executionRunId ?? ""',
    "withPersonalRerankerVisibility",
  ],
  "cli/src/tui/input/inline-suggest.ts": ["withholdForReaders"],
  "lib/voice/live/runtime-bindings.ts": ["prepareOwnerHistory"],
  "lib/skills/session-suggestion.ts": ["prepareOwnerHistory", "prepareOwnerDerivedHistory"],
  "lib/skills/recording/controller.ts": ["prepareOwnerDerivedHistory"],
  "lib/ai/eval/service.ts": [
    "personalEvalCaseForRun",
    "preparePersonalDerivedHistory",
    "personalEvalSampleForRun",
  ],
  "lib/ai/eval/targets/chat.ts": ["personalEvalSampleForRun", "preparePersonalDerivedHistory"],
  "lib/ai/eval/targets/team.ts": ["personalEvalSampleForRun"],
  "lib/ai/eval/targets/workflow.ts": ["personalEvalSampleForRun"],
  "lib/ai/eval/browser-execution.ts": [
    "personalEvalCaseForRun",
    "personalEvalSampleForRun",
    "preparePersonalDerivedHistory",
  ],
  "lib/ai/eval/calibration/runner.ts": ["preparePersonalDerivedHistory"],
  "hooks/chat/claude-chat-turn-tasks.ts": ["prepareOwnerHistory"],
  "lib/ai/generation/run-title-task.ts": ["prepareOwnerDerivedHistory", "sourceRunIds"],
  "lib/workflow/runtime/run-title.ts": ["sourceRunIds: [workflowExecutionRunId(runId)]"],
  "lib/sync/host-state-service.ts": ["prepareOwnerHistory"],
  "lib/execution/personal-visibility.ts": [
    "withholdForReaders",
    "resolveRunActingIdentity",
    "samePersonForHost",
  ],
  "hooks/chat/claude-chat-send-options.ts": [
    "preparePersonalHistory",
    "runtimePersonalVisibilityDigest",
    "invalidate",
    "personalHistory.withheldMessageIds.length > 0 && visibilityChanged",
  ],
  "hooks/chat/use-claude-chat-controller.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
    "buildPersonalAsideContext",
    "personalVisibilityDigest",
  ],
  "lib/claude/ipc.ts": [
    "preparePersonalHistory",
    "assertPersonalVisibilityDigest",
    "personalVisibilityDigest",
    "assertPersonalControlVisibility",
  ],
  "lib/claude/run-and-capture.ts": ["prepareTranscriptRuntimeSend", "captureAssistantReplyCore"],
  "lib/ai/chat/standalone-engine.ts": [
    "preparePersonalHistory",
    "current.visibilityDigest !== personalHistory.visibilityDigest",
    "personalContextReadersDigest",
  ],
  "lib/chat/turn-route/history.ts": ["preparePersonalHistory"],
  "cli/src/agent/personal-history.ts": [
    "withholdForReaders",
    "preparePersonalHistory",
    "indexedDB",
  ],
  "cli/src/agent/session-runner.ts": [
    "prepareCliPersonalHistory",
    "saved.personalVisibilityDigest !== history.visibilityDigest",
    "personalVisibilityDigest",
    "history.withheldMessageIds.length > 0",
  ],
  "cli/src/agent/external-agent-session.ts": [
    "prepareCliPersonalHistory",
    "personalVisibilityDigest !== personalHistory.visibilityDigest",
    "personalHistory.withheldMessageIds.length > 0",
  ],
  "cli/src/cli/handoff-cmd.ts": ["prepareCliPersonalMessages"],
  "sidecar/src/host/commands/send.ts": [
    "personalVisibilityDigest !== existing.sendOptions?.personalVisibilityDigest",
    "options?.personalVisibilityHasWithheld === true",
  ],
  "sidecar/src/host/sessions/lifecycle.ts": [
    "personalVisibilityDigest !== existing.sendOptions?.personalVisibilityDigest",
    "options?.personalVisibilityHasWithheld === true",
  ],
  "lib/claude/build-options.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
    "withPersonalMemoryVisibility",
    "personalContextReadersDigest",
  ],
  "lib/plugin/api/agent-turn.ts": [
    "startToolExecutionRun",
    "executionIdentity: { runId: entry.id }",
    "runAndCaptureAssistantReply",
  ],
  "lib/plugin/vscode-shim/chat-turn.ts": ["preparePersonalHistory"],
  "lib/chat/room/runner.ts": ["preparePersonalHistory"],
  "lib/headless/person-agent/index.ts": ["preparePersonalHistory"],
  "lib/headless/person-agent/runner.ts": [
    "deps.history",
    "agent.visibilityDigest !== history.visibilityDigest",
    "history.hasWithheld",
  ],
  "lib/memory/runtime/build-deps.ts": [
    "preparePersonalHistory",
    "withPersonalMemoryVisibility",
    "addPersonalMarksToRun",
  ],
  "lib/memory/context.ts": [
    "deps.markInjectedMemories",
    "result.snapshot.memoryRefs",
    "result.claims",
  ],
  "lib/memory/backfill/backfill-service.ts": ["preparePersonalHistory"],
  "lib/memory/lifecycle/job-worker.ts": ["preparePersonalHistory", "filterPersonalMemories"],
  "lib/memory/write/run-memory-extraction.ts": ["withPersonalMemoryVisibility"],
  "lib/memory/write/run-project-mining.ts": ["withPersonalMemoryVisibility"],
  "lib/memory/project-history-tool.ts": ["deps.canReadMessage", "deps.readSessionTitle"],
  "lib/memory/agent-tools.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
    "legacyOwnerArtifact: true",
    "addPersonalMarksToRun",
    "await deps.markEvidence",
  ],
  "lib/chat/mentions/entity-transcript.ts": ["preparePersonalHistory"],
  "lib/chat/mentions/entity-sources.ts": [
    "preparePersonalDerivedHistory",
    "personalSessionReferenceTitle",
    "legacyOwnerArtifact: true",
  ],
  "lib/chat/mentions/message-reference.ts": ["preparePersonalHistory"],
  "lib/chat/mentions/prompt-reference.ts": ["preparePersonalHistory"],
  "lib/chat/mentions/result-reference.ts": ["preparePersonalHistory"],
  "hooks/chat/use-follow-up-suggestions.ts": ["prepareOwnerHistory"],
  "hooks/chat/use-composer-ghost-text.ts": ["prepareOwnerHistory"],
  "hooks/chat/use-conversation-summary-draft.ts": ["preparePersonalHistory"],
  "lib/chat/selection/run-selection-action.ts": ["preparePersonalHistory"],
  "lib/chat/completion/inline/ai-provider.ts": ["resolveRecentMessages"],
  "lib/reply-copilot/load-context.ts": ["prepareOwnerHistory"],
  "lib/chat/attached-session.ts": ["preparePersonalHistory"],
  "lib/tasks/spawn-task-dispatch.ts": ["preparePersonalHistory"],
  "lib/project-coordinator/continue-as-project.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
  ],
  "lib/chat/dispatch-to-codex-app.ts": ["preparePersonalHistory", "LOCAL_PERSON_RUN"],
  "lib/media/agent-tools.ts": ["preparePersonalHistory"],
  "lib/project-coordinator/agent-tools.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
  ],
  "lib/claude/agents/dispatch-agent-handler.ts": ["preparePersonalDerivedHistory"],
  "lib/squads/team-run-context.ts": ["preparePersonalDerivedHistory"],
  "lib/squads/memory/shared-memory-orchestrator.ts": [
    "preparePersonalDerivedHistory",
    "filterSharedMemoryEntriesForRun",
  ],
  "lib/squads/teammate/dispatch-teammate.ts": [
    "personalVisibilityDigest",
    "retainedVisibilityDigest !== visible.personalVisibilityDigest",
  ],
  "lib/plugin/agent-sdk/context-providers.ts": [
    "preparePersonalHistory",
    "filterSharedMemoryEntriesForRun",
  ],
  "lib/workflow/nodes/sessions/index.ts": [
    "preparePersonalHistory",
    "preparePersonalDerivedHistory",
  ],
  "lib/sync/desktop-sync-source.ts": ["preparePairedOwnerHistory", "projectPersonalSessionHistory"],
  "lib/companion/desktop-message-source.ts": [
    "preparePairedOwnerHistory",
    "projectPersonalSessionHistory",
  ],
}

it("pins the shared filter and digest comparison at every reviewed model boundary", () => {
  for (const [file, anchors] of Object.entries(FILTER_BOUNDARIES)) {
    const text = readFileSync(join(ROOT, file), "utf8")
    for (const anchor of anchors)
      expect({ file, anchor, present: text.includes(anchor) }).toEqual({
        file,
        anchor,
        present: true,
      })
  }
})
