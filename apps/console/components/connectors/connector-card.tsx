"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
	/**
	 * False when this instance isn't configured to support this provider's connect flow — a managed
	 * cloud missing platform creds, or a git provider with no registered OAuth app. The tile then
	 * says "not enabled on this instance" instead of offering a doomed connect.
	 */
	platformConfigured?: boolean;
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
	platformConfigured = true,
	isConnecting,
}: ConnectorCardProps) {
	const isComingSoon = integration.status === "coming_soon";
	const isConnected = integration.connected;
	const isGit = integration.category === "git";
	const isCloud = integration.category === "cloud";
	// A managed cloud missing platform creds, or a git provider with no registered OAuth app: a
	// connect can only fail, so the tile is honest about it (self-hosters: see the docs to enable).
	const platformUnavailable =
		(isCloud || isGit) && !platformConfigured && !isConnected;
	const needsReconnection =
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed";
	const cloudFailed = integration.cloud_health === "failed";
	const cloudTesting = integration.cloud_health === "testing";
	// Authenticated, but the probe found provisioning permissions missing. NOT a failure — the
	// connection works; it just can't see everything we'd provision into, so it stays "connected"
	// and says so rather than reporting an unqualified green.
	const cloudDegraded = integration.cloud_health === "degraded";
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
						className={cn(
							"truncate",
							cloudFailed && !platformUnavailable && "text-destructive",
						)}
					>
						{isComingSoon
							? "Coming soon"
							: platformUnavailable
								? "Not enabled on this instance"
								: needsReconnection
									? "Needs reconnection"
									: isConnected
										? cloudDegraded
											? "Limited permissions"
											: "Connected"
										: cloudFailed
											? "Verification failed"
											: cloudTesting
												? "Verifying…"
												: "Not connected"}
					</span>
				</div>

				{isComingSoon ? null : platformUnavailable ? (
					<span
						title={
							isGit
								? "This git provider has no OAuth app configured on this instance. See the docs to enable it."
								: "This cloud needs Alethia platform credentials, which aren't configured on this instance. See the docs to enable managed cloud connections."
						}
						className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
					>
						Unavailable
					</span>
				) : isConnected && needsReconnection && canManage ? (
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
					// Manage sits alongside Re-verify deliberately: re-verifying a connection whose stored
					// credentials are simply WRONG will fail forever, so the sheet — where the account can be
					// corrected or removed — has to be reachable from here. Without it a bad connect wedged.
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2.5 text-xs"
							onClick={onManage}
						>
							Manage
						</Button>
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
					</div>
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
