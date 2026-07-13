"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Single Sign-On. A REAL multi-provider list (the old page rendered providers[0] only,
// silently hiding every other IdP), with server-side search + type/status facets, a working domain
// -verification card, a real connection test, and edit/delete. The fake "Require SSO" toggle and the
// fake SCIM card (which advertised a /scim/v2 URL that never existed) are gone — SCIM is an honest
// "talk to us" note instead.

import { CheckCircle2, KeyRound, Pencil, Plus, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	deleteSsoProvider,
	requestSsoDomainVerification,
	type SsoBootstrap,
	type SsoFilter,
	type SsoProviderRow,
	type SsoTestResult,
	testSsoProvider,
	verifySsoDomain,
} from "@/app/server/actions/sso";
import { SettingsSearch } from "@/components/settings/settings-ui";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { legalUrl } from "@/lib/legal";
import { useInvalidateSso, useSsoProvidersQuery } from "@/lib/query/use-sso-query";
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
import { CopyButton } from "@repo/ui/copy-button";
import { FacetFilter } from "@repo/ui/facet-filter";
import { Spinner } from "@repo/ui/spinner";
import { cn } from "@repo/ui/utils";
import { ProviderSheet } from "./provider-sheet";

function useDebounced<T>(value: T, delay = 250): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(t);
	}, [value, delay]);
	return debounced;
}

const TYPE_OPTIONS = [
	{ value: "oidc", label: "OIDC" },
	{ value: "saml", label: "SAML" },
	{ value: "unknown", label: "Misconfigured" },
];
const STATUS_OPTIONS = [
	{ value: "verified", label: "Verified" },
	{ value: "pending", label: "Pending" },
];

/** Narrows the facet's string[] to the action's unions (the server re-validates regardless). */
function toFilter(
	search: string,
	types: string[],
	statuses: string[],
): SsoFilter {
	const t = types.filter(
		(x): x is NonNullable<SsoFilter["types"]>[number] =>
			x === "oidc" || x === "saml" || x === "unknown",
	);
	const s = statuses.filter(
		(x): x is NonNullable<SsoFilter["statuses"]>[number] =>
			x === "verified" || x === "pending",
	);
	return {
		search: search || undefined,
		types: t.length ? t : undefined,
		statuses: s.length ? s : undefined,
	};
}

export function SsoManager({ bootstrap }: { bootstrap: SsoBootstrap }) {
	const { canManage, slug, origin } = bootstrap;
	const invalidate = useInvalidateSso();

	const [searchInput, setSearchInput] = useState("");
	const search = useDebounced(searchInput.trim());
	const [types, setTypes] = useState<string[]>([]);
	const [statuses, setStatuses] = useState<string[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [editing, setEditing] = useState<SsoProviderRow | null>(null);
	const [deleting, setDeleting] = useState<SsoProviderRow | null>(null);

	const { data: providers = [], isFetching } = useSsoProvidersQuery(
		toFilter(search, types, statuses),
	);

	// Enterprise gate — the whole surface is replaced by the upsell.
	if (!bootstrap.sso) return <FeatureUpsell feature="sso" />;

	const selected =
		providers.find((p) => p.id === selectedId) ?? providers[0] ?? null;

	function connect() {
		setEditing(null);
		setSheetOpen(true);
	}

	async function confirmDelete(p: SsoProviderRow) {
		try {
			await deleteSsoProvider(p.id);
			toast.success("Provider removed");
			setDeleting(null);
			setSelectedId(null);
			invalidate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't remove the provider");
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<SettingsSearch
						value={searchInput}
						onChange={setSearchInput}
						placeholder="Search providers"
						className="w-[220px]"
					/>
					<FacetFilter
						label="Protocol"
						options={TYPE_OPTIONS}
						value={types}
						onChange={setTypes}
					/>
					<FacetFilter
						label="Status"
						options={STATUS_OPTIONS}
						value={statuses}
						onChange={setStatuses}
					/>
					{isFetching && <Spinner className="size-3.5 text-text-tertiary" />}
				</div>
				<Button size="sm" disabled={!canManage} onClick={connect}>
					<Plus size={13} />
					Connect provider
				</Button>
			</div>

			{providers.length === 0 ? (
				<EmptyState canManage={canManage} onConnect={connect} />
			) : (
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
					<div className="rounded-lg border border-border bg-surface p-2 shadow-sm">
						{providers.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => setSelectedId(p.id)}
								className={cn(
									"flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
									selected?.id === p.id
										? "bg-surface-muted"
										: "hover:bg-surface-muted/60",
								)}
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] text-text-primary">
										{p.providerId}
									</span>
									<span className="block truncate font-mono text-[10.5px] text-text-tertiary">
										{p.type === "unknown" ? "misconfigured" : p.type} · {p.domain}
									</span>
								</span>
								{p.domainVerified ? (
									<CheckCircle2 size={14} className="shrink-0 text-text-secondary" />
								) : (
									<span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase text-text-tertiary">
										pending
									</span>
								)}
							</button>
						))}
					</div>

					{selected && (
						<ProviderDetail
							key={selected.id}
							provider={selected}
							origin={origin}
							slug={slug}
							canManage={canManage}
							onEdit={() => {
								setEditing(selected);
								setSheetOpen(true);
							}}
							onDelete={() => setDeleting(selected)}
							onChanged={invalidate}
						/>
					)}
				</div>
			)}

			{/* SCIM — honest. The old page advertised a /scim/v2/<tenant> URL that did not exist. */}
			<div className="rounded-lg border border-border bg-surface px-5 py-4 shadow-sm">
				<p className="text-[13px] font-medium text-text-primary">SCIM provisioning</p>
				<p className="mt-1 text-[12px] text-text-secondary">
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
				onSaved={invalidate}
			/>

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove this identity provider?</AlertDialogTitle>
						<AlertDialogDescription>
							Members who sign in through <strong>{deleting?.providerId}</strong> will
							no longer be able to. Their accounts and memberships are kept. This cannot
							be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void confirmDelete(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Remove provider
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function EmptyState({
	canManage,
	onConnect,
}: {
	canManage: boolean;
	onConnect: () => void;
}) {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-border bg-surface px-6 py-16 text-center shadow-sm">
			<KeyRound size={22} className="text-text-tertiary" />
			<p className="mt-3 text-[14px] font-medium text-text-primary">
				No identity provider connected
			</p>
			<p className="mt-1 max-w-sm text-[12.5px] text-text-secondary">
				Connect your IdP (Okta, Entra ID, OneLogin…) so your team signs in with SSO.
			</p>
			<Button size="sm" className="mt-4" disabled={!canManage} onClick={onConnect}>
				<Plus size={13} />
				Connect provider
			</Button>
		</div>
	);
}

