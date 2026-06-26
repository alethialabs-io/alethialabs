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
import {
	disconnectExtraCloud,
	saveAlibaba,
	saveSelfManagedTokenCloud,
	saveTokenCloud,
} from "@/app/(private)/dashboard/providers/extra-cloud-actions";
import { deleteProviderToken } from "@/app/server/actions/identities";
import {
	deleteConnectorCredential,
	setCloudIdentityScope,
	setConnectorCredentialScope,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import type { CredentialScope } from "@/lib/db/schema/enums";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import { ConnectorsList } from "@/components/connectors/connectors-list";
import {
	ConnectorsSidebar,
	type CategoryFilter,
} from "@/components/connectors/connectors-sidebar";
import { ApiKeyConnection } from "@/components/connector/api-key-connection";
import { AwsConnection } from "@/components/connector/aws-connection";
import { AzureConnection } from "@/components/connector/azure-connection";
import { GcpConnection } from "@/components/connector/gcp-connection";
import {
	AlibabaConnection,
	TokenCloudConnection,
} from "@/components/connector/extra-cloud-connection";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Input } from "@repo/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { authClient } from "@/lib/auth/client";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import { Loader2, Search, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

interface ConnectorsPageProps {
	integrations: ConnectorWithConnection[];
	awsSetup: { externalId: string; identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
}

/** Clouds connected by a scoped API token (no role-federation). */
const TOKEN_CLOUDS = ["digitalocean", "hetzner", "civo"] as const;
type TokenCloud = (typeof TOKEN_CLOUDS)[number];
const EXTRA_CLOUDS = [...TOKEN_CLOUDS, "alibaba"] as const;

const TOKEN_CLOUD_META: Record<
	TokenCloud,
	{ name: string; docsUrl: string; tokenHelp: string; envVar: string }
> = {
	digitalocean: {
		name: "DigitalOcean",
		docsUrl: "https://cloud.digitalocean.com/account/api/tokens",
		tokenHelp: "Create a Personal Access Token with read + write scopes.",
		envVar: "DIGITALOCEAN_ACCESS_TOKEN",
	},
	hetzner: {
		name: "Hetzner Cloud",
		docsUrl: "https://console.hetzner.cloud/",
		tokenHelp: "Create a project-scoped API token (Security → API Tokens).",
		envVar: "HCLOUD_TOKEN",
	},
	civo: {
		name: "Civo",
		docsUrl: "https://dashboard.civo.com/security",
		tokenHelp: "Copy your API key from the Security page.",
		envVar: "CIVO_TOKEN",
	},
};

export function ConnectorsPage({
	integrations,
	awsSetup,
	gcpSetup,
	azureSetup,
	extraSetup,
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
	const [extraCloudSlug, setExtraCloudSlug] = useState<string | null>(null);
	const [apiKeySlug, setApiKeySlug] = useState<string | null>(null);
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
				const provider = integration.slug as PublicGitProvider;
				const callbackURL = "/dashboard/connectors";

				// Better Auth account linking — redirects to the provider. Native
				// GitHub via linkSocial (repo scope); self-hosted GitLab + Bitbucket
				// via the genericOAuth link endpoint (scopes are server-configured).
				const { error } =
					provider === "github"
						? await authClient.linkSocial({
								provider,
								scopes: ["repo"],
								callbackURL,
							})
						: await authClient.oauth2.link({
								providerId: provider,
								callbackURL,
							});
				if (error) throw new Error(error.message);
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
		} else if ((EXTRA_CLOUDS as readonly string[]).includes(integration.slug)) {
			setExtraCloudSlug(integration.slug);
		} else if (integration.auth_method === "api_key") {
			setApiKeySlug(integration.slug);
		}
		setDetailOpen(false);
	};

	const handleDisconnect = (integration: ConnectorWithConnection) => {
		setDisconnectTarget(integration);
		setDetailOpen(false);
	};

