"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	disconnectAwsIdentity,
	saveAwsIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import {
	disconnectAzureIdentity,
	saveAzureIdentity,
} from "@/app/(private)/dashboard/providers/azure-actions";
import {
	disconnectGcpIdentity,
	saveGcpIdentity,
} from "@/app/(private)/dashboard/providers/gcp-actions";
import { deleteProviderToken } from "@/app/server/actions/identities";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import { ConnectorsList } from "@/components/connectors/connectors-list";
import {
	ConnectorsSidebar,
	type CategoryFilter,
} from "@/components/connectors/connectors-sidebar";
import { AwsConnection } from "@/components/connector/aws-connection";
import { AzureConnection } from "@/components/connector/azure-connection";
import { GcpConnection } from "@/components/connector/gcp-connection";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import { Loader2, Search, Unplug } from "lucide-react";
import { env } from "next-runtime-env";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

interface ConnectorsPageProps {
	integrations: ConnectorWithConnection[];
	awsSetup: { externalId: string; identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
}

export function ConnectorsPage({
	integrations,
	awsSetup,
	gcpSetup,
	azureSetup,
}: ConnectorsPageProps) {
	const router = useRouter();
	const [selectedCategory, setSelectedCategory] =
		useState<CategoryFilter>("all");
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedIntegration, setSelectedIntegration] =
		useState<ConnectorWithConnection | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [awsSheetOpen, setAwsSheetOpen] = useState(false);
	const [gcpSheetOpen, setGcpSheetOpen] = useState(false);
	const [azureSheetOpen, setAzureSheetOpen] = useState(false);
	const [disconnectTarget, setDisconnectTarget] =
		useState<ConnectorWithConnection | null>(null);
	const [isDisconnecting, setIsDisconnecting] = useState(false);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	const counts = useMemo(() => {
		const result: Record<string, number> = { all: integrations.length };
		for (const i of integrations) {
			result[i.category] = (result[i.category] ?? 0) + 1;
		}
		return result as Record<CategoryFilter, number>;
	}, [integrations]);

	const filtered = useMemo(() => {
		let result = integrations;
		if (selectedCategory !== "all") {
			result = result.filter((i) => i.category === selectedCategory);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter(
				(i) =>
					i.name.toLowerCase().includes(q) ||
					i.description.toLowerCase().includes(q) ||
					i.organization.toLowerCase().includes(q),
			);
		}
		return result;
	}, [integrations, selectedCategory, searchQuery]);

	const handleConnect = async (integration: ConnectorWithConnection) => {
		if (integration.category === "git") {
			setConnectingSlug(integration.slug);
			try {
				const supabase = createClient();
				const {
					data: { user },
					error: userError,
				} = await supabase.auth.getUser();

				if (userError || !user) {
					await supabase.auth.signOut();
					window.location.href = "/auth/signin";
					return;
				}

				const provider = integration.slug as PublicGitProvider;

				// Unlink existing identity if still attached (e.g. after a disconnect that only deleted the token)
				const existing = user.identities?.find(
					(i) => i.provider === provider,
				);
				if (existing) {
					const { error: unlinkError } =
						await supabase.auth.unlinkIdentity(existing);
					if (unlinkError) {
						console.warn(
							`Could not unlink existing ${provider} identity before re-linking: ${unlinkError.message}`,
						);
					}
				}

				// Store provider in cookie so the callback knows which token to save
				document.cookie = `auth_linking_provider=${provider}; path=/; max-age=300; SameSite=Lax`;

				const { error } = await supabase.auth.linkIdentity({
					provider,
					options: {
						redirectTo: `${env("NEXT_PUBLIC_APP_URL") || window.location.origin}/api/auth/callback?next=/dashboard/connectors&provider=${provider}`,
						scopes:
							provider === "github"
								? "repo"
								: provider === "gitlab"
									? "read_api read_user read_repository read_registry openid profile email"
									: undefined,
					},
				});
				if (error) throw error;
			} catch (err) {
				console.error(`Error linking ${integration.slug}:`, err);
				toast.error(`Failed to connect ${integration.name}`);
			} finally {
				setConnectingSlug(null);
			}
		} else if (integration.slug === "aws") {
			setAwsSheetOpen(true);
		} else if (integration.slug === "gcp") {
			setGcpSheetOpen(true);
		} else if (integration.slug === "azure") {
			setAzureSheetOpen(true);
		}
		setDetailOpen(false);
	};

