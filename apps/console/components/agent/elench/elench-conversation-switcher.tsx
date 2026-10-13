"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentThread } from "@/lib/db/schema";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ScrollArea } from "@repo/ui/scroll-area";
import { unsentNoteText, useUnsentConversations } from "./use-elench-threads";

/** "13m ago" etc. */
function relTime(d: Date): string {
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The panel header conversation switcher — a dropdown showing the active conversation's
 * title, opening a search + recent-threads popover (org context). For the project context it
 * degrades to a single "New conversation" action. In both it lists the Unsent entries the modal's
 * rail shows (ADR 0001 §7.4): the docked panel renders no rail, so this list is where a panel user
 * finds words that were never sent, with their count.
 */
export function ElenchConversationSwitcher({
  isOrg,
  threads,
  activeId,
  onSelectThread,
  onNewChat,
}: {
  isOrg: boolean;
  threads: AgentThread[];
  activeId: string | null;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const { unsent, threadNotes } = useUnsentConversations(threads);
  const label =
    threads.find((t) => t.id === activeId)?.title ??
    unsent.find((u) => u.active)?.label ??
    "New conversation";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return threads.filter(
      (t) => !needle || t.title.toLowerCase().includes(needle),
    );
  }, [threads, q]);
  const shownUnsent = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return unsent.filter((u) => !needle || u.label.toLowerCase().includes(needle));
  }, [unsent, q]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 border border-border bg-background px-2.5 py-1.5 text-ui-md text-foreground transition-colors hover:bg-muted"
          >
            <span title={label} className="min-w-0 truncate">
              {label}
            </span>
            <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="bottom"
        className="w-[280px] rounded-none p-2"
      >
        {isOrg && (
          <div className="mb-1 flex items-center gap-2 bg-muted px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            <input
              aria-label="Search conversations"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent text-ui-md text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
        {shownUnsent.length > 0 && (
          <div role="group" aria-label="Unsent conversations">
            <div className="vx-eyebrow flex items-center justify-between px-2 pb-1 pt-2 text-ui-3xs">
              <span>Unsent</span>
              <span className="font-mono">{shownUnsent.length}</span>
            </div>
            {shownUnsent.map((u) => (
              <button
                key={u.conversationId}
                type="button"
                data-testid="switcher-unsent-row"
                aria-current={u.active ? "true" : undefined}
                onClick={() => {
                  onSelectThread(u.conversationId);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2.5 rounded-none px-2 py-2 text-left transition-colors hover:bg-muted"
              >
                <span
                  title={u.label}
                  className="min-w-0 flex-1 truncate text-ui-md text-foreground"
                >
                  {u.label}
                </span>
                <span className="flex-none font-mono text-ui-xs text-muted-foreground">
                  {unsentNoteText(u.note)}
                </span>
              </button>
            ))}
            <div className="my-1.5 h-px bg-border" />
          </div>
        )}
        {isOrg && (
          <>
            {filtered.length > 0 && (
              <div className="vx-eyebrow px-2 pb-1 pt-2 text-ui-3xs">Recent</div>
            )}
            <ScrollArea className="max-h-[240px]">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onSelectThread(t.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2.5 rounded-none px-2 py-2 text-left transition-colors hover:bg-muted"
                >
                  <span
                    title={t.title}
                    className="min-w-0 flex-1 truncate text-ui-md text-foreground"
                  >
                    {t.title}
                  </span>
                  <span className="flex-none font-mono text-ui-xs text-muted-foreground">
                    {threadNotes[t.id] ?? relTime(new Date(t.updated_at))}
                  </span>
                </button>
              ))}
            </ScrollArea>
            <div className="my-1.5 h-px bg-border" />
          </>
        )}
        <button
          type="button"
          onClick={() => {
            onNewChat();
            setOpen(false);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-none px-2 py-2 text-ui-md text-foreground transition-colors hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          New conversation
        </button>
      </PopoverContent>
    </Popover>
  );
}
