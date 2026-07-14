"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	disconnectAwsIdentity,
	renameCloudIdentity,
	reverifyCloudIdentity,
} from "@/app/(private)/dashboard/providers/actions";
import { disconnectAzureIdentity } from "@/app/(private)/dashboard/providers/azure-actions";
import { disconnectGcpIdentity } from "@/app/(private)/dashboard/providers/gcp-actions";
import { disconnectExtraCloud } from "@/app/(private)/dashboard/providers/extra-cloud-actions";
import { deleteProviderToken } from "@/app/server/actions/identities";
import {
	deleteConnectorCredential,
	type ConnectorGroup,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { ConnectorRow } from "@/components/connectors/connector-row";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import { ApiKeyConnection } from "@/components/connector/api-key-connection";
import {
	ConnectSheetHeader,
	EXTRA_CLOUDS,
	useCloudConnect,
} from "@/components/cloud-connect/use-cloud-connect";
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
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { ViewToggle, type ViewMode } from "@repo/ui/view-toggle";
import { authClient } from "@/lib/auth/client";
import { track } from "@/lib/analytics/track";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import {
	BookOpen,
	Boxes,
	Cloud,
	Container,
	KeyRound,
	Loader2,
	Search,
	Unplug,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface ConnectorsPageProps {
	orgSlug: string;
	canManage: boolean;
	integrations: ConnectorWithConnection[];
	awsSetup: { identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
	/** Per-slug: does this instance have the platform creds the cloud's probe needs. */
	platformConfigured?: Record<string, boolean>;
}

type GroupFilter = "all" | ConnectorGroup;

const GROUP_META: {
	id: ConnectorGroup;
	label: string;
	description: string;
	icon: typeof Cloud;
	docsHref: string;
}[] = [
	{
		id: "clouds",
		label: "Clouds",
		description:
			"Provider accounts Alethia provisions into, via short-lived federated credentials.",
		icon: Cloud,
		docsHref: "/docs/console/connectors",
	},
	{
		id: "secrets",
		label: "Secrets",
		description:
			"Where Projects read secrets at deploy time — fetched just-in-time, never written to state.",
		icon: KeyRound,
		docsHref: "/docs/console/connectors/pluggable",
	},
	{
		id: "registries",
		label: "Registries",
		description:
			"Container registries clusters pull from. Pull credentials are injected & rotated automatically.",
		icon: Container,
		docsHref: "/docs/console/connectors/pluggable",
	},
	{
		id: "apps",
		label: "Apps",
		description:
			"Git, observability and DNS services Alethia connects to and acts through.",
		icon: Boxes,
		docsHref: "/docs/console/connectors/git-providers",
	},
];

export function ConnectorsPage({
	orgSlug,
	canManage,
	integrations,
	awsSetup: awsSetupProp,
	gcpSetup: gcpSetupProp,
	azureSetup: azureSetupProp,
	extraSetup: extraSetupProp,
	platformConfigured,
}: ConnectorsPageProps) {
	const router = useRouter();
	// Passive refresh: pick up sweep-driven connection-status changes (connected → degraded/disconnected,
	// or backfilled inventory) without a manual reload. Soft-refresh only while the tab is visible.
	useEffect(() => {
		const id = setInterval(() => {
			if (document.visibilityState === "visible") router.refresh();
		}, 30_000);
		return () => clearInterval(id);
	}, [router]);
	// Deep-link: `?type=cloud` (from the overview "Add new → Cloud") opens filtered to Clouds.
	const searchParams = useSearchParams();
	const initialGroup: GroupFilter =
		searchParams.get("type") === "cloud" ? "clouds" : "all";
	const [activeGroup, setActiveGroup] = useState<GroupFilter>(initialGroup);
	const [searchQuery, setSearchQuery] = useState("");
	const [viewMode, setViewMode] = useState<ViewMode>("card");
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);

	// Cloud connect flow (AWS/GCP/Azure/extra) — shared with the create-project cloud picker.
	const cloudConnect = useCloudConnect({
		integrations,
		awsSetup: awsSetupProp,
		gcpSetup: gcpSetupProp,
		azureSetup: azureSetupProp,
		extraSetup: extraSetupProp,
	});

	const [apiKeySlug, setApiKeySlug] = useState<string | null>(null);
	const [disconnectTarget, setDisconnectTarget] = useState<{
		integration: ConnectorWithConnection;
		identityId?: string;
	} | null>(null);
	const [isDisconnecting, setIsDisconnecting] = useState(false);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	// The selected connector is derived from the live list (by slug) so the manage
	// sheet reflects fresh data after a router.refresh() (disconnect / rename / add).
	const selectedIntegration = useMemo(
		() => integrations.find((i) => i.slug === selectedSlug) ?? null,
		[integrations, selectedSlug],
	);

	/** Looks up a connector by slug — used to glyph the connect-sheet headers. */
	const bySlug = (slug: string | null | undefined) =>
		slug ? integrations.find((i) => i.slug === slug) : undefined;

	const groupCounts = useMemo(() => {
		const counts: Record<string, number> = { all: integrations.length };
		for (const i of integrations) counts[i.group] = (counts[i.group] ?? 0) + 1;
		return counts;
	}, [integrations]);

	const filtered = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		return integrations.filter((i) => {
			if (activeGroup !== "all" && i.group !== activeGroup) return false;
			if (!q) return true;
			return (
				i.name.toLowerCase().includes(q) ||
				i.description.toLowerCase().includes(q) ||
				i.organization.toLowerCase().includes(q)
			);
		});
	}, [integrations, activeGroup, searchQuery]);

	/** Initiates the connect flow (or adds another cloud account). */
	const handleConnect = async (integration: ConnectorWithConnection) => {
		setDetailOpen(false);
		const slug = integration.slug;
		track("connector_connect_started", { provider: slug, category: integration.category });

		if (integration.category === "git") {
			setConnectingSlug(slug);
			try {
				const provider = slug as PublicGitProvider;
				const callbackURL = `/${orgSlug}/~/connectors`;
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
				console.error(`Error linking ${slug}:`, err);
				toast.error(`Failed to connect ${integration.name}`);
			} finally {
				setConnectingSlug(null);
			}
			return;
		}

		if (integration.auth_method === "api_key") {
			setApiKeySlug(slug);
			return;
		}

		// Cloud providers (aws/gcp/azure/extra) → the shared connect-sheet flow.
		await cloudConnect.openConnect(integration);
	};

	// Deep-link: `?connect=<slug>` (e.g. from elench's connect action) auto-opens the connect sheet once,
	// then clears the param so a refresh doesn't reopen it. handleConnect routes by category.
	const connectHandledRef = useRef(false);
	useEffect(() => {
		if (connectHandledRef.current || !canManage) return;
		const slug = searchParams.get("connect");
		if (!slug) return;
		connectHandledRef.current = true;
		const integration = integrations.find((i) => i.slug === slug);
		router.replace(`/${orgSlug}/~/connectors`, { scroll: false });
		if (integration) void handleConnect(integration);
		// handleConnect is intentionally excluded — the ref makes this run once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams, integrations, canManage, orgSlug, router]);

	const openManage = (integration: ConnectorWithConnection) => {
		setSelectedSlug(integration.slug);
		setDetailOpen(true);
	};

	/** Re-runs a failed cloud verification with the stored credentials (no re-entry). */
	const handleReverify = async (integration: ConnectorWithConnection) => {
		if (!integration.reverify_identity_id) return;
		setConnectingSlug(integration.slug);
		try {
			await reverifyCloudIdentity(integration.reverify_identity_id);
			toast.success(`Re-verifying ${integration.name}…`);
			router.refresh();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : `Failed to re-verify ${integration.name}`,
			);
		} finally {
			setConnectingSlug(null);
		}
	};

	/** Re-verifies one specific cloud account from the manage sheet (a provider can hold several, and
	 *  only some of them may be broken). */
	const handleReverifyAccount = async (identityId: string) => {
		try {
			await reverifyCloudIdentity(identityId);
			toast.success("Re-verifying…");
			router.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to re-verify");
		}
	};

	/** Renames a cloud account, then refreshes so the sheet shows the new name. */
	const handleRename = async (identityId: string, name: string) => {
		try {
			await renameCloudIdentity(identityId, name);
			toast.success("Account renamed.");
			router.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to rename");
		}
	};

	const confirmDisconnect = async () => {
		if (!disconnectTarget) return;
		const { integration, identityId } = disconnectTarget;
		setIsDisconnecting(true);
		try {
			const cloudId =
				identityId ?? integration.connection_details?.cloud_identity_id;
			if (integration.category === "git") {
				const result = await deleteProviderToken(
					integration.slug as PublicGitProvider,
				);
				if (result.error) throw new Error(result.error);
			} else if (integration.slug === "aws") {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectAwsIdentity(cloudId);
			} else if (integration.slug === "gcp") {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectGcpIdentity(cloudId);
			} else if (integration.slug === "azure") {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectAzureIdentity(cloudId);
			} else if ((EXTRA_CLOUDS as readonly string[]).includes(integration.slug)) {
				if (!cloudId) throw new Error("Missing identity ID");
				await disconnectExtraCloud(
					cloudId,
					integration.slug as (typeof EXTRA_CLOUDS)[number],
				);
			} else if (integration.auth_method === "api_key") {
				const result = await deleteConnectorCredential(integration.slug);
				if (!result.ok) throw new Error(result.error);
			} else {
				// No branch matched — a new connector slug that nothing above handles. Fail loudly rather
				// than falling through to the success toast below having done nothing.
				throw new Error(
					`No disconnect path for ${integration.slug}. This is a bug — please report it.`,
				);
			}
			toast.success(`Disconnected ${integration.name}.`);
			setDisconnectTarget(null);
			router.refresh();
		} catch (err) {
			console.error("Disconnect error:", err);
			// Surface the real reason. A ForbiddenError and a provider mismatch used to render as the
			// same opaque string, which made a failed disconnect impossible to act on.
			toast.error(
				err instanceof Error
					? err.message
					: `Failed to disconnect ${integration.name}`,
			);
		} finally {
			setIsDisconnecting(false);
		}
	};

	const visibleGroups = GROUP_META.filter(
		(g) => activeGroup === "all" || g.id === activeGroup,
	);

	return (
		<>
			<div className="space-y-6">
				{/* top bar — group filter + search + view toggle + docs */}
				<div className="flex items-center gap-3">
					<Select
						value={activeGroup}
						onValueChange={(v) =>
							setActiveGroup(
								v === "all"
									? "all"
									: (GROUP_META.find((g) => g.id === v)?.id ?? "all"),
							)
						}
					>
						<SelectTrigger className="h-9 w-44 shrink-0 rounded-md border-border/60 bg-muted/20">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{[
								{ id: "all" as GroupFilter, label: "All" },
								...GROUP_META.map((g) => ({
									id: g.id as GroupFilter,
									label: g.label,
								})),
							].map((opt) => (
								<SelectItem key={opt.id} value={opt.id}>
									<span className="flex w-full items-center justify-between gap-3">
										<span>{opt.label}</span>
										<span className="font-mono text-[10px] text-muted-foreground">
											{groupCounts[opt.id] ?? 0}
										</span>
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="relative flex-1">
						<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder="Search connectors"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="h-9 border-border/60 bg-muted/20 pl-9 text-sm"
						/>
					</div>
					<ViewToggle value={viewMode} onChange={setViewMode} />
					<a
						href="/docs/concepts/connectors"
						target="_blank"
						rel="noopener noreferrer"
						title="What are connectors?"
						className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground transition-colors hover:text-foreground"
					>
						<BookOpen className="size-4" />
						<span className="sr-only">What are connectors?</span>
					</a>
				</div>

				{visibleGroups.map((group) => {
					const items = filtered.filter((i) => i.group === group.id);
					if (items.length === 0) return null;
					const connected = items.filter((i) => i.connected).length;
					const Icon = group.icon;
					return (
						<section key={group.id} className="space-y-3.5">
							<div className="flex items-center gap-3">
								<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground">
									<Icon className="size-3.5" />
								</span>
								<h2 className="font-display text-[15px] font-semibold tracking-tight">
									{group.label}
								</h2>
								<a
									href={group.docsHref}
									target="_blank"
									rel="noopener noreferrer"
									title={`Learn about ${group.label.toLowerCase()} connectors`}
									className="text-muted-foreground/70 transition-colors hover:text-foreground"
								>
									<BookOpen className="size-3.5" />
								</a>
								<span className="hidden max-w-[52ch] text-xs text-muted-foreground md:inline">
									{group.description}
								</span>
								<span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
									{connected} / {items.length} connected
								</span>
							</div>

							{viewMode === "card" ? (
								<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
									{items.map((integration) => (
										<ConnectorCard
											key={integration.id}
											integration={integration}
											canManage={canManage}
											platformConfigured={
												platformConfigured?.[integration.slug] ?? true
											}
											isConnecting={
													connectingSlug === integration.slug ||
													cloudConnect.connectingSlug === integration.slug
												}
											onConnect={() => handleConnect(integration)}
											onManage={() => openManage(integration)}
											onReverify={() => handleReverify(integration)}
										/>
									))}
								</div>
							) : (
								<div className="overflow-hidden rounded-xl border border-border/60">
									<Table>
										<TableHeader>
											<TableRow className="hover:bg-transparent">
												<TableHead>Connector</TableHead>
												<TableHead>Status</TableHead>
												<TableHead>Details</TableHead>
												<TableHead className="text-right">Action</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{items.map((integration) => (
												<ConnectorRow
													key={integration.id}
													integration={integration}
													canManage={canManage}
													platformConfigured={
														platformConfigured?.[integration.slug] ?? true
													}
													isConnecting={
													connectingSlug === integration.slug ||
													cloudConnect.connectingSlug === integration.slug
												}
													onConnect={() => handleConnect(integration)}
													onManage={() => openManage(integration)}
													onReverify={() => handleReverify(integration)}
												/>
											))}
										</TableBody>
									</Table>
								</div>
							)}
						</section>
					);
				})}

				{filtered.length === 0 && (
					<div className="py-14 text-center text-sm text-muted-foreground">
						No connectors match your search.
					</div>
				)}
			</div>

			<ConnectorDetailSheet
				integration={selectedIntegration}
				open={detailOpen}
				onOpenChange={setDetailOpen}
				canManage={canManage}
				isConnecting={
					selectedIntegration
						? connectingSlug === selectedIntegration.slug
						: false
				}
				onConnect={() =>
					selectedIntegration && handleConnect(selectedIntegration)
				}
				onDisconnectConnector={() =>
					selectedIntegration &&
					setDisconnectTarget({ integration: selectedIntegration })
				}
				onDisconnectAccount={(identityId) =>
					selectedIntegration &&
					setDisconnectTarget({ integration: selectedIntegration, identityId })
				}
				onReverifyAccount={handleReverifyAccount}
				onRenameAccount={handleRename}
			/>

			{cloudConnect.sheets}

			{/* api_key Connection Sheet */}
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
					className="w-full overflow-y-auto p-0 sm:max-w-md"
				>
					{apiKeySlug &&
						(() => {
							const provider = getConnectorProviderBySlug(apiKeySlug);
							if (!provider) return null;
							return (
								<>
									<ConnectSheetHeader
										integration={bySlug(apiKeySlug)}
										title={`Connect ${provider.name}`}
										description="Provide an API credential. It is encrypted at rest and shared with your organization."
									/>
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

			{/* Disconnect confirmation */}
			<AlertDialog
				open={!!disconnectTarget}
				onOpenChange={(open) => !open && setDisconnectTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect {disconnectTarget?.integration.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{disconnectTarget?.integration.category === "cloud"
								? "This removes the stored connection. You won't be able to provision new infrastructure with this account until you reconnect. Existing resources are not affected."
								: disconnectTarget?.integration.category === "git"
									? `This unlinks your ${disconnectTarget?.integration.name} account. You won't be able to access its repositories until you reconnect.`
									: "This removes the stored credential for the whole organization. You won't be able to use this connector until you reconnect."}
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
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
							) : (
								<Unplug className="mr-1.5 size-3.5" />
							)}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
