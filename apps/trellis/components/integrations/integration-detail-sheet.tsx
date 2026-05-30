"use client";

import type { IntegrationWithConnection } from "@/app/server/actions/integrations";
import { GitProviderIcon } from "@/components/git-provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	BookOpen,
	CheckCircle2,
	ExternalLink,
	HelpCircle,
	Loader2,
	Shield,
	Unlink,
} from "lucide-react";
import Image from "next/image";

const AUTH_METHOD_LABELS: Record<string, string> = {
	oauth: "OAuth",
	iam_role: "IAM Role",
	service_account: "Service Account",
	service_principal: "Service Principal",
	ram_role: "RAM Role",
};

interface IntegrationDetailSheetProps {
	integration: IntegrationWithConnection | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	isConnecting?: boolean;
}

export function IntegrationDetailSheet({
	integration,
	open,
	onOpenChange,
	onConnect,
	onDisconnect,
	isConnecting,
}: IntegrationDetailSheetProps) {
	if (!integration) return null;

	const isComingSoon = integration.status === "coming_soon";
	const isConnected = integration.connected;
	const isGit = integration.category === "git";

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full sm:max-w-md overflow-y-auto p-0"
			>
				<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
					<div className="flex items-center gap-4">
						<div className="shrink-0 w-12 h-12 rounded-lg border border-border/50 bg-background flex items-center justify-center overflow-hidden p-2">
							{isGit ? (
								<GitProviderIcon
									provider={integration.slug}
									size={28}
								/>
							) : (
								<Image
									src={integration.icon_url}
									alt={integration.name}
									width={32}
									height={32}
									className="object-contain"
								/>
							)}
						</div>
						<div>
							<SheetTitle className="text-base">
								{integration.name}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{integration.organization}
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>

				<div className="px-6 py-5 space-y-6">
					{/* Status */}
					<div className="flex items-center gap-2">
						{isConnected ? (
							<Badge
								variant="outline"
								className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950 text-xs"
							>
								<CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
								Connected
							</Badge>
						) : isComingSoon ? (
							<Badge variant="secondary" className="text-xs">
								Coming Soon
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="text-muted-foreground border-border/50 text-xs"
							>
								Not connected
							</Badge>
						)}
					</div>

					{/* Details */}
					<div className="space-y-4">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Details
						</h3>

						<div className="space-y-3">
							<div className="flex justify-between items-start">
								<span className="text-xs text-muted-foreground">
									Author
								</span>
								<span className="text-xs font-medium text-foreground">
									{integration.organization}
								</span>
							</div>
							<div className="flex justify-between items-start">
								<span className="text-xs text-muted-foreground">
									Category
								</span>
								<span className="text-xs font-medium text-foreground capitalize">
									{integration.category}
								</span>
							</div>
							<div className="flex justify-between items-start">
								<span className="text-xs text-muted-foreground">
									Auth Method
								</span>
								<Badge
									variant="outline"
									className="text-[10px] py-0 text-muted-foreground border-border/50"
								>
									{AUTH_METHOD_LABELS[
										integration.auth_method
									] ?? integration.auth_method}
								</Badge>
							</div>
							{isConnected &&
								integration.connection_details?.username && (
									<div className="flex justify-between items-start">
										<span className="text-xs text-muted-foreground">
											Account
										</span>
										<span className="text-xs font-mono text-foreground">
											@
											{
												integration.connection_details
													.username
											}
										</span>
									</div>
								)}
							{isConnected &&
								integration.connection_details?.account_id && (
									<div className="flex justify-between items-start">
										<span className="text-xs text-muted-foreground">
											AWS Account
										</span>
										<span className="text-xs font-mono text-foreground">
											{
												integration.connection_details
													.account_id
											}
										</span>
									</div>
								)}
							{isConnected &&
								integration.connection_details?.project_id && (
									<div className="flex justify-between items-start">
										<span className="text-xs text-muted-foreground">
											GCP Project
										</span>
										<span className="text-xs font-mono text-foreground">
											{
												integration.connection_details
													.project_id
											}
										</span>
									</div>
								)}
							{isConnected &&
								integration.connection_details
									?.service_account_email && (
									<div className="flex justify-between items-start">
										<span className="text-xs text-muted-foreground">
											Service Account
										</span>
										<span className="text-xs font-mono text-foreground text-right max-w-[200px] truncate">
											{
												integration.connection_details
													.service_account_email
											}
										</span>
									</div>
								)}
							{isConnected &&
								integration.connection_details
									?.tenant_id && (
									<div className="flex justify-between items-start">
										<span className="text-xs text-muted-foreground">
											Tenant
										</span>
										<span className="text-xs font-mono text-foreground">
											{integration.connection_details.tenant_id.slice(0, 8)}...
										</span>
									</div>
								)}
							{isConnected &&
								integration.connection_details
									?.subscription_id && (
									<div className="flex justify-between items-start">
										<span className="text-xs text-muted-foreground">
											Subscription
										</span>
										<span className="text-xs font-mono text-foreground">
											{integration.connection_details.subscription_id.slice(0, 8)}...
										</span>
									</div>
								)}
						</div>
					</div>

					{/* Description */}
					<div className="space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Description
						</h3>
						<p className="text-sm text-foreground/80 leading-relaxed">
							{integration.description}
						</p>
					</div>

					<Separator />

					{/* Links */}
					{(integration.docs_url ||
						integration.support_url ||
						integration.privacy_url) && (
						<div className="space-y-3">
							<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								More Info
							</h3>
							<div className="space-y-1">
								{integration.docs_url && (
									<a
										href={integration.docs_url}
										target="_blank"
										rel="noopener noreferrer"
										className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
									>
										<BookOpen className="h-4 w-4" />
										Documentation
										<ExternalLink className="h-3 w-3 ml-auto" />
									</a>
								)}
								{integration.support_url && (
									<a
										href={integration.support_url}
										target="_blank"
										rel="noopener noreferrer"
										className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
									>
										<HelpCircle className="h-4 w-4" />
										Support
										<ExternalLink className="h-3 w-3 ml-auto" />
									</a>
								)}
								{integration.privacy_url && (
									<a
										href={integration.privacy_url}
										target="_blank"
										rel="noopener noreferrer"
										className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
									>
										<Shield className="h-4 w-4" />
										Privacy Policy
										<ExternalLink className="h-3 w-3 ml-auto" />
									</a>
								)}
							</div>
						</div>
					)}

					<Separator />

					{/* Action */}
					{!isComingSoon && (
						<div>
							{isConnected ? (
								<Button
									variant="outline"
									className="w-full text-destructive hover:text-destructive hover:bg-destructive/10 border-border/50"
									onClick={onDisconnect}
								>
									<Unlink className="w-4 h-4 mr-2" />
									Disconnect {integration.name}
								</Button>
							) : (
								<Button
									className="w-full"
									disabled={isConnecting}
									onClick={onConnect}
								>
									{isConnecting && (
										<Loader2 className="w-4 h-4 mr-2 animate-spin" />
									)}
									Connect {integration.name}
								</Button>
							)}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
