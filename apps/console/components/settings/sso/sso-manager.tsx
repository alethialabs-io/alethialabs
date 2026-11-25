"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Single Sign-On. A REAL multi-provider list (the old page rendered providers[0] only,
// silently hiding every other IdP), with server-side search + type/status facets, a working domain
// -verification card, a real connection test, and edit/delete. The fake "Require SSO" toggle and the
// fake SCIM card (which advertised a /scim/v2 URL that never existed) are gone — SCIM is an honest
// "talk to us" note instead.

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Pencil, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
	deleteSsoProvider,
	requestSsoDomainVerification,
	type SsoBootstrap,
	type SsoProviderRow,
	type SsoTestResult,
	testSsoProvider,
	verifySsoDomain,
} from "@/app/server/actions/sso";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { manageReason } from "@/components/errors/manage-gate";
import { RegionError } from "@/components/errors/region-error";
import { hrefWithParamPatch, selectionFromUrl, selectionPatch } from "@/lib/query/view-url-params";
import { PanelSkeleton } from "@/components/skeletons/page-skeletons";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { legalUrl } from "@/lib/legal";
import { ssoReadKeys, useSsoProvidersQuery } from "@/lib/query/use-sso-query";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useSsoFilters } from "@/lib/stores/use-settings-filters";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Spinner } from "@repo/ui/spinner";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import {
	DEFAULT_SSO_FILTERS,
	normalizeSsoQuery,
	SSO_STATUS_OPTIONS,
	SSO_TYPE_OPTIONS,
	ssoFacetCounts,
} from "./sso-filters";
import { ProviderSheet } from "./provider-sheet";
import { SsoNoAccess } from "./sso-no-access";

/**
 * The SSO page body (#6129). `bootstrap` is the route's server answer; the same read stays live
 * here (`sso.bootstrap`, hydrated by the route), so a permission change while the page is open
 * re-decides what the admin may press. Every read and write goes through the read router and the
 * mutation contract; a provider another admin registers, edits, verifies or removes arrives as an
 * `access` hint (lib/query/topics.ts) — no poll.
 */
