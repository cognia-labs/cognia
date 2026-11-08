"use client"

/**
 * Which bot each member of a group's character team speaks through
 * (`ConversationOverrideRow.memberBotAdapterIds`, ADR-0252 P7).
 *
 * Drawn by the conversation override form under the character team picker.
 * Each member defaults to this conversation's own bot, which signs the reply
 * with the member's name; picking a sibling bot of the same platform makes
 * that bot the member's voice in this chat. The candidates are the other
 * enabled bots of the platform; a bot that is no longer one stays visible
 * as missing so the entry can be cleared.
 */

import { useTranslations } from "next-intl"
import type { Character } from "@cognia/agent-config-types"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

/** The select value that stands for "this conversation's own bot". */
const OWN_BOT = "__own__"

export interface MemberVoicesEditorProps {
  /** The conversation's own bot, never a candidate. */
  adapterId: string
  /** The team's members, in the team's order. */
  members: readonly Pick<Character, "id" | "name">[]
  /** Every bot of this conversation's platform. */
  bots: readonly Pick<AdapterInstanceRow, "id" | "displayName" | "enabled">[]
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

/** The entries that still name a member of the team. */
export function memberVoicesForTeam(
  value: Record<string, string>,
  memberIds: readonly string[]
): Record<string, string> | undefined {
  const kept = Object.fromEntries(
    Object.entries(value).filter(([characterId, adapterId]) => {
      return memberIds.includes(characterId) && adapterId.trim().length > 0
    })
  )
  return Object.keys(kept).length > 0 ? kept : undefined
}

export function MemberVoicesEditor({
  adapterId,
  members,
  bots,
  value,
  onChange,
}: MemberVoicesEditorProps) {
  const t = useTranslations("inbox.conversationOverride.fields.memberVoices")
  const candidates = bots
    .filter((bot) => bot.id !== adapterId && bot.enabled)
    .map((bot) => ({ id: bot.id, label: bot.displayName?.trim() || bot.id }))

  if (members.length === 0) return null

  return (
    <div className="space-y-2" data-testid="conv-override-member-voices">
      <Label>{t("label")}</Label>
      <p className="text-[11px] text-muted-foreground">
        {candidates.length > 0 ? t("help") : t("noSiblings")}
      </p>
      <ul className="space-y-2">
        {members.map((member) => (
          <li key={member.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2">
            <span className="truncate self-center text-sm" title={member.name}>
              {member.name}
            </span>
            <Select
              value={value[member.id] ?? OWN_BOT}
              onValueChange={(next) => {
                const updated = { ...value }
                if (next === OWN_BOT) delete updated[member.id]
                else updated[member.id] = next
                onChange(updated)
              }}
            >
              <SelectTrigger
                id={`conv-override-member-voice-${member.id}`}
                data-testid={`conv-override-member-voice-${member.id}`}
                aria-label={t("pickFor", { name: member.name })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[50vh]">
                <SelectItem value={OWN_BOT}>{t("ownBot")}</SelectItem>
                {value[member.id] && !candidates.some((bot) => bot.id === value[member.id]) ? (
                  <SelectItem value={value[member.id]!} className="text-destructive">
                    {t("missing", { id: value[member.id]! })}
                  </SelectItem>
                ) : null}
                {candidates.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id}>
                    {bot.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
    </div>
  )
}
