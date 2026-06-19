"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getSsoProviders, type SsoProviderRow } from "@/app/server/actions/sso";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RegisterProviderDialog } from "./register-provider-dialog";

function ProviderCard({ p }: { p: SsoProviderRow }) {
	return (
		<div className="flex items-center justify-between rounded-lg border border-border/50 bg-card px-4 py-3">
			<div className="flex items-center gap-3 min-w-0">
				<div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
					<KeyRound className="h-4 w-4" />
				</div>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-foreground">{p.providerId}</p>
					<p className="truncate text-xs text-muted-foreground">{p.domain}</p>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<Badge variant="secondary" className="uppercase">
					{p.type}
				</Badge>
				<Badge variant={p.domainVerified ? "default" : "outline"}>
					{p.domainVerified ? "Verified" : "Unverified"}
				</Badge>
			</div>
		</div>
	);
}

/** SSO provider list + register dialog (rendered inside the sso entitlement gate). */
export function SsoProviders() {
	const [providers, setProviders] = useState<SsoProviderRow[] | null>(null);

	const load = useCallback(() => {
		getSsoProviders()
			.then(setProviders)
			.catch(() => setProviders([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	if (providers === null) {
		return (
			<div className="space-y-3">
				{[0, 1].map((i) => (
					<Skeleton key={i} className="h-16 w-full" />
				))}
			</div>
		);
	}

	if (providers.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-6 py-16 text-center">
				<div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<KeyRound className="h-5 w-5" />
				</div>
				<h3 className="mt-4 text-sm font-semibold text-foreground">
					No identity providers yet
				</h3>
				<p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
					Register your IdP over OIDC or SAML so your team can sign in through it.
				</p>
				<div className="mt-5">
					<RegisterProviderDialog onRegistered={load} />
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					{providers.length} provider{providers.length === 1 ? "" : "s"}
				</p>
				<RegisterProviderDialog onRegistered={load} />
			</div>
			<div className="space-y-2">
				{providers.map((p) => (
					<ProviderCard key={p.id} p={p} />
				))}
			</div>
		</div>
	);
}