export function SsoManager({ bootstrap: initial }: { bootstrap: SsoBootstrap }) {
	const bootQuery = useQuery(
		orpc.sso.bootstrap.queryOptions({ input: undefined, retry: retryUnlessRefused }),
	);
	const bootstrap = bootQuery.data ?? initial;
	const { canManage, slug, origin, orgId } = bootstrap;

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key.
	const filters = useSsoFilters((s) => s.filters);
	const set = useSsoFilters((s) => s.set);
	const reset = useSsoFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useSsoFilters, DEFAULT_SSO_FILTERS);
	// `urlRead`: a search the link carried lands at once; only typing is debounced (#5861).
	const search = useDebouncedValue(filters.search, 250, { urlRead });
	const query = useMemo(
		() => normalizeSsoQuery(filters, search),
		[filters, search],
	);

	// The selected provider is URL state (R6 E-23), written in place so it is not a server navigation.
	const searchParams = useSearchParams();
	const selectedId = selectionFromUrl(searchParams);
	const setSelectedId = (id: string | null) =>
		window.history.replaceState(
			null,
			"",
			hrefWithParamPatch(window.location.pathname, window.location.search, selectionPatch(id)),
		);
	// One answer to "you can't do this", on every write control (R6 E-09): disabled WITH the reason.
	const writeReason = manageReason({ canManage });
	const [sheetOpen, setSheetOpen] = useState(false);
	const [editing, setEditing] = useState<SsoProviderRow | null>(null);
	const [deleting, setDeleting] = useState<SsoProviderRow | null>(null);
	// The name the confirmation is RENDERING, which outlives `deleting` by one close.
	const [deletingName, setDeletingName] = useState("");

	// Filtered SERVER-SIDE by `sso.providers`. `isPlaceholderData` is the other half of the hook's
	// `keepPreviousData` (lib/query/README.md, step 5): the rows stay while the next query loads,
	// and the dim below says they are the PREVIOUS filter's answer.
	const providersQuery = useSsoProvidersQuery(query);
	const providers = providersQuery.data;
	// The UNFILTERED universe, purely for the facet counts — the pristine key, which the route
	// prefetches. An option whose count came from the current result would disappear the moment
	// you selected it, which is exactly what the standard forbids.
	const { data: universe = [] } = useSsoProvidersQuery();
	const counts = useMemo(() => ssoFacetCounts(universe), [universe]);
	const activeFilters = countActiveFilters(filters, DEFAULT_SSO_FILTERS);
	// The list is BUSY while what it shows may not answer the URL and the bar (#4980, #5494).
	const busy =
		!urlRead ||
		providersQuery.isPending ||
		providersQuery.isPlaceholderData ||
		filters.search !== search;

	const rows = providers ?? [];
	const selected = rows.find((p) => p.id === selectedId) ?? rows[0] ?? null;

	const removal = useActionMutation(deleteSsoProvider, {
		invalidates: ssoReadKeys(),
		successMessage: "Provider removed",
		onSuccess: () => {
			setSelectedId(null);
		},
	});

	/** Opens the provider sheet empty, to connect a new identity provider. */
	function connect() {
		setEditing(null);
		setSheetOpen(true);
	}

	// Refused while the page is open (a viewer whose `member:view` went away): the no-access render,
	// never an empty list or a failure.
	const refused = readRefusalOf(bootQuery.error) === "forbidden" || readRefusalOf(providersQuery.error) === "forbidden";
	if (refused) return <SsoNoAccess />;

	return (
		<div className="space-y-4" aria-busy={busy}>
			<PageToolbar
				description="Identity providers your members can sign in through."
				actions={
					<DisabledReason reason={writeReason}>
						<Button size="sm" onClick={connect}>
							<Plus size={13} />
							Connect provider
						</Button>
					</DisabledReason>
				}
			/>

			<FilterBar
				end={providersQuery.isFetching ? <Spinner className="size-3.5 text-text-tertiary" /> : undefined}
			>
				<FilterSearch
					value={filters.search}
					onChange={(v) => set("search", v)}
					placeholder="Search providers…"
					className="w-[240px] max-w-[380px] flex-1"
				/>
				<FacetFilter
					label="Protocol"
					icon={KeyRound}
					options={SSO_TYPE_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						hint: String(counts.types[o.value] ?? 0),
					}))}
					value={filters.types}
					onChange={(next) => set("types", next)}
					searchPlaceholder="Filter protocol…"
					emptyText="No protocols."
				/>
				<FacetFilter
					label="Status"
					icon={ShieldCheck}
					options={SSO_STATUS_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						hint: String(counts.statuses[o.value] ?? 0),
					}))}
					value={filters.statuses}
					onChange={(next) => set("statuses", next)}
					searchPlaceholder="Filter status…"
					emptyText="No statuses."
				/>
				<FilterBarReset count={activeFilters} onReset={reset} />
			</FilterBar>

			{providersQuery.isError && providers === undefined ? (
				// A failed read is not an empty list (B4).
				<RegionError
					title="Couldn't load identity providers"
					description="Something went wrong reading this organization's SSO providers."
					onRetry={() => void providersQuery.refetch()}
				/>
			) : providers === undefined ? (
				// Pending, never empty: the empty state below is only ever an ANSWER (B3).
				<PanelSkeleton lines={5} />
			) : providers.length === 0 ? (
				<EmptyState
					className="border border-border bg-surface"
					icon={<KeyRound />}
					title={
						activeFilters > 0
							? "No matching providers"
							: "No identity provider connected"
					}
					description={
						activeFilters > 0
							? "No identity provider matches these filters."
							: "Connect your IdP (Okta, Entra ID, OneLogin…) so your team signs in with SSO."
					}
					action={
						activeFilters > 0 ? (
							<Button variant="outline" size="sm" onClick={reset}>
								Clear filters
							</Button>
						) : (
							<DisabledReason reason={writeReason}>
								<Button size="sm" onClick={connect}>
									<Plus size={13} />
									Connect provider
								</Button>
							</DisabledReason>
						)
					}
				/>
			) : (
				<div
					className={cn(
						"grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]",
						providersQuery.isPlaceholderData && "opacity-60 transition-opacity",
					)}
				>
					<div className="rounded-lg border border-border bg-surface p-2 shadow-sm">
						{providers.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => setSelectedId(p.id)}
								// The rail picks the pane's subject: WAI-ARIA's current item (R6 E-24).
								aria-current={selected?.id === p.id ? "true" : undefined}
								className={cn(
									"flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
									selected?.id === p.id
										? "bg-surface-muted"
										: "hover:bg-surface-muted/60",
								)}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-ui-md text-text-primary">
										{p.providerId}
									</span>
									<span className="block truncate font-mono text-ui-2xs text-text-tertiary">
										{p.type === "unknown" ? "misconfigured" : p.type} · {p.domain}
									</span>
								</span>
								{/* Domain verification is the thing that gates sign-in, so it reads
								    through the SHARED status device rather than a local pill. */}
								<StatusBadge
									className="shrink-0"
									status={p.domainVerified ? "verified" : "pending"}
									tier={p.domainVerified ? "active" : "pending"}
									label={p.domainVerified ? "Verified" : "Pending"}
								/>
							</button>
						))}
					</div>

					{selected && (
						<ProviderDetail
							key={selected.id}
							provider={selected}
							origin={origin}
							slug={slug}
							writeReason={writeReason}
							removing={removal.isPending && removal.variables?.id === selected.id}
							onEdit={() => {
								setEditing(selected);
								setSheetOpen(true);
							}}
							onDelete={() => {
								setDeletingName(selected.providerId);
								setDeleting(selected);
							}}
						/>
					)}
				</div>
			)}

			{/* SCIM — honest. The old page advertised a /scim/v2/<tenant> URL that did not exist. */}
			<div className="rounded-lg border border-border bg-surface px-5 py-4 shadow-sm">
				<p className="text-ui-md font-medium text-text-primary">SCIM provisioning</p>
				<p className="mt-1 text-ui-sm text-text-secondary">
					Automatic user provisioning/deprovisioning from your IdP isn&apos;t available
					yet — SSO users are provisioned just-in-time on first sign-in. If SCIM is a
					requirement,{" "}
					<a
						href={legalUrl("/contact/sales")}
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2 hover:text-text-primary"
					>
						talk to us
					</a>
					.
				</p>
			</div>

			<ProviderSheet
				open={sheetOpen}
				onOpenChange={setSheetOpen}
				provider={editing}
				canManage={canManage}
				orgId={orgId}
			/>

			{/* The console's one confirmation (R6 E-21): it names the provider, stays open while the
			    removal runs and closes once it has succeeded. */}
			<ConfirmAction
				open={deleting !== null}
				onOpenChange={(o) => {
					if (!o) setDeleting(null);
				}}
				title={`Remove identity provider \u201C${deletingName}\u201D?`}
				description="Members who sign in through it will no longer be able to. Their accounts and memberships are kept. This cannot be undone."
				confirmLabel="Remove provider"
				pendingLabel="Removing…"
				severity={{ level: "confirm" }}
				mutation={removal}
				variables={deleting ? { id: deleting.id } : null}
			/>
		</div>
	);
}

