"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	connectCloudAccount,
	startCloudConnect,
} from "@/app/server/actions/identities";
import type { ConnectSave } from "@/components/connectors/use-connection-test";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { isEnumMember } from "@/lib/coerce";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { CONNECTOR_DOCS_BASE } from "@/components/connectors/connector-assets";
import { ConnectorIcon, isThirdPartyMark } from "@/components/connectors/connector-icon";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { AwsConnection } from "@/components/connectors/aws-connection";
import { AzureConnection } from "@/components/connectors/azure-connection";
import { GcpConnection } from "@/components/connectors/gcp-connection";
import { HetznerConnection } from "@/components/connectors/hetzner-connection";
import {
	AlibabaConnection,
	TokenCloudConnection,
} from "@/components/connectors/extra-cloud-connection";
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

/**
 * The connectors-docs page for a connector — the Alethia connect guide (mirrors the
 * board's per-category docs links). Cloud-native clouds with a dedicated guide get their own
 * page; pluggable api_key providers share the pluggable guide; the rest fall to the index.
 */
function connectorDocsHref(integration: ConnectorWithConnection): string {
	const { slug } = integration;
	// Clouds with a dedicated connect guide. Hetzner is api_key-authed, so it must be matched
	// here before the generic api_key → /pluggable fallback below.
	if (
		slug === "aws" ||
		slug === "gcp" ||
		slug === "azure" ||
		slug === "alibaba" ||
		slug === "hetzner"
	) {
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
const EXTRA_CLOUDS = [...TOKEN_CLOUDS, "alibaba"] as const;
/** Every cloud this hook opens a connect sheet for. */
const CONNECTABLE_CLOUDS = ["aws", "gcp", "azure", ...EXTRA_CLOUDS] as const;

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
 * Shared header for a connect-flow sheet — the provider's logo beside the title +
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
							<GitProviderIcon provider={integration.slug} size={26} mono={false} />
						) : (
							<ConnectorIcon
								src={integration.icon_url}
								name={integration.name}
								size={28}
								mono={!isThirdPartyMark(integration.icon_url)}
								canLink
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
	/**
	 * Pending identities the host already created, so the first sheet opens without a round trip.
	 * Optional: without one, opening a sheet starts its own (`startCloudConnect`).
	 */
	awsSetup?: { identityId: string } | null;
	gcpSetup?: { identityId: string } | null;
	azureSetup?: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
	/**
	 * Re-render the route when a sheet closes. Right for a host whose server component renders the
	 * connector list (the create-project form); a host that reads the list through a query (the
	 * connectors board) passes `false` — a connect invalidates that query itself.
	 */
	refreshRouteOnClose?: boolean;
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
	refreshRouteOnClose = true,
}: UseCloudConnectArgs): CloudConnectResult {
	const router = useRouter();
	/** What closing a connect sheet does to the host (see `refreshRouteOnClose`). */
	const onSheetClosed = () => {
		if (refreshRouteOnClose) router.refresh();
	};

	const [awsSetup, setAwsSetup] = useState(awsSetupProp ?? null);
	const [gcpSetup, setGcpSetup] = useState(gcpSetupProp ?? null);
	const [azureSetup, setAzureSetup] = useState(azureSetupProp ?? null);
	const [extraSetup, setExtraSetup] = useState(extraSetupProp ?? {});

	const [awsSheetOpen, setAwsSheetOpen] = useState(false);
	const [gcpSheetOpen, setGcpSheetOpen] = useState(false);
	const [azureSheetOpen, setAzureSheetOpen] = useState(false);
	const [extraCloudSlug, setExtraCloudSlug] = useState<string | null>(null);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	/** Looks up a connector by slug — used to glyph the connect-sheet headers. */
	const bySlug = (slug: string | null | undefined) =>
		slug ? integrations.find((i) => i.slug === slug) : undefined;

	// Starting a connect creates (or reuses) the pending identity the sheet binds to. It shows no
	// data, so it invalidates nothing; a refusal is toasted by the mutation's policy.
	const start = useActionMutation(startCloudConnect, { invalidates: [] });

	const openConnect = async (integration: ConnectorWithConnection) => {
		const slug = integration.slug;
		if (start.isPending) return;
		// Cloud providers bind the connect sheet to a pending identity. Reuse one the host seeded for
		// the first connect, so opening the sheet is instant. Start a fresh one when ADDING ANOTHER
		// account, or when none was seeded.
		const addingAnother = integration.connected;
		const begin = async () => {
			if (!isEnumMember(slug, CONNECTABLE_CLOUDS)) return null;
			setConnectingSlug(slug);
			try {
				return await start.mutateAsync({ provider: slug });
			} catch {
				return null; // refused or failed — already reported by the mutation
			} finally {
				setConnectingSlug(null);
			}
		};
		if (slug === "aws") {
			const setup = !awsSetup || addingAnother ? await begin() : awsSetup;
			if (!setup) return;
			setAwsSetup({ identityId: setup.identityId });
			setAwsSheetOpen(true);
		} else if (slug === "gcp") {
			const setup = !gcpSetup || addingAnother ? await begin() : gcpSetup;
			if (!setup) return;
			setGcpSetup({ identityId: setup.identityId });
			setGcpSheetOpen(true);
		} else if (slug === "azure") {
			const setup = !azureSetup || addingAnother ? await begin() : azureSetup;
			if (!setup) return;
			setAzureSetup({ identityId: setup.identityId });
			setAzureSheetOpen(true);
		} else if (isEnumMember(slug, EXTRA_CLOUDS)) {
			const existing = extraSetup?.[slug];
			const setup = !existing || addingAnother ? await begin() : existing;
			if (!setup) return;
			setExtraSetup((prev) => ({
				...prev,
				[slug]: { identityId: setup.identityId, externalId: setup.externalId },
			}));
			setExtraCloudSlug(slug);
		}
	};

	/** The save of a sheet whose connect session never started — reported in the sheet, not thrown. */
	const noSession = (provider: string): ReturnType<ConnectSave> =>
		Promise.resolve({
			ok: false,
			error: { kind: "conflict", message: `The ${provider} connect session was not started. Close the sheet and try again.` },
		});

	const handleAwsConnect = (roleArn: string): ReturnType<ConnectSave> =>
		awsSetup
			? connectCloudAccount({ method: "aws", identityId: awsSetup.identityId, roleArn })
			: noSession("AWS");
	const handleGcpConnect = (wifConfigJson: string): ReturnType<ConnectSave> =>
		gcpSetup
			? connectCloudAccount({ method: "gcp-wif", identityId: gcpSetup.identityId, wifConfigJson })
			: noSession("GCP");
	const handleGcpFromIds = (projectId: string, projectNumber: string): ReturnType<ConnectSave> =>
		gcpSetup
			? connectCloudAccount({ method: "gcp-ids", identityId: gcpSetup.identityId, projectId, projectNumber })
			: noSession("GCP");
	const handleAzureConnect = (tenantId: string, clientId: string, subscriptionId: string): ReturnType<ConnectSave> =>
		azureSetup
			? connectCloudAccount({
						method: "azure",
						identityId: azureSetup.identityId,
						tenantId,
						clientId,
						subscriptionId,
					})
			: noSession("Azure");
	const handleTokenCloudConnect =
		(provider: TokenCloud) =>
		(token: string): ReturnType<ConnectSave> => {
			const setup = extraSetup?.[provider];
			return setup
				? connectCloudAccount({ method: "token", identityId: setup.identityId, provider, token })
				: noSession(TOKEN_CLOUD_META[provider].name);
		};
	// Hetzner also accepts an optional Object Storage S3 key pair (manual, no mint API),
	// threaded through the same token-cloud save so bucket provisioning has S3 credentials.
	const handleHetznerConnect = (token: string, s3AccessKey?: string, s3SecretKey?: string): ReturnType<ConnectSave> => {
		const setup = extraSetup?.hetzner;
		return setup
			? connectCloudAccount({
						method: "token",
						identityId: setup.identityId,
						provider: "hetzner",
						token,
						s3AccessKey,
						s3SecretKey,
					})
			: noSession("Hetzner");
	};
	const handleAlibabaConnect = (roleArn: string): ReturnType<ConnectSave> => {
		const setup = extraSetup?.alibaba;
		return setup
			? connectCloudAccount({ method: "alibaba", identityId: setup.identityId, roleArn })
			: noSession("Alibaba Cloud");
	};

	const sheets = (
		<>
			{/* AWS Connection Sheet */}
			<Sheet
				open={awsSheetOpen}
				onOpenChange={(open) => {
					setAwsSheetOpen(open);
					if (!open) onSheetClosed();
				}}
			>
				<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
					<ConnectSheetHeader
						integration={bySlug("aws")}
						title="Connect AWS Account"
						description="Create a keyless IAM role that trusts the Alethia issuer, so Alethia can provision infrastructure in your AWS account."
					/>
					<div className="px-6 py-6">
						{awsSetup && <AwsConnection onComplete={handleAwsConnect} />}
					</div>
				</SheetContent>
			</Sheet>

			{/* GCP Connection Sheet */}
			<Sheet
				open={gcpSheetOpen}
				onOpenChange={(open) => {
					setGcpSheetOpen(open);
					if (!open) onSheetClosed();
				}}
			>
				<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
					<ConnectSheetHeader
						integration={bySlug("gcp")}
						title="Connect GCP Project"
						description="Set up Workload Identity Federation to allow Alethia to provision infrastructure in your GCP project."
					/>
					<div className="px-6 py-6">
						{gcpSetup && (
							<GcpConnection
								onCompleteFromIds={handleGcpFromIds}
								onComplete={handleGcpConnect}
							/>
						)}
					</div>
				</SheetContent>
			</Sheet>

			{/* Azure Connection Sheet */}
			<Sheet
				open={azureSheetOpen}
				onOpenChange={(open) => {
					setAzureSheetOpen(open);
					if (!open) onSheetClosed();
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
						onSheetClosed();
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
									<AlibabaConnection onSave={handleAlibabaConnect} />
								)}
							</div>
						</>
					) : extraCloudSlug === "hetzner" ? (
						<>
							<ConnectSheetHeader
								integration={bySlug("hetzner")}
								title="Connect Hetzner Cloud"
								description="Connect with a scoped API token (encrypted at rest) to provision a Talos Kubernetes cluster."
							/>
							<div className="px-6 py-6">
								{extraSetup?.hetzner && (
									<HetznerConnection onSave={handleHetznerConnect} />
								)}
							</div>
						</>
					) : extraCloudSlug && isEnumMember(extraCloudSlug, TOKEN_CLOUDS) ? (
						(() => {
							const slug = extraCloudSlug;
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
