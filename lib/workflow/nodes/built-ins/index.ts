/** Built-in workflow executor registration facade. */
// Side-effect import — registers the 12 desktop UI-automation executors at
// module load time. Keeps the catalog and the registry in sync without any
// cross-module wiring.
import "../automation/desktop"
// OCR extraction node (ADR-0024) — turns an image/PDF/screen into text.
import "../data/ocr"
// Optional browser-local Transformers.js inference. The module only registers
// an executor; the runtime itself is dynamically imported when the node runs.
import "../ai/browser-model"
// Pro IDE editor nodes (ADR-0088 Phase 3) — open / reveal / diff / read / edit
// / save against the bound embedded code-server.
import "../editor"
// Workspace filesystem nodes. Until these existed a graph could not read or
// write a file at all: the sidecar's file tools belong to the agent, so it took
// an `action.agent.turn` and an LLM round trip to move one file. A registry
// nobody registers into is this repo's most recurrent defect;
// `executor-coverage.test.ts` fails without this line.
import "../files"
// Local Git action nodes (ADR-0038) — stage / commit / push / branch against
// the active workspace repo.
import "../source-control"
// Stacked-branch nodes — list / parent / validate / restack / push, local git
// only (forge delivery stays a plugin concern).
import "../source-control/stack"
// Web-clone node (`io.webClone`) — snapshot a live page + assets into a
// self-contained file/bundle via the vendored sidecar engine (desktop only).
import "../automation/web-clone"
import "../triggers"
import "../data/flow"
import "../ai/executors"
import "../plans"
import "../scheduling"
import "../teams"
import "../integrations"
import "../mobile/executors"
import "../issues"
// Native media nodes (FFmpeg), video generation and the pure image engine. A
// registry nobody registers into is this repo's most recurrent defect;
// `executor-coverage.test.ts` fails without these lines.
import "../media"
import "../media/generate-video"
import "../images"
// Agent-browser nodes. A registry nobody registers into is this repo's most
// recurrent defect; `executor-coverage.test.ts` fails without this line.
import "../browser"
// Search nodes. A registry nobody registers into is this repo's most recurrent
// defect; `executor-coverage.test.ts` fails without this line.
import "../search"
// Conversation nodes. A registry nobody registers into is this repo's most
// recurrent defect; `executor-coverage.test.ts` fails without this line.
import "../sessions"
// Notification-centre nodes. A registry nobody registers into is this repo's
// most recurrent defect; `executor-coverage.test.ts` fails without this line.
import "../notifications"
// Node families feature modules own are their manifests' `workflowNodes`
// contributions (ADR-0250 §14): the pet, eval, terminal, goal, knowledge-base,
// sites and artifact nodes. Start loading them with the built-ins so they
// register about as early; the step executor awaits the same load before any
// lookup, and `executor-coverage.test.ts` fails when one is not wired.
import { loadModuleWorkflowNodes } from "../module-nodes"
void loadModuleWorkflowNodes()
