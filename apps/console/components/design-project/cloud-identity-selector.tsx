"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { asCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { ProviderIcon } from "@repo/ui/provider-icon";
import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";
import { useCloudProviderStore } from "@/lib/stores/use-cloud-provider-store";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Button } from "@repo/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";

interface CloudIdentitySelectorProps {
	identities: CloudIdentityOption[];
	value: string | null;
	onChange: (id: string, provider: CloudProviderSlug) => void;
	/**
	 * When true (default, the form's behavior) selecting an identity updates the
	 * global cloud-provider store (loads cached resources, drives provider-keyed
	 * defaults). Set false for node-scoped use on the canvas, where each node owns
	 * its provider and must not clobber the shared/global selection.
	 */
	manageGlobalStore?: boolean;
}

/** Renders a dropdown of all verified cloud identities across providers. */
export function CloudIdentitySelector({
	identities,
	value,
	onChange,
	manageGlobalStore = true,
}: CloudIdentitySelectorProps) {
	const { setIdentity, isLoading: loading } = useCloudProviderStore();
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	const selectIdentity = useCallback(
		async (id: string, provider: CloudProviderSlug) => {
			onChangeRef.current(id, provider);
			if (manageGlobalStore) await setIdentity(id, provider);
		},
		[setIdentity, manageGlobalStore],
	);

	useEffect(() => {
		if (identities.length === 1 && !value) {
			const first = identities[0];
			selectIdentity(first.id, asCloudProviderSlug(first.provider));
		}
	}, [identities, value, selectIdentity]);

	if (identities.length === 0) {
		return (
			<div className="flex items-center justify-between p-3 rounded-md border border-dashed border-destructive/30 bg-destructive/5">
				<div className="flex items-center gap-2 text-sm text-destructive">
					<AlertTriangle className="h-4 w-4" />
					No cloud account connected
				</div>
				<Link href="/dashboard/connectors">
					<Button variant="outline" size="sm" className="h-7 text-xs">
						Connect
					</Button>
				</Link>
			</div>
		);
	}

	return (
		<div className="space-y-1">
			<Select
				value={value ?? undefined}
				onValueChange={(id) => {
					const identity = identities.find((i) => i.id === id);
					if (identity) {
						selectIdentity(id, asCloudProviderSlug(identity.provider));
					}
				}}
			>
				<SelectTrigger className="h-9 text-sm">
					<SelectValue placeholder="Select cloud account" />
				</SelectTrigger>
				<SelectContent>
					{identities.map((identity) => {
						return (
							<SelectItem key={identity.id} value={identity.id}>
								<div className="flex items-center gap-2">
									<ProviderIcon provider={identity.provider} size={16} className="shrink-0" />
									<span>{identity.name}</span>
									<span className="text-xs text-muted-foreground font-mono">
										{identity.displayId}
									</span>
								</div>
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
			{loading && (
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Loader2 className="h-3 w-3 animate-spin" />
					Loading resources...
				</div>
			)}
		</div>
	);
}
