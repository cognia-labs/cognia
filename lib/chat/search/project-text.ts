/**
 * Search-text projection — the single definition of "what a message's searchable
 * body is".
 *
 * Each part's text comes from its descriptor (`lib/chat/parts/descriptors.ts`)
 * with the `search` purpose: the readable conversation the Inbox preview
 * covers (`text` / `markdown` / `code` / `image` alt / `a2ui` plain-text
 * mirror) plus what an agent session's most locatable content lives in:
 * reasoning, attached file names, cited source titles and urls, and tool names
 * with their INPUTS. Inputs only: tool *outputs* are the huge ones (a file read
 * can be tens of KB) and indexing them would both dwarf the corpus and bury
 * real prose under tool logs.
 *
 * Pure and DOM-free: same walk runs in the renderer, in the idle indexer, and
 * behind the companion RPC on a host, so every surface agrees on what is
 * searchable.
 */

import { partPlainText } from "@/lib/chat/parts/descriptors"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"

/**
 * Hard ceiling on one message's projected text.
 *
 * An agent that pastes a whole file into a message would otherwise consume the
 * resident-corpus budget by itself (see `lib/chat/search/corpus.ts`). 8k chars
 * is ~2x the longest prose message observed in practice while still bounding the
 * pathological case.
 */
export const PROJECTED_TEXT_MAX_CHARS = 8_000

/**
 * Project a message's `parts` into the one string search matches against.
 *
 * Whitespace-collapsed, trimmed, and truncated to {@link PROJECTED_TEXT_MAX_CHARS}.
 * Walks in document order — the snippet builder reads context around a match, so
 * a projection that appended all tool calls at the tail would produce snippets
 * that read as gibberish.
 */
export function projectSearchText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""

  const buf: string[] = []
  let length = 0
  // The composer's context envelope is the app's framing, not the user's words.
  // Indexing it made a turn that REFERENCED a document findable as though the
  // user had written the document — and every staged web result matched too.
  // What was referenced stays findable through `metadata.mentions`, which the
  // row builder folds in separately.
  for (const raw of stripPromptPreambleFromParts(parts)) {
    // One ordered pass is what keeps snippets readable.
    const piece = partPlainText(raw, "search").replace(/\s+/g, " ").trim()
    if (!piece) continue
    buf.push(piece)
    // +1 for the join space. Bail as soon as the cap can no longer grow, so a
    // message with thousands of parts does not walk them all for nothing.
    length += piece.length + 1
    if (length >= PROJECTED_TEXT_MAX_CHARS) break
  }

  return buf.join(" ").replace(/\s+/g, " ").trim().slice(0, PROJECTED_TEXT_MAX_CHARS)
}
