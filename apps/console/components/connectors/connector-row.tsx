"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { Button } from "@repo/ui/button";
import { TableCell, TableRow } from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import { Loader2, RefreshCw } from "lucide-react";

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
	isConnecting,
}: ConnectorRowProps) {
	const isComingSoon = integration.status === "coming_soon";
	const isConnected = integration.connected;
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	const needsReconnection =
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed";
	const cloudFailed = integration.cloud_health === "failed";
	const cloudTesting = integration.cloud_health === "testing";
	const accountCount = integration.accounts?.length ?? 0;

	return (
		<TableRow className={cn(isComingSoon && "opacity-50")}>
			<TableCell className="py-3">
				<div className="flex items-center gap-3">
					<div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
						{isGit ? (
							<GitProviderIcon
								provider={integration.slug}
								size={20}
								mono={!isConnected}
							/>
						) : (
							<ConnectorIcon
								src={integration.icon_url}
								name={integration.name}
								size={22}
								mono={!isConnected}
							/>
						)}
					</div>
					<div className="min-w-0">
						<div className="truncate text-sm font-medium text-foreground">
							{integration.name}
						</div>
						<div className="truncate text-xs text-muted-foreground">
							{integration.description}
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
								: cloudFailed
									? "bg-destructive/70"
									: "border-[1.5px] border-border",
						)}
						aria-hidden
					/>
					<span
						className={cn(
							"text-xs text-muted-foreground",
							cloudFailed && "text-destructive",
						)}
					>
						{isComingSoon
							? "Coming soon"
							: needsReconnection
								? "Needs reconnection"
								: isConnected
									? "Connected"
									: cloudFailed
										? "Verification failed"
										: cloudTesting
											? "Verifying…"
											: "Not connected"}
					</span>
				</div>
			</TableCell>

			<TableCell className="font-mono text-[10px] text-muted-foreground">
				{isCloud && isConnected ? (
					<span className="rounded-full border border-border/60 px-1.5 py-0.5">
						{accountCount} {accountCount === 1 ? "account" : "accounts"}
					</span>
				) : integration.scope === "org" && !isCloud && isConnected ? (
					<span className="rounded-full border border-border/60 px-1.5 py-0.5">
						Org
					</span>
				) : (
					<span className="text-muted-foreground/50">—</span>
				)}
			</TableCell>

			<TableCell className="text-right">
				{isComingSoon ? null : isConnected && needsReconnection && canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						disabled={isConnecting}
						onClick={onConnect}
					>
						{isConnecting ? (
							<Loader2 className="mr-1 size-3.5 animate-spin" />
						) : (
							<RefreshCw className="mr-1 size-3.5" />
						)}
						Reconnect
					</Button>
				) : isConnected ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2.5 text-xs"
						onClick={onManage}
					>
						Manage
					</Button>
				) : cloudTesting ? (
					<Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
				) : cloudFailed && canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						disabled={isConnecting}
						onClick={onReverify}
					>
						{isConnecting ? (
							<Loader2 className="mr-1 size-3.5 animate-spin" />
						) : (
							<RefreshCw className="mr-1 size-3.5" />
						)}
						Re-verify
					</Button>
				) : canManage ? (
					<Button
						size="sm"
						className="h-7 px-2.5 text-xs"
						disabled={isConnecting}
						onClick={onConnect}
					>
						{isConnecting && <Loader2 className="mr-1 size-3.5 animate-spin" />}
						Connect
					</Button>
				) : null}
			</TableCell>
		</TableRow>
	);
}
