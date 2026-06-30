"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Switch } from "@repo/ui/switch";
import { PERMISSIONS, RESOURCES, type Resource } from "@/lib/authz/registry";

// "Per service" grouping — each resource type is its own section, so granting is
// granular (e.g. projects' plan/deploy/destroy independently of runners).
const RESOURCE_LABEL: Record<Resource, string> = {
	org: "Organization",
	project: "Projects",
	runner: "Runners",
	cloud_identity: "Cloud identities",
	job: "Jobs",
	connector: "Connectors",
	member: "Members",
	activity: "Activity",
	billing: "Billing",
	alert: "Alerts",
	fleet: "Fleet",
};

const GROUPS = RESOURCES.map((resource) => ({
	resource,
	label: RESOURCE_LABEL[resource],
	permissions: PERMISSIONS.filter((p) => p.resource === resource),
})).filter((g) => g.permissions.length > 0);

/**
 * Controlled permission picker (the chosen `resource:action` keys), grouped per
 * service. `readOnly` renders it as a disabled, view-only matrix (built-in roles).
 */
export function PermissionMatrix({
	value,
	onChange,
	readOnly,
}: {
	value: string[];
	onChange?: (keys: string[]) => void;
	readOnly?: boolean;
}) {
	const selected = new Set(value);
	const toggle = (key: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(key);
		else next.delete(key);
		onChange?.([...next]);
	};

	return (
		<div className="space-y-5">
			{GROUPS.map((g) => (
				<div key={g.resource}>
					<p className="vx-eyebrow mb-2">{g.label}</p>
					<div className="overflow-hidden rounded-lg border border-border">
						{g.permissions.map((p) => (
							<div
								key={p.key}
								className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
							>
								<div className="min-w-0">
									<p className="text-[13px] capitalize text-text-primary">
										{p.action.replace(/_/g, " ")}
									</p>
									<p className="truncate font-mono text-[10.5px] text-text-tertiary">
										{p.key}
									</p>
								</div>
								<Switch
									checked={selected.has(p.key)}
									disabled={readOnly}
									onCheckedChange={readOnly ? undefined : (on) => toggle(p.key, on)}
								/>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
