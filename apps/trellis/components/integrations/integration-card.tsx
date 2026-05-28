"use client";

import type { IntegrationWithConnection } from "@/app/server/actions/integrations";
import { GitProviderIcon } from "@/components/git-provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckCircle2, Loader2, Unlink } from "lucide-react";
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
					{isConnected && (
						<Badge
							variant="outline"
							className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950 text-[10px] py-0"
						>
							<CheckCircle2 className="w-3 h-3 mr-1" />
							Connected
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
			</div>

			<div className="shrink-0 flex items-center gap-2">
				{!isComingSoon && isConnected && (
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