	const handleDisconnect = (integration: ConnectorWithConnection) => {
		setDisconnectTarget(integration);
		setDetailOpen(false);
	};

	const confirmDisconnect = async () => {
		if (!disconnectTarget) return;
		setIsDisconnecting(true);

		try {
			if (disconnectTarget.category === "git") {
				// Delete the token first — this is the critical operation
				const result = await deleteProviderToken(
					disconnectTarget.slug as PublicGitProvider,
				);
				if (result.error) throw new Error(result.error);

				// Try to unlink the Supabase identity (non-critical — may fail if last identity)
				const supabase = createClient();
				const {
					data: { user },
				} = await supabase.auth.getUser();
				const identity = user?.identities?.find(
					(i) => i.provider === disconnectTarget.slug,
				);

				if (identity) {
					const { error } =
						await supabase.auth.unlinkIdentity(identity);
					if (error) {
						console.warn(
							`Could not unlink ${disconnectTarget.slug} identity: ${error.message}`,
						);
					}
				}

				toast.success(
					`Successfully disconnected ${disconnectTarget.name}`,
				);
			} else if (disconnectTarget.slug === "aws") {
				const cloudIdentityId =
					disconnectTarget.connection_details?.cloud_identity_id;
				if (!cloudIdentityId) throw new Error("Missing identity ID");
				await disconnectAwsIdentity(cloudIdentityId);
				toast.success("AWS account disconnected.");
			} else if (disconnectTarget.slug === "gcp") {
				const cloudIdentityId =
					disconnectTarget.connection_details?.cloud_identity_id;
				if (!cloudIdentityId) throw new Error("Missing identity ID");
				await disconnectGcpIdentity(cloudIdentityId);
				toast.success("GCP project disconnected.");
			} else if (disconnectTarget.slug === "azure") {
				const cloudIdentityId =
					disconnectTarget.connection_details?.cloud_identity_id;
				if (!cloudIdentityId) throw new Error("Missing identity ID");
				await disconnectAzureIdentity(cloudIdentityId);
				toast.success("Azure subscription disconnected.");
			}

			setDisconnectTarget(null);
			router.refresh();
		} catch (err) {
			console.error("Disconnect error:", err);
			toast.error(
				`Failed to disconnect ${disconnectTarget?.name ?? "connector"}`,
			);
		} finally {
			setIsDisconnecting(false);
		}
	};

	const handleAwsConnect = async (roleArn: string) => {
		if (!awsSetup) throw new Error("AWS setup not initialized");
		const result = await saveAwsIdentity(awsSetup.identityId, roleArn);
		return result;
	};

	const handleGcpConnect = async (wifConfigJson: string) => {
		if (!gcpSetup) throw new Error("GCP setup not initialized");
		return await saveGcpIdentity(gcpSetup.identityId, wifConfigJson);
	};

	const handleAzureConnect = async (
		tenantId: string,
		clientId: string,
		subscriptionId: string,
	) => {
		if (!azureSetup) throw new Error("Azure setup not initialized");
		return await saveAzureIdentity(
			azureSetup.identityId,
			tenantId,
			clientId,
			subscriptionId,
		);
	};

	const openDetail = (integration: ConnectorWithConnection) => {
		setSelectedIntegration(integration);
		setDetailOpen(true);
	};

