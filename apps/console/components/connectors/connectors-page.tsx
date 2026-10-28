"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asGitProvider } from "@/lib/connectors/git-providers";
import {
	deleteProviderToken,
	disconnectCloudAccount,
	renameCloudAccount,
	verifyCloudAccount,
} from "@/app/server/actions/identities";
import {
	deleteConnectorCredential,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { RegionError } from "@/components/errors/region-error";
import { connectorKeys, isRefused } from "@/components/connectors/connectors-board";
import { useConnectorsQuery } from "@/lib/query/use-connectors-query";
import { ConnectorsSkeleton } from "@/components/connectors/connectors-skeleton";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { ConnectorRow } from "@/components/connectors/connector-row";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import { ConnectorsFilterBar } from "@/components/connectors/connectors-filter-bar";
import {
	CONNECTOR_SEARCH_MAX,
	DEFAULT_CONNECTOR_FILTERS,
	GROUP_META,
	normalizeConnectorQuery,
} from "@/components/connectors/connectors-query";
import { ApiKeyConnection } from "@/components/connectors/api-key-connection";
import {
	ConnectSheetHeader,
	useCloudConnect,
} from "@/components/cloud-connect/use-cloud-connect";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import { connectRoute } from "@/lib/connectors/helpers";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useConnectorFilters } from "@/lib/stores/use-connector-filters";
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
import { SectionHeading } from "@repo/ui/section-heading";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { ViewToggle, type ViewMode } from "@repo/ui/view-toggle";
import { cn } from "@repo/ui/utils";
import { authClient } from "@/lib/auth/client";
import { track, captureException } from "@/lib/analytics/track";
import { BookOpen, CircleAlert, Loader2, SearchX, ShieldOff, Unplug } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Extracts a human-readable detail from an auth/link failure (a Better Auth `{status,code,message}`
 * object OR a thrown Error), so connect failures show the REAL cause instead of a generic toast.
 * Cast-free: reads known fields via `in`/typeof narrowing.
 */
function describeAuthError(e: unknown): string {
	const parts: (string | number)[] = [];
	if (e && typeof e === "object") {
		if ("status" in e && typeof e.status === "number") parts.push(e.status);
		if ("code" in e && typeof e.code === "string" && e.code) parts.push(e.code);
		if ("message" in e && typeof e.message === "string" && e.message) parts.push(e.message);
	} else if (typeof e === "string" && e) {
		parts.push(e);
	}
	return parts.length ? parts.join(" ") : "unknown error";
}

interface ConnectorsPageProps {
	orgSlug: string;
}

/** What the disconnect dialog is about to remove: a whole connector, or one of a cloud's accounts. */
interface DisconnectTarget {
	integration: ConnectorWithConnection;
	identityId?: string;
}

/**
 * Removes what `target` names, through the one action that owns it. ONE dialog dispatches to
 * three actions: a git link (`deleteProviderToken`), an api_key credential
 * (`deleteConnectorCredential`), or a cloud account (`disconnectCloudAccount`, whose provider is
 * the stored row's). A connector none of them owns is refused here rather than reported done.
 */
function disconnectConnector(target: DisconnectTarget): Promise<ActionResult<unknown>> {
	const { integration, identityId } = target;
	if (integration.category === "git") {
		return deleteProviderToken({ provider: asGitProvider(integration.slug) });
	}
	if (integration.category === "cloud") {
		const cloudId = identityId ?? integration.connection_details?.cloud_identity_id;
		if (!cloudId) {
			return Promise.resolve({
				ok: false,
				error: { kind: "not-found", message: `${integration.name} has no account to disconnect.` },
			});
		}
		return disconnectCloudAccount({ identityId: cloudId });
	}
	if (integration.auth_method === "api_key") {
		return deleteConnectorCredential({ slug: integration.slug });
	}
	return Promise.resolve({
		ok: false,
		error: {
			kind: "conflict",
			message: `No disconnect path for ${integration.slug}. This is a bug — please report it.`,
		},
	});
}

