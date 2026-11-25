"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asGitProvider } from "@/lib/connectors/git-providers";
import {
	deleteProviderToken,
	disconnectCloudAccount,
	verifyCloudAccount,
} from "@/app/server/actions/identities";
import {
	deleteConnectorCredential,
	type ConnectorWithConnection,
} from "@/app/server/actions/connectors";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { boardRefusalOf, connectorKeys } from "@/components/connectors/connectors-board";
import { useConnectorsQuery } from "@/lib/query/use-connectors-query";
import { orpc } from "@/lib/rpc/client";
import { ConnectorsSkeleton } from "@/components/connectors/connectors-skeleton";
import { ConnectorCard } from "@/components/connectors/connector-card";
import { ConnectorRow } from "@/components/connectors/connector-row";
import { ConnectorDetailSheet } from "@/components/connectors/connector-detail-sheet";
import {
	ConnectorsDisconnectDialog,
	type DisconnectTarget,
} from "@/components/connectors/connectors-disconnect-dialog";
import { ConnectorsFilterBar } from "@/components/connectors/connectors-filter-bar";
import { gitLinkFailureMessage } from "@/components/connectors/connectors-link-error";
import {
	CONNECTOR_SEARCH_MAX,
	DEFAULT_CONNECTOR_FILTERS,
	GROUP_META,
	acceptsNewConnections,
	buildConnectorsView,
	connectorState,
	listedConnectors,
	normalizeConnectorQuery,
} from "@/components/connectors/connectors-query";
import { ApiKeyConnection } from "@/components/connectors/api-key-connection";
import {
	ConnectSheetHeader,
	useCloudConnect,
} from "@/components/cloud-connect/use-cloud-connect";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import { connectRoute } from "@/lib/connectors/helpers";
import { CLOUD_ACCOUNT, sentenceStart } from "@/lib/copy/vocabulary";
import { hrefWithParamPatch, readViewParam } from "@/lib/query/view-url-params";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHydrated } from "@repo/ui/use-hydrated";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useConnectorFilters } from "@/lib/stores/use-connector-filters";
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
import { BookOpen, CircleAlert, Plug, SearchX } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface ConnectorsPageProps {
	orgSlug: string;
}

/** The param that carries the board's layout. Absent is the card grid, the default. */
const VIEW_PARAM = "view";

/** The param a link uses to open a connector's connect flow on arrival. */
const CONNECT_PARAM = "connect";

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
			message: `${integration.name} cannot be disconnected from here. Contact support.`,
		},
	});
}

/**
 * What a `?connect=<slug>` link resolved to, once the board could say: the connector whose connect
 * flow to open, or the sentence for why none is opened.
 */
type ConnectLink =
	| { kind: "open"; integration: ConnectorWithConnection }
	| { kind: "refused"; message: string };

/**
 * Resolves a connect link against the board. A link is opened only where the board's own Connect
 * button would be live: the connector is listed, takes a new connection on this deployment, is
 * neither coming soon nor unavailable on this instance, and the viewer may manage connections.
 * Anything else is a sentence, so a link that does nothing still says why.
 */
function resolveConnectLink(
	integration: ConnectorWithConnection | undefined,
	offeredClouds: readonly string[],
	platformConfigured: boolean,
	canManage: boolean,
): ConnectLink {
	if (!integration) {
		return { kind: "refused", message: "This link names a connector that is not available here." };
	}
	if (!acceptsNewConnections(integration, offeredClouds)) {
		return {
			kind: "refused",
			message: `${integration.name} is not available for new projects in this release.`,
		};
	}
	const { health } = connectorState(integration, platformConfigured);
	if (health === "coming_soon") {
		return { kind: "refused", message: `${integration.name} is not available yet.` };
	}
	if (health === "unavailable") {
		return { kind: "refused", message: `${integration.name} is not enabled on this instance.` };
	}
	if (!canManage) return { kind: "refused", message: MANAGE_DENIED_REASON };
	return { kind: "open", integration };
}

/**
 * The connectors board (`/{org}/~/connectors`): the catalog in its groups, each connector with its
 * state and its one action, the manage sheet, the connect sheets and the disconnect confirmation.
 *
 * WHAT IT RENDERS FROM. One read, `connectors.board`: the rows for the link's filter, the facet
 * counts, the catalog with this organization's connections, whether the viewer may manage them
 * (`canManage`), and the clouds a new connection is accepted for (`offeredClouds`). The page keeps
 * no list of clouds and no permission rule of its own.
 */