	return (
		<>
			<div className="flex gap-8">
				<ConnectorsSidebar
					selected={selectedCategory}
					onSelect={setSelectedCategory}
					counts={counts}
				/>

				<div className="flex-1 space-y-4">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<Input
							placeholder="Search connectors..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9 h-9 text-sm bg-muted/30 border-border/50"
						/>
					</div>

					<ConnectorsList
						integrations={filtered}
						onCardClick={openDetail}
						onConnect={handleConnect}
						onDisconnect={handleDisconnect}
						connectingSlug={connectingSlug}
					/>
				</div>
			</div>

			<ConnectorDetailSheet
				integration={selectedIntegration}
				open={detailOpen}
				onOpenChange={setDetailOpen}
				onConnect={() =>
					selectedIntegration && handleConnect(selectedIntegration)
				}
				onDisconnect={() =>
					selectedIntegration && handleDisconnect(selectedIntegration)
				}
				isConnecting={connectingSlug === selectedIntegration?.slug}
			/>

			{/* AWS Connection Sheet */}
			<Sheet
				open={awsSheetOpen}
				onOpenChange={(open) => {
					setAwsSheetOpen(open);
					if (!open) router.refresh();
				}}
			>
				<SheetContent
					side="right"
					className="w-full sm:max-w-2xl overflow-y-auto p-0"
				>
					<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
						<SheetTitle>Connect AWS Account</SheetTitle>
						<SheetDescription>
							Set up a cross-account IAM role to allow Alethia to
							provision infrastructure in your AWS account.
						</SheetDescription>
					</SheetHeader>
					<div className="px-6 py-6">
						{awsSetup && (
							<AwsConnection
								externalId={awsSetup.externalId}
								onComplete={handleAwsConnect}
							/>
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* GCP Connection Sheet */}
			<Sheet
				open={gcpSheetOpen}
				onOpenChange={(open) => {
					setGcpSheetOpen(open);
					if (!open) router.refresh();
				}}
			>
				<SheetContent
					side="right"
					className="w-full sm:max-w-2xl overflow-y-auto p-0"
				>
					<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
						<SheetTitle>Connect GCP Project</SheetTitle>
						<SheetDescription>
							Set up Workload Identity Federation to allow Alethia
							to provision infrastructure in your GCP project.
						</SheetDescription>
					</SheetHeader>
					<div className="px-6 py-6">
						{gcpSetup && (
							<GcpConnection onComplete={handleGcpConnect} />
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* Azure Connection Sheet */}
			<Sheet
				open={azureSheetOpen}
				onOpenChange={(open) => {
					setAzureSheetOpen(open);
					if (!open) router.refresh();
				}}
			>
				<SheetContent
					side="right"
					className="w-full sm:max-w-2xl overflow-y-auto p-0"
				>
					<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
						<SheetTitle>Connect Azure Subscription</SheetTitle>
						<SheetDescription>
							Set up federated identity credentials to allow Alethia
							to provision infrastructure in your Azure
							subscription.
						</SheetDescription>
					</SheetHeader>
					<div className="px-6 py-6">
						{azureSetup && (
							<AzureConnection onComplete={handleAzureConnect} />
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* Disconnect Confirmation */}
			<AlertDialog
				open={!!disconnectTarget}
				onOpenChange={(open) => !open && setDisconnectTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect {disconnectTarget?.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{disconnectTarget?.slug === "aws"
								? "This will remove the stored IAM role ARN. You won't be able to provision new AWS infrastructure until you reconnect. Existing resources are not affected."
								: disconnectTarget?.slug === "gcp"
									? "This will remove the Workload Identity Federation configuration. You won't be able to provision new GCP infrastructure until you reconnect. Existing resources are not affected."
									: disconnectTarget?.slug === "azure"
										? "This will remove the federated identity configuration. You won't be able to provision new Azure infrastructure until you reconnect. Existing resources are not affected."
										: disconnectTarget?.category === "cloud"
											? "This will remove the stored credentials. You won't be able to provision new infrastructure until you reconnect. Existing resources are not affected."
											: `This will unlink your ${disconnectTarget?.name} account. You won't be able to access repositories from this provider until you reconnect.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisconnecting}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={confirmDisconnect}
							disabled={isDisconnecting}
						>
							{isDisconnecting ? (
								<Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
							) : (
								<Unplug className="w-3.5 h-3.5 mr-1.5" />
							)}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
