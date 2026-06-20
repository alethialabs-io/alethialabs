"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type AccessGrantRow,
	getGrantOptions,
	type GrantOptions,
	listAccessGrants,
	revokeGrant,
} from "@/app/server/actions/grants";
import { AccessTable } from "@/components/settings/access/access-table";
import { GrantAccessDialog } from "@/components/settings/access/grant-access-dialog";
import {
	EnterpriseGate,
	useEntitlement,
} from "@/components/settings/enterprise-gate";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function AccessPage() {
	const canManage = useEntitlement("customRoles");
	const [grants, setGrants] = useState<AccessGrantRow[] | null>(null);
	const [options, setOptions] = useState<GrantOptions | null>(null);

	const load = useCallback(() => {
		listAccessGrants().then(setGrants).catch(() => setGrants([]));
		getGrantOptions().then(setOptions).catch(() => setOptions(null));
	}, []);
	useEffect(() => {
		if (canManage) load();
	}, [canManage, load]);

	// Resolve a grant's scoped resource to a friendly name via the option lists.
	const resourceLabel = useMemo(() => {
		const map = new Map<string, string>();
		if (options) {
			for (const [type, list] of Object.entries(options.resources)) {
				for (const r of list) map.set(`${type}:${r.id}`, r.label);
			}
		}
		return (type: string, id: string | null) =>
			id ? (map.get(`${type}:${id}`) ?? `${id.slice(0, 8)}…`) : "—";
	}, [options]);

	const revoke = async (id: string) => {
		try {
			await revokeGrant(id);
			toast.success("Access revoked");
			load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to revoke access");
		}
	};

	return (
		<>
			<SettingsHeader
				title="Access"
				description="Grant roles or single permissions to members, scoped org-wide or to a resource. Deny overrides an inherited allow."
				action={canManage ? <GrantAccessDialog onGranted={load} /> : undefined}
			/>
			<EnterpriseGate
				entitlement="customRoles"
				title="Access management"
				description="Assign fine-grained access — a role or an individual permission, allow or deny, scoped to the org or a specific resource. Available on Enterprise."
			>
				{grants === null ? (
					<div className="space-y-3">
						{[0, 1, 2].map((i) => (
							<Skeleton key={i} className="h-12 w-full" />
						))}
					</div>
				) : grants.length === 0 ? (
					<p className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-4 py-10 text-center text-sm text-muted-foreground">
						No access grants yet. Use “Grant access” to assign a role or
						permission to a member.
					</p>
				) : (
					<AccessTable grants={grants} resourceLabel={resourceLabel} onRevoke={revoke} />
				)}
			</EnterpriseGate>
		</>
	);
}
