"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The manage sheet for one connected agent (SPEC §5a), in `connector-detail-sheet.tsx`'s shape: a
// right-hand `DetailSheet` (full width on a phone) with the app's mark and name as the dialog's
// accessible name, what the connection allows, and one write — Disconnect, confirmed through
// `ConfirmAction` at the `confirm` level.
//
// What the app may do is read-only here on purpose: a grant is changed by connecting again from the
// app, where the consent screen shows the difference before the person allows it.

import { Button } from "@repo/ui/button";
import { DetailSheet } from "@repo/ui/detail-sheet";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge } from "@repo/ui/status-badge";
import { formatDate } from "@repo/format";
import { AgentIcon } from "@/components/agents/agent-icon";
import { type AgentCardEntry, SCOPE_WORDS } from "@/components/settings/connected/connected-agents-board";

interface ManageAgentSheetProps {
	/** The connected card being managed; null renders the sheet closed. */
	card: AgentCardEntry | null;
	onOpenChange: (open: boolean) => void;
	/** Project id → name, for the projects the grant names. */
	projectNames: ReadonlyMap<string, string>;
	/** The org's kill switch is off. */
	paused: boolean;
	/** Asks to disconnect (opens the confirmation). */
	onDisconnect: () => void;
}

/** The manage sheet of one connected agent: what it can do, where, since when, and Disconnect. */
export function ManageAgentSheet({ card, onOpenChange, projectNames, paused, onDisconnect }: ManageAgentSheetProps) {
	const grant = card?.grant ?? null;
	const name = card?.name ?? "";
	return (
		<DetailSheet
			open={grant !== null}
			onOpenChange={onOpenChange}
			className="w-full sm:max-w-[640px]"
			title={
				<span className="flex min-w-0 items-center gap-2.5">
					<span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
						{card ? <AgentIcon mark={card.mark} icon={card.icon} name={card.name} size={20} decorative /> : null}
					</span>
					<span className="truncate">{name}</span>
				</span>
			}
			description={grant?.identity.host ?? undefined}
			badge={
				grant ? (
					paused ? (
						<StatusBadge status="paused" tier="disabled" label="Paused" />
					) : (
						<StatusBadge status="connected" tier="active" label="Connected" />
					)
				) : null
			}
			footer={
				<div className="flex w-full justify-end gap-2">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Close
					</Button>
					<Button variant="outline" onClick={onDisconnect}>
						Disconnect
					</Button>
				</div>
			}
		>
			{grant ? (
				<div className="space-y-6">
					{paused ? (
						<p className="rounded-md border px-3 py-2 text-ui-sm leading-relaxed text-text-secondary">
							Agent access is off in this organization, so {name} can&apos;t do anything right now. The
							connection is kept.
						</p>
					) : null}

					<section className="space-y-3">
						<SectionHeading level={3} title="Can" />
						<ul className="space-y-2">
							{grant.scopes.map((scope) => (
								<li key={scope} className="text-ui-sm leading-snug">
									<span className="text-text-primary">{SCOPE_WORDS[scope].label}</span>
									<span className="text-text-secondary"> · {SCOPE_WORDS[scope].detail}</span>
								</li>
							))}
						</ul>
					</section>

					<section className="space-y-3">
						<SectionHeading level={3} title="Projects" />
						{grant.projectIds === null ? (
							<p className="text-ui-sm text-text-primary">All projects, including new ones</p>
						) : (
							<ul className="space-y-1">
								{grant.projectIds.map((id) => (
									<li key={id} className="font-mono text-ui-sm text-text-primary">
										{projectNames.get(id) ?? "A project you can't see"}
									</li>
								))}
							</ul>
						)}
					</section>

					<dl className="space-y-3 text-ui-sm">
						<div className="space-y-0.5">
							<dt className="text-text-secondary">Connected</dt>
							<dd className="text-text-primary">{formatDate(grant.connectedAt)}</dd>
						</div>
						<div className="space-y-0.5">
							<dt className="text-text-secondary">App identity</dt>
							<dd className="min-w-0 break-all font-mono text-text-primary">{grant.clientId}</dd>
							<dd className="text-text-secondary">
								{grant.verified ? "Verified by its metadata document" : "Not verified"}
							</dd>
						</div>
					</dl>

					<p className="text-ui-sm leading-relaxed text-text-secondary">
						To change what {name} can do, connect it again from the app. You&apos;ll see what changes before you
						allow it.
					</p>
				</div>
			) : null}
		</DetailSheet>
	);
}
