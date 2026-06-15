"use client";

import type { IntegrationWithConnection } from "@/app/server/actions/integrations";
import { GitProviderIcon } from "@/components/integrations/git-provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { Loader2, RefreshCw, Unlink } from "lucide-react";
import Image from "next/image";

const AUTH_METHOD_LABELS: Record<string, string> = {
	oauth: "OAuth",
	iam_role: "IAM Role",
	service_account: "Service Account",
	service_principal: "Service Principal",
	ram_role: "RAM Role",
};

interface IntegrationCardProps {
	integration: IntegrationWithConnection;
	onClick: () => void;
	onConnect: () => void;
	onDisconnect: () => void;
	isConnecting?: boolean;
}

export function IntegrationCard({
	integration,
	onClick,
	onConnect,
	onDisconnect,
	isConnecting,
}: IntegrationCardProps) {
	const isComingSoon = integration.status === "coming_soon";
	const isConnected = integration.connected;
	const isGit = integration.category === "git";
	const needsReconnection =
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed";

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
					<Image
						src={integration.icon_url}
						alt={integration.name}
						width={28}
						height={28}
						className="object-contain"
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
			</div>
		</div>
	);
}
