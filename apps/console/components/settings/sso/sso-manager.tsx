"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Single Sign-On — the authored multi-card IdP design, composed from the
// shared settings primitives. Real: provider list + IdP details (issuer, SSO URL,
// signing-cert fingerprint) from getSsoProviders, register via RegisterProviderDialog,
// and Service-Provider URLs derived from the org slug. SCIM provisioning + enforcement
// have no backend yet → rendered as honest "coming soon" cards (tracked in the gap log).

import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getOrgSettings } from "@/app/server/actions/org-settings";
import { getSsoProviders, type SsoProviderRow } from "@/app/server/actions/sso";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { RegisterProviderDialog } from "@/components/settings/sso/register-provider-dialog";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { userInitials } from "@/lib/user-display";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

/** Copy-to-clipboard button with a brief confirmation. */
function CopyButton({ value }: { value: string }) {
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setDone(true);
					setTimeout(() => setDone(false), 1500);
				} catch {
					toast.error("Couldn't copy.");
				}
			}}
			className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-2 py-1 font-mono text-[10.5px] text-text-tertiary transition-colors hover:border-border-strong hover:text-text-primary"
		>
			{done ? <Check size={12} /> : <Copy size={12} />}
			{done ? "Copied" : "Copy"}
		</button>
	);
}

/** A titled key/value card (the design's `kv-card`). */
function KvCard({
	title,
	hint,
	action,
	children,
}: {
	title: ReactNode;
	hint?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="mb-4 rounded-lg border border-border bg-surface shadow-sm">
			<div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
				<div>
					<div className="text-[13px] font-medium text-text-primary">{title}</div>
					{hint && <div className="mt-0.5 text-[11.5px] text-text-tertiary">{hint}</div>}
				</div>
				{action}
			</div>
			<div className="px-5 py-1.5">{children}</div>
		</div>
	);
}

/** A key/value row with an optional trailing slot (copy button / status). */
function KvRow({
	label,
	sub,
	value,
	trailing,
}: {
	label: string;
	sub?: string;
	value: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
			<div className="w-44 shrink-0">
				<div className="text-[12.5px] text-text-secondary">{label}</div>
				{sub && <div className="text-[10.5px] text-text-tertiary">{sub}</div>}
			</div>
			<div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-primary">
				{value}
			</div>
			{trailing && <div className="shrink-0">{trailing}</div>}
		</div>
	);
}

/** A grayscale status pill (the global `.vx-status` device). */
function StatusPill({ ok, label }: { ok: boolean; label: string }) {
	return (
		<span className={cn("vx-status", ok ? "vx-status--active" : "vx-status--idle")}>
			<span className="vx-status__dot" />
			{label}
		</span>
	);
}

export function SsoManager() {
	// SSO is Enterprise. Without it the surface stays visible and shows the upsell instead
	// of registering a provider; the register endpoint is enforced server-side regardless.
	const entitled = useEntitlement("sso");
	const [providers, setProviders] = useState<SsoProviderRow[] | null>(null);
	const [slug, setSlug] = useState("");
	// SSR-consistent origin (no window → no hydration mismatch); falls back to the prod host.
	const origin =
		process.env.NEXT_PUBLIC_APP_URL ?? "https://alethialabs.io";

	const load = useCallback(() => {
		getSsoProviders()
			.then(setProviders)
			.catch(() => setProviders([]));
		getOrgSettings()
			.then((s) => s && setSlug(s.slug))
			.catch(() => {});
	}, []);
	useEffect(() => {
		if (entitled) load();
	}, [entitled, load]);

	const tenant = slug || "org";

	return (
		<div>
			{!entitled ? (
				<FeatureUpsell feature="sso" />
			) : providers === null ? (
				<div className="space-y-4">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-48 w-full" />
				</div>
			) : providers.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-12 text-center">
					<KeyRound className="mx-auto mb-3 size-5 text-text-tertiary" />
					<p className="mb-1 text-[14px] font-medium text-text-primary">
						No identity provider connected
					</p>
					<p className="mx-auto mb-4 max-w-prose text-[12.5px] text-text-tertiary">
						Register an OIDC or SAML provider to let your team sign in through your IdP.
						Members with a matching email domain are routed to it.
					</p>
					<div className="flex justify-center">
						<RegisterProviderDialog onRegistered={load} />
					</div>
				</div>
			) : (
				<SsoDetail
					providers={providers}
					origin={origin}
					tenant={tenant}
					onChanged={load}
				/>
			)}
		</div>
	);
}

