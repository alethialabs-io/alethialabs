"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { CredentialScope } from "@/lib/db/schema/enums";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { Loader2, Lock, MoreVertical, RefreshCw, Unlink, Users } from "lucide-react";

const AUTH_METHOD_LABELS: Record<string, string> = {
	oauth: "OAuth",
	iam_role: "IAM Role",
	service_account: "Service Account",
	service_principal: "Service Principal",
	ram_role: "RAM Role",
};

interface ConnectorCardProps {
	integration: ConnectorWithConnection;
	onClick: () => void;
	onConnect: () => void;
	onDisconnect: () => void;
	/** Share with the org / pull back to personal (cloud + api_key only). */
	onShare?: (target: CredentialScope) => void;
	isConnecting?: boolean;
}

export function ConnectorCard({
	integration,
	onClick,
	onConnect,
	onDisconnect,
	onShare,
	isConnecting,
}: ConnectorCardProps) {
	const isComingSoon = integration.status === "coming_soon";
	const isConnected = integration.connected;
	const isGit = integration.category === "git";
	const needsReconnection =
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed";
	// Git OAuth tokens are personal; cloud + api_key credentials can be org-shared.
	const canShare = isConnected && !isGit && !isComingSoon && Boolean(onShare);
	const isShared = integration.scope === "org";

	return (
		<div
			className={cn(
				"flex items-center gap-4 px-5 py-4 transition-colors rounded-lg border border-border/50",
				isComingSoon
					? "opacity-50"
					: "hover:bg-muted/30 cursor-pointer",
			)}
			onClick={isComingSoon ? undefined : onClick}
		>
			<div className="shrink-0 w-10 h-10 rounded-lg border border-border/50 bg-background flex items-center justify-center overflow-hidden p-1.5">
				{isGit ? (
					<GitProviderIcon provider={integration.slug} size={24} />
				) : (
					<ConnectorIcon
						src={integration.icon_url}
						name={integration.name}
						size={28}
					/>
				)}
			</div>

			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2.5">
					<span className="text-sm font-medium text-foreground">
						{integration.name}
					</span>
					{isConnected && needsReconnection && (
						<StatusBadge status="pending" label="Needs Reconnection" />
					)}
					{isConnected && !needsReconnection && (
						<StatusBadge status="connected" label="Connected" />
					)}
					{isConnected && isShared && (
						<Badge
							variant="outline"
							className="text-[10px] py-0 text-muted-foreground border-border/50"
						>
							<Users className="w-2.5 h-2.5 mr-1" />
							Shared
						</Badge>
					)}
					{isComingSoon && (
						<Badge
							variant="secondary"
							className="text-[10px] py-0"
						>
							Coming Soon
						</Badge>
					)}
					<Badge
						variant="outline"
						className="text-[10px] py-0 text-muted-foreground border-border/50"
					>
						{AUTH_METHOD_LABELS[integration.auth_method] ??
							integration.auth_method}
					</Badge>
				</div>
				<p className="text-xs text-muted-foreground mt-0.5 truncate pr-4">
					{integration.description}
				</p>
				{isConnected && integration.connection_details?.username && (
					<p className="text-[11px] text-muted-foreground font-mono mt-1">
						@{integration.connection_details.username}
					</p>
				)}
				{isConnected && integration.connection_details?.account_id && (
					<p className="text-[11px] text-muted-foreground font-mono mt-1">
						Account{" "}
						{integration.connection_details.account_id}
					</p>
				)}
				{isConnected && integration.connection_details?.project_id && (
					<p className="text-[11px] text-muted-foreground font-mono mt-1">
						Project{" "}
						{integration.connection_details.project_id}
					</p>
				)}
				{isConnected && integration.connection_details?.subscription_id && (
					<p className="text-[11px] text-muted-foreground font-mono mt-1">
						Subscription{" "}
						{integration.connection_details.subscription_id.slice(0, 8)}...
					</p>
				)}
			</div>

			<div className="shrink-0 flex items-center gap-2">
				{!isComingSoon && isConnected && needsReconnection && (
					<Button
						size="sm"
						className="text-xs h-8 bg-primary hover:bg-primary/90 text-primary-foreground"
						disabled={isConnecting}
						onClick={(e) => {
							e.stopPropagation();
							onConnect();
						}}
					>
						{isConnecting ? (
							<Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
						) : (
							<RefreshCw className="w-3.5 h-3.5 mr-1.5" />
						)}
						Reconnect
					</Button>
				)}
				{!isComingSoon && isConnected && !needsReconnection && (
					<Button
						variant="outline"
						size="sm"
						className="text-xs h-8 text-destructive hover:text-destructive hover:bg-destructive/10 border-border/50"
						onClick={(e) => {
							e.stopPropagation();
							onDisconnect();
						}}
					>
						<Unlink className="w-3.5 h-3.5 mr-1.5" />
						Disconnect
					</Button>
				)}
				{!isComingSoon && !isConnected && (
					<Button
						size="sm"
						className="text-xs h-8"
						disabled={isConnecting}
						onClick={(e) => {
							e.stopPropagation();
							onConnect();
						}}
					>
						{isConnecting && (
							<Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
						)}
						Connect
					</Button>
				)}
				{canShare && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-8 w-8 p-0 text-muted-foreground"
								onClick={(e) => e.stopPropagation()}
							>
								<MoreVertical className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{isShared ? (
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onShare?.("personal");
									}}
								>
									<Lock className="h-3.5 w-3.5 mr-2" />
									Make personal
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onShare?.("org");
									}}
								>
									<Users className="h-3.5 w-3.5 mr-2" />
									Share with org
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		</div>
	);
}