	/** Share a cloud / api_key credential with the org, or pull it back to personal. */
	const handleShare = async (
		integration: ConnectorWithConnection,
		target: CredentialScope,
	) => {
		try {
			const result =
				integration.category === "cloud"
					? await setCloudIdentityScope(
							integration.connection_details?.cloud_identity_id ?? "",
							target,
						)
					: await setConnectorCredentialScope(integration.slug, target);
			if (!result.ok) throw new Error(result.error);
			toast.success(
				target === "org"
					? `Shared ${integration.name} with your org`
					: `${integration.name} is now personal`,
			);
			router.refresh();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to change sharing",
			);
		}
	};

	const confirmDisconnect = async () => {
		if (!disconnectTarget) return;
		setIsDisconnecting(true);

		try {
			if (disconnectTarget.category === "git") {
				// Unlinks the Better Auth account (removes its stored tokens).
				const result = await deleteProviderToken(
					disconnectTarget.slug as PublicGitProvider,
				);
				if (result.error) throw new Error(result.error);

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
			} else if ((EXTRA_CLOUDS as readonly string[]).includes(disconnectTarget.slug)) {
				const cloudIdentityId =
					disconnectTarget.connection_details?.cloud_identity_id;
				if (!cloudIdentityId) throw new Error("Missing identity ID");
				await disconnectExtraCloud(
					cloudIdentityId,
					disconnectTarget.slug as (typeof EXTRA_CLOUDS)[number],
				);
				toast.success(`${disconnectTarget.name} disconnected.`);
			} else if (disconnectTarget.auth_method === "api_key") {
				const result = await deleteConnectorCredential(
					disconnectTarget.slug,
				);
				if (!result.ok) throw new Error(result.error);
				toast.success(`Disconnected ${disconnectTarget.name}.`);
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

	const handleTokenCloudConnect = (provider: TokenCloud) => async (token: string) => {
		const setup = extraSetup?.[provider];
		if (!setup) throw new Error(`${provider} setup not initialized`);
		return await saveTokenCloud(setup.identityId, provider, token);
	};

	const handleSelfManagedConnect = (provider: TokenCloud) => async () => {
		const setup = extraSetup?.[provider];
		if (!setup) throw new Error(`${provider} setup not initialized`);
		return await saveSelfManagedTokenCloud(setup.identityId, provider);
	};

	const handleAlibabaConnect = async (roleArn: string) => {
		const setup = extraSetup?.alibaba;
		if (!setup) throw new Error("Alibaba setup not initialized");
		return await saveAlibaba(setup.identityId, roleArn);
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
						onShare={handleShare}
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

			{/* Extra-cloud Connection Sheet (DigitalOcean / Hetzner / Civo token, Alibaba RAM role) */}
			<Sheet
				open={!!extraCloudSlug}
				onOpenChange={(open) => {
					if (!open) {
						setExtraCloudSlug(null);
						router.refresh();
					}
				}}
			>
				<SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
					{extraCloudSlug === "alibaba" ? (
						<>
							<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
								<SheetTitle>Connect Alibaba Cloud</SheetTitle>
								<SheetDescription>
									Connect via a RAM role — Alethia stores no Alibaba credentials.
								</SheetDescription>
							</SheetHeader>
							<div className="px-6 py-6">
								{extraSetup?.alibaba && (
									<AlibabaConnection
										externalId={extraSetup.alibaba.externalId}
										onSave={handleAlibabaConnect}
									/>
								)}
							</div>
						</>
					) : extraCloudSlug ? (
						(() => {
							const slug = extraCloudSlug as TokenCloud;
							const m = TOKEN_CLOUD_META[slug];
							return (
								<>
									<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
										<SheetTitle>Connect {m.name}</SheetTitle>
										<SheetDescription>
											Connect with a scoped API token (encrypted at rest).
										</SheetDescription>
									</SheetHeader>
									<div className="px-6 py-6">
										{extraSetup?.[slug] && (
											<TokenCloudConnection
												providerName={m.name}
												tokenHelp={m.tokenHelp}
												docsUrl={m.docsUrl}
												envVar={m.envVar}
												onSave={handleTokenCloudConnect(slug)}
												onSaveSelfManaged={handleSelfManagedConnect(slug)}
											/>
										)}
									</div>
								</>
							);
						})()
					) : null}
				</SheetContent>
			</Sheet>

			{/* api_key Connection Sheet (Cloudflare, Vault, Docker Hub, …) */}
			<Sheet
				open={!!apiKeySlug}
				onOpenChange={(open) => {
					if (!open) {
						setApiKeySlug(null);
						router.refresh();
					}
				}}
			>
				<SheetContent
					side="right"
					className="w-full sm:max-w-md overflow-y-auto p-0"
				>
					{apiKeySlug &&
						(() => {
							const provider = getConnectorProviderBySlug(apiKeySlug);
							if (!provider) return null;
							return (
								<>
									<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
										<SheetTitle>Connect {provider.name}</SheetTitle>
										<SheetDescription>
											Provide an API credential. It is encrypted at rest
											and only used by the runner at provision time.
										</SheetDescription>
									</SheetHeader>
									<div className="px-6 py-6">
										<ApiKeyConnection
											provider={provider}
											onConnected={() => setApiKeySlug(null)}
										/>
									</div>
								</>
							);
						})()}
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