function SsoDetail({
	providers,
	origin,
	tenant,
	onChanged,
}: {
	providers: SsoProviderRow[];
	origin: string;
	tenant: string;
	onChanged: () => void;
}) {
	const p = providers[0];
	const isSaml = p.type === "saml";
	const acs = `${origin}/api/auth/sso/saml2/callback/${p.providerId}`;
	const entityId = `urn:alethia:sp:${tenant}`;
	const startUrl = `${origin}/sso/${tenant}`;
	const scimUrl = `${origin}/scim/v2/${tenant}`;

	return (
		<div>
			{/* status card */}
			<div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
				<div className="flex items-center gap-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-[14px] font-semibold uppercase text-ink-foreground">
						{userInitials({ name: p.providerId })}
					</span>
					<div className="flex flex-col gap-1">
						<span className="flex items-center gap-2 text-[14px] font-medium capitalize text-text-primary">
							{p.providerId}
							<StatusPill
								ok={p.domainVerified}
								label={p.domainVerified ? "Connected" : "Pending domain"}
							/>
						</span>
						<span className="font-mono text-[11px] text-text-tertiary">
							{isSaml ? "SAML 2.0" : "OIDC"} · {p.domain}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => toast.info("Connection testing is coming soon.")}
					>
						Test connection
					</Button>
					<RegisterProviderDialog onRegistered={onChanged} />
				</div>
			</div>

			{/* service provider details */}
			<KvCard
				title="Service provider details"
				hint="Paste these into your IdP application configuration."
			>
				{isSaml ? (
					<>
						<KvRow
							label="ACS URL"
							sub="Assertion Consumer Service"
							value={acs}
							trailing={<CopyButton value={acs} />}
						/>
						<KvRow
							label="SP Entity ID"
							sub="Audience URI"
							value={entityId}
							trailing={<CopyButton value={entityId} />}
						/>
						<KvRow
							label="Start URL"
							sub="IdP-initiated sign-in"
							value={startUrl}
							trailing={<CopyButton value={startUrl} />}
						/>
					</>
				) : (
					<KvRow
						label="Redirect URI"
						sub="OIDC callback"
						value={acs}
						trailing={<CopyButton value={acs} />}
					/>
				)}
			</KvCard>

			{/* identity provider */}
			<KvCard
				title="Identity provider"
				hint="Read from your IdP configuration. Re-upload to rotate the signing certificate."
				action={
					<Button
						variant="ghost"
						size="sm"
						onClick={() => toast.info("Metadata re-upload is coming soon.")}
					>
						Re-upload metadata
					</Button>
				}
			>
				{p.ssoUrl && (
					<KvRow
						label="IdP SSO URL"
						value={p.ssoUrl}
						trailing={<StatusPill ok={p.domainVerified} label="Verified" />}
					/>
				)}
				<KvRow label={isSaml ? "IdP Issuer" : "Issuer"} value={p.issuer} />
				{p.clientId && <KvRow label="Client ID" value={p.clientId} />}
				{p.certFingerprint && (
					<KvRow
						label="Signing certificate"
						sub="SHA-256 fingerprint"
						value={p.certFingerprint}
					/>
				)}
			</KvCard>

			{/* attribute mapping (informational defaults) */}
			<KvCard
				title="Attribute mapping"
				hint="IdP assertion claims → Alethia profile fields (defaults)."
			>
				{[
					["email", "email"],
					["name / displayName", "name"],
					["groups", "team"],
				].map(([src, dst]) => (
					<div
						key={src}
						className="flex items-center gap-3 border-b border-border py-3 font-mono text-[11.5px] last:border-b-0"
					>
						<span className="flex-1 text-text-secondary">{src}</span>
						<span className="text-text-disabled">→</span>
						<span className="flex-1 text-right text-text-primary">{dst}</span>
					</div>
				))}
			</KvCard>

			{/* SCIM — no backend yet */}
			<KvCard
				title={
					<span className="flex items-center gap-2">
						SCIM provisioning
						<StatusPill ok={false} label="Coming soon" />
					</span>
				}
				hint="Auto-create, update and deactivate members from your IdP."
			>
				<KvRow
					label="SCIM base URL"
					value={<span className="text-text-tertiary">{scimUrl}</span>}
				/>
				<KvRow
					label="Status"
					value={
						<span className="font-sans text-[12px] text-text-tertiary">
							Not yet available — provisioning members via SCIM is on the roadmap.
						</span>
					}
				/>
			</KvCard>

			{/* enforcement — no backend yet */}
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				<div className="border-b border-border px-5 py-4">
					<div className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
						<ShieldCheck size={14} className="text-text-tertiary" />
						Enforcement
						<StatusPill ok={false} label="Coming soon" />
					</div>
					<div className="mt-0.5 text-[11.5px] text-text-tertiary">
						Control how members authenticate once SSO is live.
					</div>
				</div>
				<div className="flex items-center justify-between gap-4 px-5 py-4">
					<div>
						<div className="text-[13px] text-text-primary">
							Require SSO for all members
						</div>
						<div className="mt-0.5 max-w-prose text-[11.5px] text-text-tertiary">
							Members must sign in through your IdP; password and magic-link sign-in are
							disabled for verified domains. Owners keep a break-glass fallback.
						</div>
					</div>
					<span
						aria-disabled
						className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-surface-muted px-0.5"
						title="Coming soon"
					>
						<span className="size-4 rounded-full bg-text-disabled" />
					</span>
				</div>
			</div>
		</div>
	);
}