/** A copyable key/value row. */
function KvRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
			<span className="shrink-0 text-ui-sm text-text-tertiary">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="truncate font-mono text-ui-xs text-text-secondary">{value}</span>
				<CopyButton text={value} />
			</span>
		</div>
	);
}

/**
 * One provider's detail: the connection test, domain verification and the SP details. Each action
 * is a `useActionMutation` — pending while in flight, and every control disabled while any of them
 * runs (the double-submit guard). Verifying changes the provider, so it invalidates the SSO reads;
 * the test and the record read change nothing the page shows.
 *
 * SHOWING THE DNS RECORD DOES NOT REPLACE IT (R6 E-19). `requestSsoDomainVerification` calls
 * `@better-auth/sso`'s `/sso/request-domain-verification`, which answers with the provider's ACTIVE
 * token when one exists and mints a new one only when there is none or it has expired (seven days
 * after it was issued). So asking again — after a reload, from another admin's browser — returns the
 * record already published, and the button says "Show DNS record" every time rather than offering a
 * "Re-issue" that would read as invalidating it.
 */
function ProviderDetail({
	provider: p,
	origin,
	slug,
	writeReason,
	removing,
	onEdit,
	onDelete,
}: {
	provider: SsoProviderRow;
	origin: string;
	slug: string;
	/** Why the viewer may not change this provider, or null when they may. */
	writeReason: string | null;
	/** A removal of this provider is in flight. */
	removing: boolean;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const [test, setTest] = useState<SsoTestResult | null>(null);
	const [dns, setDns] = useState<{ record: string; token: string } | null>(null);

	const testing = useActionMutation(testSsoProvider, {
		invalidates: [],
		onSuccess: (result) => setTest(result),
	});
	const minting = useActionMutation(requestSsoDomainVerification, {
		invalidates: [],
		onSuccess: (token) => setDns(token),
	});
	// The commonest answer here is a refusal — the TXT record is not visible yet — and it is the one
	// sentence the admin needs; the mutation contract shows it verbatim (#5445).
	const verifying = useActionMutation(verifySsoDomain, {
		invalidates: ssoReadKeys(),
		successMessage: "Domain verified — SSO sign-in is now enabled",
	});
	const busy = testing.isPending || minting.isPending || verifying.isPending || removing;

	return (
		<div className="space-y-4">
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="flex items-start justify-between gap-3 px-5 py-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="text-ui-lg font-semibold text-text-primary">
								{p.providerId}
							</span>
							{/* Third local status pill in this file, folded into the shared device. */}
							<StatusBadge
								status={p.domainVerified ? "connected" : "pending"}
								tier={p.domainVerified ? "active" : "pending"}
								label={p.domainVerified ? "Connected" : "Pending domain"}
							/>
						</div>
						<p className="mt-1 font-mono text-ui-xs text-text-tertiary">
							{p.type === "saml"
								? "SAML 2.0"
								: p.type === "oidc"
									? "OIDC"
									: "misconfigured"}{" "}
							· {p.domain}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<DisabledReason reason={writeReason}>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => testing.mutate({ id: p.id })}
							>
								{testing.isPending ? "Testing…" : "Test connection"}
							</Button>
						</DisabledReason>
						<DisabledReason reason={writeReason}>
							<Button
								variant="outline"
								size="sm"
								aria-label="Edit provider"
								disabled={busy}
								onClick={onEdit}
							>
								<Pencil size={13} />
							</Button>
						</DisabledReason>
						<DisabledReason reason={writeReason}>
							<Button
								variant="outline"
								size="sm"
								aria-label="Remove provider"
								disabled={busy}
								onClick={onDelete}
							>
								<Trash2 size={13} />
							</Button>
						</DisabledReason>
					</div>
				</div>
				{test && (
					<div className="border-t border-border px-5 py-3">
						{test.checks.map((c) => (
							<div key={c.id} className="flex items-start gap-2 py-1">
								{c.ok ? (
									<CheckCircle2 size={13} className="mt-0.5 shrink-0 text-text-secondary" />
								) : (
									<XCircle size={13} className="mt-0.5 shrink-0 text-destructive" />
								)}
								<span className="text-ui-sm text-text-secondary">
									{c.label}
									<span className="ml-1.5 font-mono text-ui-xs text-text-tertiary">
										{c.detail}
									</span>
								</span>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Domain verification — the thing that actually gates sign-in. */}
			{!p.domainVerified && (
				<div className="rounded-lg border border-border bg-surface shadow-sm">
					<div className="px-5 py-4">
						<p className="text-ui-md font-medium text-text-primary">
							Verify {p.domain}
						</p>
						<p className="mt-1 text-ui-sm text-text-secondary">
							Sign-in through this provider stays disabled until you prove you control
							the domain. Publish this DNS TXT record, then verify. Showing it again
							returns the same record while it is valid.
						</p>
					</div>
					{dns && (
						<div className="border-t border-border">
							<KvRow label="Record" value={dns.record} />
							<KvRow label="Value" value={dns.token} />
						</div>
					)}
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-5 py-3">
						<DisabledReason reason={writeReason}>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => minting.mutate({ id: p.id })}
							>
								{minting.isPending ? "Loading…" : "Show DNS record"}
							</Button>
						</DisabledReason>
						<DisabledReason reason={writeReason}>
							<Button
								size="sm"
								disabled={busy}
								onClick={() => verifying.mutate({ id: p.id })}
							>
								{verifying.isPending ? "Verifying…" : "Verify domain"}
							</Button>
						</DisabledReason>
					</div>
				</div>
			)}

			{/* What the IdP admin needs from us. */}
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="px-4 py-2.5 font-mono text-ui-3xs uppercase tracking-[0.12em] text-text-tertiary">
					Service provider details
				</div>
				<div className="border-t border-border">
					{p.type === "saml" ? (
						<>
							<KvRow label="ACS URL" value={`${origin}/api/auth/sso/saml2/sp/acs`} />
							<KvRow
								label="SP metadata"
								value={`${origin}/api/auth/sso/saml2/sp/metadata`}
							/>
						</>
					) : (
						<KvRow
							label="Redirect URI"
							value={`${origin}/api/auth/sso/callback/${p.providerId}`}
						/>
					)}
					<KvRow label="Start URL" value={`${origin}/sso/${slug}`} />
				</div>
			</div>
		</div>
	);
}
