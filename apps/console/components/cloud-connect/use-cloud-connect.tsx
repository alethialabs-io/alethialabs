"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	getAwsExternalId,
	saveAwsIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import {
	initAzureIdentity,
	saveAzureIdentity,
} from "@/app/(private)/dashboard/providers/azure-actions";
import {
	initGcpIdentity,
	saveGcpIdentity,
} from "@/app/(private)/dashboard/providers/gcp-actions";
import {
	initExtraCloudIdentity,
	saveAlibaba,
	saveTokenCloud,
} from "@/app/(private)/dashboard/providers/extra-cloud-actions";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { CONNECTOR_DOCS_BASE } from "@/components/connector/connector-assets";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { AwsConnection } from "@/components/connector/aws-connection";
import { AzureConnection } from "@/components/connector/azure-connection";
import { GcpConnection } from "@/components/connector/gcp-connection";
import {
	AlibabaConnection,
	TokenCloudConnection,
} from "@/components/connector/extra-cloud-connection";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { BookOpen, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The connectors-docs page for a connector — the Alethia connect guide (mirrors the
 * board's per-category docs links). Cloud-native big three + git get a dedicated page;
 * pluggable api_key providers share the pluggable guide; extra clouds fall to the index.
 */
function connectorDocsHref(integration: ConnectorWithConnection): string {
	const { slug } = integration;
	if (slug === "aws" || slug === "gcp" || slug === "azure") {
		return `${CONNECTOR_DOCS_BASE}/${slug}`;
	}
	if (integration.category === "git") return `${CONNECTOR_DOCS_BASE}/git-providers`;
	if (integration.auth_method === "api_key") return `${CONNECTOR_DOCS_BASE}/pluggable`;
	return CONNECTOR_DOCS_BASE;
}

/** Clouds connected by a scoped API token (no role-federation). */
export const TOKEN_CLOUDS = ["digitalocean", "hetzner", "civo"] as const;
export type TokenCloud = (typeof TOKEN_CLOUDS)[number];
/** Clouds that use the extra-cloud connect flow (token clouds + Alibaba's RAM role). */
export const EXTRA_CLOUDS = [...TOKEN_CLOUDS, "alibaba"] as const;

export const TOKEN_CLOUD_META: Record<
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

/**
 * Shared header for a connect-flow sheet — the provider's grayscale logo beside the title +
 * description, matching the manage sheet so connect and manage read as one family.
 */
export function ConnectSheetHeader({
	integration,
	title,
	description,
}: {
	integration?: ConnectorWithConnection;
	title: string;
	description: string;
}) {
	return (
		<SheetHeader className="border-b border-border/40 px-6 pb-4 pt-6">
			<div className="flex items-center gap-3.5">
				{integration && (
					<div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background p-2">
						{integration.category === "git" ? (
							<GitProviderIcon provider={integration.slug} size={26} />
						) : (
							<ConnectorIcon
								src={integration.icon_url}
								name={integration.name}
								size={28}
							/>
						)}
					</div>
				)}
				<div className="min-w-0">
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>{description}</SheetDescription>
				</div>
				{integration && (
					<a
						href={connectorDocsHref(integration)}
						target="_blank"
						rel="noopener noreferrer"
						className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
					>
						<BookOpen className="size-3.5" />
						Docs
						<ExternalLink className="size-3" />
					</a>
				)}
			</div>
		</SheetHeader>
	);
}

interface UseCloudConnectArgs {
	integrations: ConnectorWithConnection[];
	awsSetup: { externalId: string; identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
}

/**
 * The cloud connect flow, shared by the connectors board and the create-project cloud picker.
 * Owns the connect-sheet state + per-provider save handlers and renders the AWS/GCP/Azure/extra
 * connect sheets. Call {@link CloudConnectResult.openConnect} from a card's Connect action and
 * render {@link CloudConnectResult.sheets} once in the surface. Git/api-key/manage/disconnect are
 * intentionally NOT handled here — those stay on the connectors board.
 */
export interface CloudConnectResult {
	/** Opens the connect sheet for a cloud connector (re-inits a pending identity when adding another). */
	openConnect: (integration: ConnectorWithConnection) => Promise<void>;
	/** The slug currently mid-init (drives a per-card spinner). */
	connectingSlug: string | null;
	/** The connect sheets to render once in the host surface. */
	sheets: React.ReactNode;
}

export function useCloudConnect({
	integrations,
	awsSetup: awsSetupProp,
	gcpSetup: gcpSetupProp,
	azureSetup: azureSetupProp,
	extraSetup: extraSetupProp,
}: UseCloudConnectArgs): CloudConnectResult {
	const router = useRouter();

	const [awsSetup, setAwsSetup] = useState(awsSetupProp);
	const [gcpSetup, setGcpSetup] = useState(gcpSetupProp);
	const [azureSetup, setAzureSetup] = useState(azureSetupProp);
	const [extraSetup, setExtraSetup] = useState(extraSetupProp ?? {});

	const [awsSheetOpen, setAwsSheetOpen] = useState(false);
	const [gcpSheetOpen, setGcpSheetOpen] = useState(false);
	const [azureSheetOpen, setAzureSheetOpen] = useState(false);
	const [extraCloudSlug, setExtraCloudSlug] = useState<string | null>(null);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	/** Looks up a connector by slug — used to glyph the connect-sheet headers. */
	const bySlug = (slug: string | null | undefined) =>
		slug ? integrations.find((i) => i.slug === slug) : undefined;

	const openConnect = async (integration: ConnectorWithConnection) => {
		const slug = integration.slug;
		// Cloud providers bind the connect sheet to a pending identity. The page already seeded
		// one for the first connect, so reuse it — opening the sheet is then instant. Only
		// (re)initialise a fresh pending row when ADDING ANOTHER account, or if no seed exists.
		const addingAnother = integration.connected;
		try {
			if (slug === "aws") {
				if (!awsSetup || addingAnother) {
					setConnectingSlug(slug);
					setAwsSetup(await getAwsExternalId());
				}
				setAwsSheetOpen(true);
			} else if (slug === "gcp") {
				if (!gcpSetup || addingAnother) {
					setConnectingSlug(slug);
					setGcpSetup(await initGcpIdentity());
				}
				setGcpSheetOpen(true);
			} else if (slug === "azure") {
				if (!azureSetup || addingAnother) {
					setConnectingSlug(slug);
					setAzureSetup(await initAzureIdentity());
				}
				setAzureSheetOpen(true);
			} else if ((EXTRA_CLOUDS as readonly string[]).includes(slug)) {
				if (!extraSetup?.[slug] || addingAnother) {
					setConnectingSlug(slug);
					const init = await initExtraCloudIdentity(
						slug as (typeof EXTRA_CLOUDS)[number],
					);
					setExtraSetup((prev) => ({
						...prev,
						[slug]: { identityId: init.identityId, externalId: init.externalId },
					}));
				}
				setExtraCloudSlug(slug);
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : `Failed to start ${integration.name}`,
			);
		} finally {
			setConnectingSlug(null);
		}
	};

	const handleAwsConnect = async (roleArn: string) => {
		if (!awsSetup) throw new Error("AWS setup not initialized");
		return saveAwsIdentity(awsSetup.identityId, roleArn);
	};
	const handleGcpConnect = async (wifConfigJson: string) => {
		if (!gcpSetup) throw new Error("GCP setup not initialized");
		return saveGcpIdentity(gcpSetup.identityId, wifConfigJson);
	};
	const handleAzureConnect = async (
		tenantId: string,
		clientId: string,
		subscriptionId: string,
	) => {
		if (!azureSetup) throw new Error("Azure setup not initialized");
		return saveAzureIdentity(azureSetup.identityId, tenantId, clientId, subscriptionId);
	};
	const handleTokenCloudConnect = (provider: TokenCloud) => async (token: string) => {
		const setup = extraSetup?.[provider];
		if (!setup) throw new Error(`${provider} setup not initialized`);
		return saveTokenCloud(setup.identityId, provider, token);
	};
	const handleAlibabaConnect = async (roleArn: string) => {
		const setup = extraSetup?.alibaba;
		if (!setup) throw new Error("Alibaba setup not initialized");
		return saveAlibaba(setup.identityId, roleArn);
	};

	const sheets = (
		<>
			{/* AWS Connection Sheet */}
			<Sheet
				open={awsSheetOpen}
				onOpenChange={(open) => {
					setAwsSheetOpen(open);
					if (!open) router.refresh();
				}}
			>
				<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
					<ConnectSheetHeader
						integration={bySlug("aws")}
						title="Connect AWS Account"
						description="Set up a cross-account IAM role to allow Alethia to provision infrastructure in your AWS account."
					/>
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
				<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
					<ConnectSheetHeader
						integration={bySlug("gcp")}
						title="Connect GCP Project"
						description="Set up Workload Identity Federation to allow Alethia to provision infrastructure in your GCP project."
					/>
					<div className="px-6 py-6">
						{gcpSetup && <GcpConnection onComplete={handleGcpConnect} />}
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
				<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
					<ConnectSheetHeader
						integration={bySlug("azure")}
						title="Connect Azure Subscription"
						description="Set up federated identity credentials to allow Alethia to provision infrastructure in your Azure subscription."
					/>
					<div className="px-6 py-6">
						{azureSetup && <AzureConnection onComplete={handleAzureConnect} />}
					</div>
				</SheetContent>
			</Sheet>

			{/* Extra-cloud Connection Sheet */}
			<Sheet
				open={!!extraCloudSlug}
				onOpenChange={(open) => {
					if (!open) {
						setExtraCloudSlug(null);
						router.refresh();
					}
				}}
			>
				<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
					{extraCloudSlug === "alibaba" ? (
						<>
							<ConnectSheetHeader
								integration={bySlug("alibaba")}
								title="Connect Alibaba Cloud"
								description="Connect via a RAM role — Alethia stores no Alibaba credentials."
							/>
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
									<ConnectSheetHeader
										integration={bySlug(slug)}
										title={`Connect ${m.name}`}
										description="Connect with a scoped API token (encrypted at rest)."
									/>
									<div className="px-6 py-6">
										{extraSetup?.[slug] && (
											<TokenCloudConnection
												providerName={m.name}
												tokenHelp={m.tokenHelp}
												docsUrl={m.docsUrl}
												onSave={handleTokenCloudConnect(slug)}
											/>
										)}
									</div>
								</>
							);
						})()
					) : null}
				</SheetContent>
			</Sheet>
		</>
	);

	return { openConnect, connectingSlug, sheets };
}