export function ConnectorsPage({ orgSlug }: ConnectorsPageProps) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const hydrated = useHydrated();

	const [viewMode, setViewMode] = useState<ViewMode>("card");
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);

	// ── The console filter standard (lib/query/README.md → "Server-side filters") ──────────
	// store → URL sync → debounce → normalize → the read's input (its key).
	const filters = useConnectorFilters((s) => s.filters);
	const patchFilters = useConnectorFilters((s) => s.patch);
	const resetFilters = useConnectorFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useConnectorFilters, DEFAULT_CONNECTOR_FILTERS);
	// `urlRead`: a search the link carried lands at once; only typing is debounced (#5861).
	const debouncedSearch = useDebouncedValue(filters.search, 250, { urlRead });
	const query = useMemo(
		() => normalizeConnectorQuery({ ...filters, search: debouncedSearch }),
		[filters, debouncedSearch],
	);

	// Deep-link: `?type=cloud` (from the overview "Add new → Cloud") lands filtered to Clouds.
	// Declared after the URL sync so the store is already hydrated from the URL when it runs.
	const typeHandledRef = useRef(false);
	useEffect(() => {
		if (typeHandledRef.current) return;
		typeHandledRef.current = true;
		if (searchParams.get("type") === "cloud") patchFilters({ groups: ["clouds"] });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only deep link
	}, []);

	// The board for this filter: prefetched by the route for the link's filter, live through the
	// `connectors` topic (no poll). The selection and the facet counts are the server's.
	const board = useConnectorsQuery(query);
	const integrations = useMemo(() => board.data?.integrations ?? [], [board.data]);
	const canManage = board.data?.canManage ?? false;
	const platformConfigured = useMemo(
		() => board.data?.platformConfigured ?? {},
		[board.data],
	);

	// Cloud connect flow (AWS/GCP/Azure/extra) — shared with the create-project cloud picker. Its
	// saves invalidate the board themselves, so the route is not refreshed when a sheet closes.
	const cloudConnect = useCloudConnect({ integrations, refreshRouteOnClose: false });

	const [apiKeySlug, setApiKeySlug] = useState<string | null>(null);
	const [disconnectTarget, setDisconnectTarget] = useState<DisconnectTarget | null>(null);
	const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

	// ── Writes (ADR 0005 D4): each invalidates every key that shows what it changed ───────────
	const reverify = useActionMutation(verifyCloudAccount, {
		invalidates: connectorKeys(),
		onSuccess: (result) => {
			if (result.verified) toast.success("Verified.");
			else toast.error(`Verification failed${result.error ? `: ${result.error}` : "."}`);
		},
	});
	const rename = useActionMutation(renameCloudAccount, {
		invalidates: connectorKeys(),
		successMessage: "Account renamed.",
	});
	const disconnect = useActionMutation(disconnectConnector, {
		invalidates: connectorKeys(),
		successMessage: (_data) =>
			disconnectTarget ? `Disconnected ${disconnectTarget.integration.name}.` : "Disconnected.",
		onSuccess: () => setDisconnectTarget(null),
	});

	const rows = board.data?.view.rows ?? [];
	const facets = board.data?.view.facets ?? { groups: [], health: [], vendors: [] };

	// The selected connector is derived from the live list (by slug) so the manage sheet reflects
	// fresh data after any change (disconnect / rename / add — or one another member made).
	const selectedIntegration = useMemo(
		() => integrations.find((i) => i.slug === selectedSlug) ?? null,
		[integrations, selectedSlug],
	);

	/** Looks up a connector by slug — used to glyph the connect-sheet headers. */
	const bySlug = (slug: string | null | undefined) =>
		slug ? integrations.find((i) => i.slug === slug) : undefined;

	/** Initiates the connect flow (or adds another cloud account). */
	const handleConnect = async (integration: ConnectorWithConnection) => {
		setDetailOpen(false);
		const slug = integration.slug;
		track("connector_connect_started", { provider: slug, category: integration.category });

		// Route by connect flow, category-first. A chain of `if`s here previously let the token clouds
		// (category `cloud`, auth_method `api_key`) fall into the api_key branch and open a blank sheet.
		switch (connectRoute(integration)) {
			case "git": {
				setConnectingSlug(slug);
				try {
					const provider = asGitProvider(slug);
					// ABSOLUTE, not relative. Better Auth validates a callbackURL against trustedOrigins:
					// an absolute URL matches by ORIGIN (window.location.origin is trusted), while a
					// RELATIVE one is checked against an allow-list regex whose char class excludes `~` —
					// so `/${org}/~/connectors` (the org tilde-route) 403s as INVALID_CALLBACK_URL. This
					// only surfaced on link (the origin check runs when a session cookie is present),
					// which is why login worked but Connect didn't.
					const callbackURL = `${window.location.origin}/${orgSlug}/~/connectors`;
					// `oauth2.link` was deleted in 1.7; generic providers link through
					// linkSocial like any other. Only github needs an explicit scope.
					const { error } = await authClient.linkSocial({
						provider,
						...(provider === "github" ? { scopes: ["repo"] } : {}),
						callbackURL,
					});
					// A successful link auto-redirects (Better Auth's redirect plugin), so reaching here
					// with an `error` — or a thrown exception — is always a failure. Hand the FULL error
					// object to the catch so we surface + capture its real status/code/message.
					if (error) throw error;
				} catch (err) {
					const detail = describeAuthError(err);
					// Report it: connector link failures were previously swallowed (generic toast only,
					// no capture), so they never reached PostHog and couldn't be diagnosed.
					captureException(err, { area: "connectors", provider: slug });
					console.error(`Error connecting ${slug}:`, err);
					toast.error(`Failed to connect ${integration.name}: ${detail}`);
				} finally {
					setConnectingSlug(null);
				}
				return;
			}
			case "cloud":
				// aws/gcp/azure AND the token clouds (hetzner/civo/digitalocean) → the shared sheet.
				await cloudConnect.openConnect(integration);
				return;
			case "api_key":
				setApiKeySlug(slug);
				return;
		}
	};

	// Deep-link: `?connect=<slug>` (e.g. from elench's connect action) auto-opens the connect sheet
	// once, then clears the param so a refresh doesn't reopen it. Waits for the board, which says
	// whether the viewer may connect and what the connector is.
	const connectHandledRef = useRef(false);
	useEffect(() => {
		if (connectHandledRef.current || !board.data || !canManage) return;
		const slug = searchParams.get("connect");
		if (!slug) return;
		connectHandledRef.current = true;
		const integration = integrations.find((i) => i.slug === slug);
		router.replace(`/${orgSlug}/~/connectors`, { scroll: false });
		// Don't auto-open a connect sheet for a connector that can't be connected yet — a `coming_soon`
		// cloud (DO/Civo) has no provisioning templates, so connecting it would be a dead end.
		if (integration && integration.status !== "coming_soon") {
			void handleConnect(integration);
		}
		// handleConnect is intentionally excluded — the ref makes this run once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams, integrations, board.data, canManage, orgSlug, router]);

	const openManage = (integration: ConnectorWithConnection) => {
		setSelectedSlug(integration.slug);
		setDetailOpen(true);
	};

	/** Re-runs a failed cloud verification with the stored configuration (no re-entry). */
	const handleReverify = (integration: ConnectorWithConnection) => {
		const identityId = integration.reverify_identity_id;
		if (!identityId || reverify.isPending) return;
		setConnectingSlug(integration.slug);
		reverify.mutate({ identityId }, { onSettled: () => setConnectingSlug(null) });
	};

	/** Re-verifies one specific cloud account from the manage sheet (a provider can hold several, and
	 *  only some of them may be broken). Settles either way; a failure was already reported. */
	const handleReverifyAccount = async (identityId: string) => {
		await reverify.mutateAsync({ identityId }).catch(() => undefined);
	};

	/** Renames a cloud account. Rejects on failure so the sheet keeps the name being edited. */
	const handleRename = async (identityId: string, name: string) => {
		await rename.mutateAsync({ identityId, name });
	};

	/** Confirms the dialog: one disconnect at a time (the button is disabled while it runs). */
	const confirmDisconnect = () => {
		if (!disconnectTarget || disconnect.isPending) return;
		disconnect.mutate(disconnectTarget);
	};

	// ── The four renders a read can have: pending, refused, failed, data ─────────────────────
	// A failed read is never shown as an empty board, nor as a skeleton that never ends.
	if (board.isPending) return <ConnectorsSkeleton />;
	if (board.isError && board.data === undefined) {
		return isRefused(board.error) ? (
			<EmptyState
				className="border"
				icon={<ShieldOff />}
				title="Sign in again to see connectors"
				description="Your session can no longer read this workspace. Sign in again; if you still cannot see connectors, ask an owner to check your membership."
			/>
		) : (
			<RegionError
				title="Couldn't load connectors"
				description="The connector list did not load. Your connections are unchanged."
				onRetry={() => void board.refetch()}
			/>
		);
	}

	return (
		<>
			<div className="space-y-6">
				{/* No title — the sidebar entry you clicked and the breadcrumb both say
				    "Connectors". What is left is the count and the line that says what a
				    connector IS, neither of which the breadcrumb carries. */}
				<PageToolbar
					description="Credentials Alethia acts through — cloud accounts, git providers, registries, chart repos, secret stores, observability sinks and DNS."
					count={rows.length}
				/>

				{/* Disabled until React has hydrated: before that, a keystroke lands in server HTML that
				    hydration then resets — the search the user typed (or a facet they opened) would be
				    silently dropped. Native `disabled` on the fieldset covers every control in the bar. */}
				<fieldset disabled={!hydrated} className="m-0 min-w-0 border-0 p-0">
					<ConnectorsFilterBar
						facets={facets}
						end={
							<>
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
							</>
						}
					/>
				</fieldset>

				{/* Always mounted, so a screen reader announces the hint when its text appears. */}
				<p role="status" className="-mt-4 text-ui-sm text-text-tertiary empty:hidden">
					{filters.search.trim().length > CONNECTOR_SEARCH_MAX
						? `Search uses the first ${CONNECTOR_SEARCH_MAX} characters.`
						: ""}
				</p>

				{/* A refresh failed behind a board already on screen (a live update, a refocus): the
				    cards stay — they are the last good answer — and this line says they may be stale.
				    A REFUSED refresh (the session ended, access was withdrawn) answers the same on every
				    retry, so it says so and offers no "Try again" that cannot work. */}
				{board.isError && board.data !== undefined && (
					<div
						data-slot="connectors-stale"
						role="status"
						className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-1.5 text-ui-sm text-text-secondary"
					>
						<span className="flex items-center gap-2">
							<CircleAlert className="size-3.5 shrink-0" aria-hidden />
							{isRefused(board.error)
								? "Sign in again to refresh — showing earlier data"
								: "Couldn't refresh — showing earlier data"}
						</span>
						{!isRefused(board.error) && (
							<Button variant="ghost" size="xs" onClick={() => void board.refetch()}>
								Try again
							</Button>
						)}
					</div>
				)}

				{/* Dim while a new filter's answer is resolving — keepPreviousData keeps the previous
				    rows on screen instead of flashing a skeleton. */}
				<div className={cn("space-y-6", board.isPlaceholderData && "opacity-60")}>
					{GROUP_META.map((group) => {
						const items = rows.filter((i) => i.group === group.id);
						if (items.length === 0) return null;
						const connected = items.filter((i) => i.connected).length;
						const Icon = group.icon;
						return (
							<section key={group.id} className="space-y-3.5">
								<div className="flex items-center gap-3">
									<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground">
										<Icon className="size-3.5" />
									</span>
									<SectionHeading level={2} title={group.label} count={items.length} />
									<a
										href={group.docsHref}
										target="_blank"
										rel="noopener noreferrer"
										title={`Learn about ${group.label.toLowerCase()} connectors`}
										className="text-text-tertiary transition-colors hover:text-foreground"
									>
										<BookOpen className="size-3.5" />
									</a>
									<span className="hidden max-w-[52ch] text-xs text-muted-foreground md:inline">
										{group.description}
									</span>
									<span className="ml-auto shrink-0 font-mono text-ui-2xs text-muted-foreground">
										{connected} connected
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
													platformConfigured[integration.slug] ?? true
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
															platformConfigured[integration.slug] ?? true
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

					{rows.length === 0 && (
						<EmptyState
							className="border"
							icon={<SearchX />}
							title="No connectors match"
							description={`None of the ${board.data?.view.total ?? 0} connectors in the catalog match these filters.`}
							action={
								<Button variant="outline" onClick={resetFilters}>
									Reset filters
								</Button>
							}
						/>
					)}
				</div>
			</div>

			<ConnectorDetailSheet
				integration={selectedIntegration}
				open={detailOpen}
				onOpenChange={setDetailOpen}
				canManage={canManage}
				platformConfigured={
					selectedIntegration ? (platformConfigured[selectedIntegration.slug] ?? true) : true
				}
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
					if (!open) setApiKeySlug(null);
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
				onOpenChange={(open) => {
					if (!open && !disconnect.isPending) setDisconnectTarget(null);
				}}
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
						<AlertDialogCancel disabled={disconnect.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								// Keep the dialog open until the action answers: it closes on success, and on a
								// refusal it stays with the toast so the user can cancel or retry.
								event.preventDefault();
								confirmDisconnect();
							}}
							disabled={disconnect.isPending}
						>
							{disconnect.isPending ? (
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