/** A copyable key/value row. */
function KvRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
			<span className="shrink-0 text-[12px] text-text-tertiary">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="truncate font-mono text-[11px] text-text-secondary">{value}</span>
				<CopyButton text={value} />
			</span>
		</div>
	);
}

function ProviderDetail({
	provider: p,
	origin,
	slug,
	canManage,
	onEdit,
	onDelete,
	onChanged,
}: {
	provider: SsoProviderRow;
	origin: string;
	slug: string;
	canManage: boolean;
	onEdit: () => void;
	onDelete: () => void;
	onChanged: () => void;
}) {
	const [test, setTest] = useState<SsoTestResult | null>(null);
	const [busy, setBusy] = useState<"test" | "token" | "verify" | null>(null);
	const [dns, setDns] = useState<{ record: string; token: string } | null>(null);

	async function runTest() {
		setBusy("test");
		try {
			setTest(await testSsoProvider(p.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Test failed");
		} finally {
			setBusy(null);
		}
	}

	async function getToken() {
		setBusy("token");
		try {
			setDns(await requestSsoDomainVerification(p.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't mint a token");
		} finally {
			setBusy(null);
		}
	}

	async function verify() {
		setBusy("verify");
		try {
			await verifySsoDomain(p.id);
			toast.success("Domain verified — SSO sign-in is now enabled");
			onChanged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't verify the domain yet");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="space-y-4">
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="flex items-start justify-between gap-3 px-5 py-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="text-[15px] font-semibold text-text-primary">
								{p.providerId}
							</span>
							<span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-text-secondary">
								{p.domainVerified ? "Connected" : "Pending domain"}
							</span>
						</div>
						<p className="mt-1 font-mono text-[11.5px] text-text-tertiary">
							{p.type === "saml"
								? "SAML 2.0"
								: p.type === "oidc"
									? "OIDC"
									: "misconfigured"}{" "}
							· {p.domain}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage || busy !== null}
							onClick={() => void runTest()}
						>
							{busy === "test" ? "Testing…" : "Test connection"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							aria-label="Edit provider"
							disabled={!canManage}
							onClick={onEdit}
						>
							<Pencil size={13} />
						</Button>
						<Button
							variant="outline"
							size="sm"
							aria-label="Remove provider"
							disabled={!canManage}
							onClick={onDelete}
						>
							<Trash2 size={13} />
						</Button>
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
								<span className="text-[12px] text-text-secondary">
									{c.label}
									<span className="ml-1.5 font-mono text-[11px] text-text-tertiary">
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
						<p className="text-[13px] font-medium text-text-primary">
							Verify {p.domain}
						</p>
						<p className="mt-1 text-[12px] text-text-secondary">
							Sign-in through this provider stays disabled until you prove you control
							the domain. Add this DNS TXT record, then verify.
						</p>
					</div>
					{dns && (
						<div className="border-t border-border">
							<KvRow label="Record" value={dns.record} />
							<KvRow label="Value" value={dns.token} />
						</div>
					)}
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-5 py-3">
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage || busy !== null}
							onClick={() => void getToken()}
						>
							{busy === "token" ? "…" : dns ? "Re-issue record" : "Show DNS record"}
						</Button>
						<Button
							size="sm"
							disabled={!canManage || busy !== null}
							onClick={() => void verify()}
						>
							{busy === "verify" ? "Verifying…" : "Verify domain"}
						</Button>
					</div>
				</div>
			)}

			{/* What the IdP admin needs from us. */}
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="px-4 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
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
