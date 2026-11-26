"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The service tokens list's two renderings of one row (AGT-L2 design §4): the desktop table's
// columns, and the phone's stacked item with the same fields. Both read the row the keyset page
// carries; neither holds state.

import type { ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import type { ServiceTokenListItem } from "@/lib/queries/service-tokens";
import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import { scopeWords, TOKEN_STATUS } from "./token-vocab";

/** What a row's actions do. */
export interface TokenRowActions {
	onEdit: (token: ServiceTokenListItem) => void;
	onRevoke: (token: ServiceTokenListItem) => void;
}

/** The token's projects as one phrase: "All projects", or their names. */
function projectsPhrase(token: ServiceTokenListItem): string {
	if (token.projects === null) return "All projects";
	return token.projects.map((p) => p.name).join(", ") || "—";
}

/** A token's status pill, with its explicit tier. */
function TokenStatus({ token }: { token: ServiceTokenListItem }) {
	const { tier, label } = TOKEN_STATUS[token.status];
	return <StatusBadge status={token.status} tier={tier} label={label} />;
}

/** "Last used": relative, or "Never". */
function lastUsed(token: ServiceTokenListItem): string {
	return token.lastUsedAt ? formatRelative(token.lastUsedAt) : "Never";
}

/** The Edit and Revoke buttons, for an active token only: a revoked or expired one has nothing to change. */
function RowActions({ token, actions }: { token: ServiceTokenListItem; actions: TokenRowActions }) {
	if (token.status !== "active") return null;
	return (
		<div className="flex flex-nowrap justify-end gap-1">
			<Button type="button" variant="ghost" size="sm" onClick={() => actions.onEdit(token)} aria-label={`Edit ${token.name}`}>
				Edit
			</Button>
			<Button type="button" variant="ghost" size="sm" onClick={() => actions.onRevoke(token)} aria-label={`Revoke ${token.name}`}>
				Revoke
			</Button>
		</div>
	);
}

/** The environments a token deploys to without a person, one per line, or "None". */
function AutoApproveCell({ token }: { token: ServiceTokenListItem }) {
	if (token.autoApproveEnvironments.length === 0) return <span className="text-text-tertiary">None</span>;
	return (
		<ul className="grid gap-0.5 whitespace-normal">
			{token.autoApproveEnvironments.map((env) => (
				<li key={env.id} className="font-mono text-ui-sm text-text-primary">
					{env.projectName} / {env.name}
				</li>
			))}
		</ul>
	);
}

/**
 * Lets a cell's text wrap. Table cells default to `whitespace-nowrap` and the table's wrapper clips
 * its overflow, so with eight columns the widest text pushed the Edit and Revoke buttons past the
 * clipped edge at a laptop width: they rendered but could not be clicked. The free-text columns
 * wrap instead, so the table fits its container.
 */
function Wraps({ children }: { children: ReactNode }) {
	return <span className="whitespace-normal">{children}</span>;
}

/** The desktop table's columns. */
export function buildTokenColumns(actions: TokenRowActions): ColumnDef<ServiceTokenListItem>[] {
	return [
		{
			id: "name",
			header: "Name",
			cell: ({ row }) => <span className="whitespace-normal break-words font-medium text-text-primary">{row.original.name}</span>,
		},
		{
			id: "token",
			header: "Token",
			cell: ({ row }) => <span className="font-mono text-ui-sm text-text-secondary">{row.original.tokenPrefix}…</span>,
		},
		{ id: "scopes", header: "Can", cell: ({ row }) => <Wraps>{scopeWords(row.original.scopes)}</Wraps> },
		{ id: "projects", header: "Projects", cell: ({ row }) => <Wraps>{projectsPhrase(row.original)}</Wraps> },
		{
			id: "autoApprove",
			header: () => <Wraps>Deploys without approval</Wraps>,
			cell: ({ row }) => <AutoApproveCell token={row.original} />,
		},
		{
			id: "lastUsed",
			header: "Last used",
			cell: ({ row }) => <span className="text-text-secondary">{lastUsed(row.original)}</span>,
		},
		{ id: "status", header: "Status", cell: ({ row }) => <TokenStatus token={row.original} /> },
		{
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			cell: ({ row }) => <RowActions token={row.original} actions={actions} />,
		},
	];
}

/** The phone's stacked list: the same fields as the table, one item per token. */
export function TokenStackedList({ rows, actions }: { rows: readonly ServiceTokenListItem[]; actions: TokenRowActions }) {
	return (
		<ul aria-label="Service tokens" className="divide-y divide-border rounded-sm border border-border">
			{rows.map((token) => (
				<li key={token.id} className="grid gap-1 px-3 py-3 text-ui-sm">
					<div className="flex items-center justify-between gap-2">
						<span className="truncate text-ui-md font-medium text-text-primary">{token.name}</span>
						<TokenStatus token={token} />
					</div>
					<span className="font-mono text-text-secondary">{token.tokenPrefix}…</span>
					<span className="text-text-secondary">
						{scopeWords(token.scopes)} · {projectsPhrase(token)}
					</span>
					<span className="text-text-secondary">
						Deploys without approval:{" "}
						{token.autoApproveEnvironments.length
							? token.autoApproveEnvironments.map((env) => `${env.projectName} / ${env.name}`).join(", ")
							: "none"}
					</span>
					<span className="text-text-tertiary">Last used: {lastUsed(token)}</span>
					<RowActions token={token} actions={actions} />
				</li>
			))}
		</ul>
	);
}
