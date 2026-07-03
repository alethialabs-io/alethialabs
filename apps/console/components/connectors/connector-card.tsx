"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { Loader2, RefreshCw } from "lucide-react";

interface ConnectorCardProps {
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
 * One connector tile — matches the grayscale `.conn` card in the connectors design:
 * a logo, name + description, a fill/outline status dot, a mono meta row (account
 * count · auth method), and a Manage/Connect action gated by `canManage`.
 */
export function ConnectorCard({
	integration,
	canManage,
	onConnect,
	onManage,
	onReverify,
	isConnecting,
}: ConnectorCardProps) {
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
		<div
			className={cn(
				"flex flex-col gap-3 rounded-xl border bg-background p-4 shadow-sm transition-colors",
				isComingSoon
					? "opacity-50 border-border/50"
					: "border-border/60 hover:border-border",
			)}
		>
			<div className="flex items-start gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 p-1.5">
					{isGit ? (
						<GitProviderIcon
							provider={integration.slug}
							size={22}
							mono={!isConnected}
						/>
					) : (
						<ConnectorIcon
							src={integration.icon_url}
							name={integration.name}
							size={24}
							mono={!isConnected}
						/>
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-foreground">
						{integration.name}
					</div>
					<p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
						{integration.description}
					</p>
				</div>
				{/* status dot — filled when connected, outline otherwise */}
				<span
					className={cn(
						"mt-1 size-2.5 shrink-0 rounded-full",
						isConnected
							? "bg-foreground ring-4 ring-muted/60"
							: "border-[1.5px] border-border",
					)}
					aria-hidden
				/>
			</div>

			<div className="mt-auto flex items-center justify-between gap-2 border-t border-border/40 pt-3">
				<div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
					{isCloud && isConnected && (
						<span className="rounded-full border border-border/60 px-1.5 py-0.5">
							{accountCount} {accountCount === 1 ? "account" : "accounts"}
						</span>
					)}
					{integration.scope === "org" && !isCloud && isConnected && (
						<span className="rounded-full border border-border/60 px-1.5 py-0.5">
							Org
						</span>
					)}
					<span
						className={cn("truncate", cloudFailed && "text-destructive")}
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
					<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
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
			</div>
		</div>
	);
}
