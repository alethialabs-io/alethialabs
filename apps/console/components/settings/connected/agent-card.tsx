"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One app on the connected-agents board, in `components/connectors/connector-card.tsx`'s anatomy
// part for part (SPEC §5a): the 36px logo tile with the mark at 24px, the name in two lines and a
// two-line description, the status dot (filled with a halo when connected, an outline when not), the
// mono meta row with its chip and state label, and one action on the right.
//
// The mark is in its owner's colours in every state (ruling #3907, see agent-icon.tsx); whether the
// app is connected is said by the dot, the meta row and the action, and in words by the state label,
// because the dot is decoration (`aria-hidden`).

import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { formatRelative } from "@repo/format";
import { AgentIcon } from "@/components/settings/connected/agent-icon";
import type { AgentCardEntry } from "@/components/settings/connected/connected-agents-board";

interface AgentCardProps {
	card: AgentCardEntry;
	/** The projects chip's text, for a connected card. */
	projects: string | null;
	/** The org's kill switch is off: a connected card reads as paused. */
	paused: boolean;
	/** Opens the manage sheet (connected cards). */
	onManage: () => void;
}

/** The state label of a card: "Not connected", "Paused · agent access off" or when it connected. */
function agentStateLabel(card: AgentCardEntry, paused: boolean): string {
	if (!card.grant) return "Not connected";
	if (paused) return "Paused · agent access off";
	return `Connected ${formatRelative(card.grant.connectedAt)}`;
}

/** One agent app's card: its mark, name, description, connection state and its one action. */
export function AgentCard({ card, projects, paused, onManage }: AgentCardProps) {
	const connected = card.grant !== null;
	return (
		<li
			data-connected={connected || undefined}
			className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background p-4 shadow-sm transition-colors hover:border-border"
		>
			<div className="flex items-start gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
					<AgentIcon mark={card.mark} icon={card.icon} name={card.name} size={24} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="line-clamp-2 text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]">
						{card.name}
					</div>
					<p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{card.description}</p>
				</div>
				<span
					aria-hidden
					data-slot="agent-dot"
					className={cn(
						"mt-1 size-2.5 shrink-0 rounded-full",
						connected ? "bg-foreground ring-4 ring-muted/60" : "border-[1.5px] border-border",
					)}
				/>
			</div>

			<div className="mt-auto flex items-start justify-between gap-2 border-t border-border/40 pt-3">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-ui-2xs leading-tight text-muted-foreground">
					{connected && projects ? (
						<span className="rounded-full border border-border/60 px-1.5 py-0.5">{projects}</span>
					) : null}
					<span>{agentStateLabel(card, paused)}</span>
				</div>
				{connected ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2.5 text-xs"
						aria-label={`Manage ${card.name}`}
						onClick={onManage}
					>
						Manage
					</Button>
				) : card.docsPath ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2.5 text-xs"
						nativeButton={false}
						render={<a href={card.docsPath} aria-label={`Set up ${card.name}`} />}
					>
						Set up
					</Button>
				) : null}
			</div>
		</li>
	);
}
