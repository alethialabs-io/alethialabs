"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Switch } from "@/components/ui/switch";
import { PERMISSIONS, RESOURCES, type Resource } from "@/lib/authz/registry";

// "Per service" grouping — each resource type is its own section, so granting is
// granular (e.g. specs' plan/deploy/destroy independently of zones or runners).
const RESOURCE_LABEL: Record<Resource, string> = {
	org: "Organization",
	zone: "Zones",
	spec: "Specs",
	runner: "Runners",
	cloud_identity: "Cloud identities",
	job: "Jobs",
	connector: "Connectors",
	member: "Members",
	audit: "Audit",
	billing: "Billing",
};

const GROUPS = RESOURCES.map((resource) => ({
	resource,
	label: RESOURCE_LABEL[resource],
	permissions: PERMISSIONS.filter((p) => p.resource === resource),
})).filter((g) => g.permissions.length > 0);

/** Controlled permission picker: the chosen `resource:action` keys. */
export function PermissionMatrix({
	value,
	onChange,
}: {
	value: string[];
	onChange: (keys: string[]) => void;
}) {
	const selected = new Set(value);
	const toggle = (key: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(key);
		else next.delete(key);
		onChange([...next]);
	};

	return (
		<div className="space-y-5">
			{GROUPS.map((g) => (
				<div key={g.resource}>
					<p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{g.label}
					</p>
					<div className="space-y-2">
						{g.permissions.map((p) => (
							<div
								key={p.key}
								className="flex items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2"
							>
								<div className="min-w-0">
									<p className="text-sm capitalize text-foreground">
										{p.action.replace(/_/g, " ")}
									</p>
									<p className="truncate font-mono text-[11px] text-muted-foreground">
										{p.key}
									</p>
								</div>
								<Switch
									checked={selected.has(p.key)}
									onCheckedChange={(on) => toggle(p.key, on)}
								/>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
