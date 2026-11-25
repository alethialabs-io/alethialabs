"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorIcon, isThirdPartyMark } from "@/components/connectors/connector-icon";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorAction } from "@/components/connectors/connectors-action";
import { NOT_OFFERED_SHORT, connectorState } from "@/components/connectors/connectors-query";
import { TableCell, TableRow } from "@repo/ui/table";
import { cn } from "@repo/ui/utils";

interface ConnectorRowProps {
	integration: ConnectorWithConnection;
	/** Whether the current member may add/edit connections. */
	canManage: boolean;
	/** Connect (or, for a connected cloud, "add another account"). */
	onConnect: () => void;
	/** Open the manage sheet (connected connectors). */
	onManage: () => void;
	/** Re-run the verification for a failed cloud connector (no credential re-entry). */
	onReverify?: () => void;
	/**
	 * False when this instance isn't configured to support this provider's connect flow — a managed
	 * cloud missing platform creds, or a git provider with no registered OAuth app.
	 */
	platformConfigured?: boolean;
	/** False for a cloud that takes no new connection here. See `ConnectorCard`'s `offered`. */
	offered?: boolean;
	isConnecting?: boolean;
}

/**
 * The table-view counterpart of `ConnectorCard` — one connector as a row (logo +
 * name/description, status, account/scope meta, and a Manage/Connect/Reconnect
 * action), sharing the same affordances so the two views stay in lock-step.
 */
export function ConnectorRow({
	integration,
	canManage,
	onConnect,
	onManage,
	onReverify,
	platformConfigured = true,
	offered = true,
	isConnecting,
}: ConnectorRowProps) {
	const isConnected = integration.connected;
	// One ladder for the wording, shared with the card and the Status facet. See connectors-query.ts.
	const state = connectorState(integration, platformConfigured);
	// "Coming soon" only when NOT already connected — a connected account keeps its Manage → disconnect
	// path even if the connector is later marked coming_soon. See connector-card.tsx.
	const isComingSoon = state.health === "coming_soon";
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	const accountCount = integration.accounts?.length ?? 0;
	// A coming-soon row steps its description and status down one ink tier, and its state
	// label already says "Coming soon" in words. It is NOT a blanket `opacity-50` on the row:
	// that dimmed the `text-foreground` name to 3.6:1 and the `--muted-foreground` copy to
	// 2.3:1 — and at α=0.5 over the page background not even pure black reaches 4.5:1 (#4197).
	const secondaryInk = isComingSoon ? "text-text-tertiary" : "text-muted-foreground";

	return (
		// The list-item marker (#7673, components/data-table.tsx) — the list view's twin of the card.
		<TableRow data-list-item="">
			<TableCell className="py-3">
				<div className="flex items-center gap-3">
					<div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
						{isGit ? (
							<GitProviderIcon provider={integration.slug} size={20} mono={false} />
						) : (
							<ConnectorIcon
								src={integration.icon_url}
								name={integration.name}
								size={22}
								mono={!isConnected && !isThirdPartyMark(integration.icon_url)}
								canLink
							/>
						)}
					</div>
					{/* Cap the text column so `truncate` has a width to clamp against — the table is
					    `table-layout: auto` and TableCell is `whitespace-nowrap`, so without a max-width
					    the cell grows to the full un-wrapped description (the 150+ char Hetzner blurb was
					    the worst offender) and tips the whole table into horizontal scroll. */}
					<div className="min-w-0 max-w-[16rem] sm:max-w-[24rem] lg:max-w-[32rem]">
						{/* `title` carries the full string for the names the clamp eats — the card
						    solves this with a two-line title, but a table row has one line to give. */}
						<div
							className="truncate text-sm font-medium text-foreground"
							title={integration.name}
						>
							{integration.name}
						</div>
						<div
							className={cn("truncate text-xs", secondaryInk)}
							title={offered ? integration.description : NOT_OFFERED_SHORT}
						>
							{offered ? integration.description : NOT_OFFERED_SHORT}
						</div>
					</div>
				</div>
			</TableCell>

			<TableCell>
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"size-2 shrink-0 rounded-full",
							isConnected
								? "bg-foreground ring-4 ring-muted/60"
								: state.destructive
									? "bg-destructive/70"
									: "border-[1.5px] border-border",
						)}
						aria-hidden
					/>
					<span
						className={cn(
							"text-xs",
							secondaryInk,
							state.destructive && "text-destructive",
						)}
					>
						{state.label}
					</span>
				</div>
			</TableCell>

			<TableCell className="font-mono text-ui-2xs text-muted-foreground">
				{isCloud && isConnected ? (
					<span className="rounded-full border border-border/60 px-1.5 py-0.5">
						{accountCount} {accountCount === 1 ? "account" : "accounts"}
					</span>
				) : integration.scope === "org" && !isCloud && isConnected ? (
					<span className="rounded-full border border-border/60 px-1.5 py-0.5">
						Org
					</span>
				) : (
					<span className="text-text-tertiary">—</span>
				)}
			</TableCell>

			<TableCell className="text-right">
				{/* The same ladder as the card (`connectors-action.tsx`): the two views are one
				    affordance rendered twice, so what a connector offers cannot depend on the layout. */}
				<ConnectorAction
					integration={integration}
					state={state}
					canManage={canManage}
					offered={offered}
					isConnecting={isConnecting}
					onConnect={onConnect}
					onManage={onManage}
					onReverify={onReverify}
					className="justify-end"
				/>
			</TableCell>
		</TableRow>
	);
}