export function ConnectorsPage({ orgSlug }: ConnectorsPageProps) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const hydrated = useHydrated();

	// The layout is part of the link (`?view=table`), like the filters: a refresh, Back and a
	// pasted URL all reproduce it. It used to be component state and reset to cards on every load.
	const viewMode: ViewMode =
		readViewParam(searchParams, VIEW_PARAM) === "table" ? "table" : "card";
	/** Writes the layout into the URL; the card grid, the default, removes the param. */
	const setViewMode = (mode: ViewMode) => {
		router.replace(
			hrefWithParamPatch(pathname, searchParams.toString(), {
				[VIEW_PARAM]: mode === "card" ? null : mode,
			}),
			{ scroll: false },
		);
	};

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
	const canManage = board.data?.canManage ?? false;
	const platformConfigured = useMemo(
		() => board.data?.platformConfigured ?? {},
		[board.data],
	);
	// The clouds a NEW connection is accepted for, as the server answered. Nothing here keeps a
	// list of its own, so the page cannot offer a Connect the server would refuse.
	const offeredClouds = useMemo(() => board.data?.offeredClouds ?? [], [board.data]);
	const catalog = useMemo(() => board.data?.integrations ?? [], [board.data]);
	// The connectors this board lists (`listedConnectors`): the catalog, less a connector that
	// only works from a cluster in a cloud that is not offered here.
	const integrations = useMemo(
		() => listedConnectors(catalog, offeredClouds),
		[catalog, offeredClouds],
	);
	// The rows, the facet counts and the catalog's size (which only tells the two empty states
	// apart — it is never drawn). They are the server's while every catalog row is
	// listed. When one was left out they are rebuilt from the listed rows for the SAME query, by
	// the same pure builder the server ran — so a count never includes a connector that is not on
	// the board, and the facets still come from the unfiltered (listed) universe.
	const view = useMemo(() => {
		if (!board.data) return null;
		if (integrations.length === catalog.length) return board.data.view;
		return buildConnectorsView(integrations, board.data.view.query, platformConfigured);
	}, [board.data, integrations, catalog, platformConfigured]);
	const rows = view?.rows ?? [];
	const facets = view?.facets ?? { groups: [], health: [], vendors: [] };
	const total = view?.total ?? 0;

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
			// The reason a verification failed is the account's own `lastError`, which the manage
			// sheet prints under the account once the board has re-read. It is not repeated here.
			if (result.verified) toast.success(`${sentenceStart(CLOUD_ACCOUNT.one)} verified.`);
			else toast.error("Verification failed. Open Manage to read the reason on the account.");
		},
	});
	const disconnect = useActionMutation(disconnectConnector, {
		// A disconnected cloud account also leaves its projects without one, so they are re-read.
		invalidates: [...connectorKeys(), orpc.workspace.projects.key()],
		onSuccess: (_data, target) => {
			toast.success(`Disconnected ${target.integration.name}.`);
		},
	});

	// The selected connector is derived from the live list (by slug) so the manage sheet reflects
	// fresh data after any change (disconnect / rename / add — or one another member made).
	const selectedIntegration = useMemo(
		() => integrations.find((i) => i.slug === selectedSlug) ?? null,
		[integrations, selectedSlug],
	);

	/** Looks up a connector by slug — used to glyph the connect-sheet headers. */
	const bySlug = (slug: string | null | undefined) =>
		slug ? integrations.find((i) => i.slug === slug) : undefined;

	/**
	 * The connect flow's own UI state: a git connector's row spins, an api-key connector's sheet
	 * opens. Split from `runConnect` so the `?connect=` deep link can set it while rendering.
	 */
	const markConnecting = (integration: ConnectorWithConnection) => {
		const route = connectRoute(integration);
		if (route === "git") setConnectingSlug(integration.slug);
		else if (route === "api_key") setApiKeySlug(integration.slug);
	};

	/** The connect flow's side effects, for a connector `markConnecting` has already marked. */
	const runConnect = async (integration: ConnectorWithConnection) => {
		const slug = integration.slug;
		track("connector_connect_started", { provider: slug, category: integration.category });

		// Route by connect flow, category-first. A chain of `if`s here previously let the token clouds
		// (category `cloud`, auth_method `api_key`) fall into the api_key branch and open a blank sheet.
		switch (connectRoute(integration)) {
			case "git": {
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
					// object to the catch so the report keeps its status and code.
					if (error) throw error;
				} catch (err) {
					// The report gets the whole failure; the person gets a sentence chosen from it
					// (`gitLinkFailureMessage`), the same one the repository selector shows.
					captureException(err, { area: "connectors", provider: slug });
					toast.error(gitLinkFailureMessage(integration.name, err));
				} finally {
					setConnectingSlug(null);
				}
				return;
			}
			case "cloud":
				// aws/gcp/azure AND the token clouds → the shared sheet.
				await cloudConnect.openConnect(integration);
				return;
			case "api_key":
				// Its sheet is the whole flow, and `markConnecting` opened it.
				return;
		}
	};

	/**
	 * Initiates the connect flow (or adds another cloud account). A no-op for a viewer who may not
	 * manage connections and for a cloud that takes no new connection: both controls are drawn
	 * disabled or not at all, and this is the same rule for anything that reaches it another way.
	 */
	const handleConnect = async (integration: ConnectorWithConnection) => {
		if (!canManage || !acceptsNewConnections(integration, offeredClouds)) return;
		setDetailOpen(false);
		markConnecting(integration);
		await runConnect(integration);
	};

	// Deep-link: `?connect=<slug>` (e.g. from elench's connect action) auto-opens the connect sheet
	// once, then clears the param so a refresh doesn't reopen it. Waits for the board, which says
	// what the connector is, whether it can be connected here and whether the viewer may.
	//
	// The link is resolved WHILE RENDERING, once (React's "adjust state while rendering" form:
	// `connectLink` leaves `undefined` the first time it is set), and its UI state is marked there;
	// the effect then clears the param and runs the flow's side effects — or says why it runs none.
	const connectParam = searchParams.get(CONNECT_PARAM);
	const [connectLink, setConnectLink] = useState<ConnectLink | undefined>(undefined);
	if (connectLink === undefined && board.data && connectParam) {
		const resolved = resolveConnectLink(
			integrations.find((i) => i.slug === connectParam),
			offeredClouds,
			platformConfigured[connectParam] ?? true,
			canManage,
		);
		setConnectLink(resolved);
		if (resolved.kind === "open") markConnecting(resolved.integration);
	}
	const connectHandledRef = useRef(false);
	useEffect(() => {
		if (connectHandledRef.current || connectLink === undefined) return;
		connectHandledRef.current = true;
		// Only the link's own param is removed: the filters and the layout it arrived with stay.
		router.replace(
			hrefWithParamPatch(pathname, searchParams.toString(), { [CONNECT_PARAM]: null }),
			{ scroll: false },
		);
		if (connectLink.kind === "open") void runConnect(connectLink.integration);
		else toast.info(connectLink.message);
		// runConnect, pathname and searchParams are intentionally excluded — the ref makes this run once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [connectLink, router]);

	const openManage = (integration: ConnectorWithConnection) => {
		setSelectedSlug(integration.slug);
		setDetailOpen(true);
	};

	/** Re-runs a failed cloud verification with the stored configuration (no re-entry). */
	const handleReverify = (integration: ConnectorWithConnection) => {
		const identityId = integration.reverify_identity_id;
		if (!identityId || !canManage || reverify.isPending) return;
		setConnectingSlug(integration.slug);
		reverify.mutate({ identityId }, { onSettled: () => setConnectingSlug(null) });
	};

	/** Re-verifies one specific cloud account from the manage sheet (a provider can hold several, and
	 *  only some of them may be broken). Settles either way; a failure was already reported. */
	const handleReverifyAccount = async (identityId: string) => {
		await reverify.mutateAsync({ identityId }).catch(() => undefined);
	};

	// ── The four renders a read can have: pending, refused, failed, data ─────────────────────
	// A failed read is never shown as an empty board, nor as a skeleton that never ends.
	if (board.isPending) return <ConnectorsSkeleton />;
	// Which refusal, if the read was refused: a session that ended is not a role that does not
	// include connectors, and the two used to share one "Sign in again" sentence that was wrong
	// for the second.
	const refusal = board.isError ? boardRefusalOf(board.error) : null;
	if (board.isError && board.data === undefined) {
		return refusal ? (
			<RegionRefusal refusal={refusal} subject="connectors" />
		) : (
			<RegionError
				title="Couldn't load connectors"
				description="The connector list did not load. Your connections are unchanged."
				onRetry={() => void board.refetch()}
			/>
		);
	}

	const filtered = Object.keys(view?.query ?? {}).length > 0;

	return (
		<>
			<div className="space-y-6">
				{/* No title — the sidebar entry you clicked and the breadcrumb both say
				    "Connectors". What is left is the line that says what a connector IS, which the
				    breadcrumb does not carry. No count: the catalog is a bounded list
				    (list-standard/connectors.json) and the standard draws no list-size pill. */}
				<PageToolbar
					description={`Credentials Alethia acts through — ${CLOUD_ACCOUNT.many}, git providers, registries, chart repos, secret stores, observability sinks and DNS.`}
				/>

				{/* Said once for the page: every Connect below is drawn disabled for this viewer, and a
				    column of disabled buttons with the reason behind a hover is not how a person should
				    find out that the board is read-only for them. */}
				{!canManage && (
					<p
						role="note"
						data-slot="connectors-read-only"
						className="-mt-2 rounded-md border px-4 py-1.5 text-ui-sm text-text-secondary"
					>
						You can see connectors but not connect or change them. {MANAGE_DENIED_REASON}
					</p>
				)}

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
									aria-label="What are connectors?"
									className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground transition-colors hover:text-foreground"
								>
									<BookOpen className="size-4" aria-hidden />
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
				    retry, so it says which of the two it was and offers no "Try again" that cannot work. */}
				{board.isError && board.data !== undefined && (
					<div
						data-slot="connectors-stale"
						role="status"
						className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-1.5 text-ui-sm text-text-secondary"
					>
						<span className="flex items-center gap-2">
							<CircleAlert className="size-3.5 shrink-0" aria-hidden />
							{refusal === "sign-in"
								? "Your session has ended — showing earlier data"
								: refusal
									? "Your access to connectors changed — showing earlier data"
									: "Couldn't refresh — showing earlier data"}
						</span>
						{!refusal && (
							<Button variant="ghost" size="xs" onClick={() => void board.refetch()}>
								Try again
							</Button>
						)}
					</div>
				)}

				{/* Dim while a new filter's answer is resolving — keepPreviousData keeps the previous
				    rows on screen instead of flashing a skeleton. */}
				<div
					className={cn("space-y-6", board.isPlaceholderData && "opacity-60")}
					aria-busy={board.isPlaceholderData || undefined}
				>
					{GROUP_META.map((group) => {
						const items = rows.filter((i) => i.group === group.id);
						if (items.length === 0) return null;
						const connected = items.filter((i) => i.connected).length;
						const Icon = group.icon;
						return (
							<section key={group.id} className="space-y-3.5">
								<div className="flex items-center gap-3">
									<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground">
										<Icon className="size-3.5" aria-hidden />
									</span>
									<SectionHeading level={2} title={group.label} />
									<a
										href={group.docsHref}
										target="_blank"
										rel="noopener noreferrer"
										title={`Learn about ${group.label.toLowerCase()} connectors`}
										// The name is an attribute, not an `sr-only` span: that span is
										// absolutely positioned, the shell's <main> is not a positioned
										// ancestor, so a span this far down the board escaped main's
										// clip and made the document itself scroll (audit R3).
										aria-label={`Learn about ${group.label.toLowerCase()} connectors`}
										className="text-text-tertiary transition-colors hover:text-foreground"
									>
										<BookOpen className="size-3.5" aria-hidden />
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
												offered={acceptsNewConnections(integration, offeredClouds)}
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
														offered={acceptsNewConnections(integration, offeredClouds)}
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

					{/* Two different "nothing here"s. A filter that matches nothing offers the way back
					    to the whole board. A catalog with nothing in it is not something a filter did,
					    so it says what a connector is and offers a re-read instead of a Reset that
					    would change nothing. */}
					{rows.length === 0 && (filtered || total > 0) && (
						<EmptyState
							className="border"
							icon={<SearchX />}
							title="No connectors match"
							description="None of the connectors in the catalog match these filters."
							action={
								<Button variant="outline" onClick={resetFilters}>
									Reset filters
								</Button>
							}
						/>
					)}
					{rows.length === 0 && !filtered && total === 0 && (
						<EmptyState
							className="border"
							icon={<Plug />}
							title="No connectors are available"
							description="A connector is a credential Alethia acts through: a cloud account, a git provider, a registry. This instance's catalog has none, so there is nothing to connect yet."
							action={
								<Button variant="outline" onClick={() => void board.refetch()}>
									Reload
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
				offered={
					selectedIntegration ? acceptsNewConnections(selectedIntegration, offeredClouds) : true
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
			/>

			{cloudConnect.sheets}

			{/* api_key connection sheet. It closes on Done (or on the person's own dismissal), never
			    by itself when the save returns: the form ends on what happened. */}
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
							const name = provider?.name ?? bySlug(apiKeySlug)?.name ?? "connector";
							return (
								<>
									<ConnectSheetHeader
										integration={bySlug(apiKeySlug)}
										title={`Connect ${name}`}
										description="Provide an API credential. It is encrypted at rest and shared with your organization."
									/>
									<div className="px-6 py-6">
										{provider ? (
											<ApiKeyConnection
												key={provider.slug}
												provider={provider}
												onDone={() => setApiKeySlug(null)}
											/>
										) : (
											// A connector with no credential form in the registry: said in words,
											// where the sheet used to open empty.
											<EmptyState
												className="border"
												icon={<Plug />}
												title={`${name} can't be connected from here`}
												description="This connector has no connect form in this release. Nothing was changed."
											/>
										)}
									</div>
								</>
							);
						})()}
				</SheetContent>
			</Sheet>

			{/* Disconnect confirmation: one dialog for a git link, an api_key credential and a cloud
			    account. For a cloud account it names the projects that use it first. */}
			<ConnectorsDisconnectDialog
				target={disconnectTarget}
				onClose={() => setDisconnectTarget(null)}
				mutation={disconnect}
			/>
		</>
	);
}
