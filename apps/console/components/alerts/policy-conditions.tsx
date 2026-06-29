"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The policy "conditions" (the enforced `match`): a severity threshold plus optional
// scope filters (projects / job types / resource types / actions). Each filter only
// narrows — empty means "all". Shared by the policy create sheet and the inline editor.

import { Boxes, ListChecks, Workflow } from "lucide-react";
import type { ConditionOptions } from "@/app/server/actions/alerts";
import { FieldHelp } from "@/components/alerts/field-help";
import { MIN_SEV_OPTIONS } from "@/components/alerts/policy-shared";
import { FacetFilter } from "@repo/ui/facet-filter";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

/** Editable conditions value (mirrors AlertRuleMatch with a "any" sentinel for severity). */
export interface ConditionsValue {
	min_severity: string;
	project_ids: string[];
	job_types: string[];
	resource_types: string[];
	actions: string[];
}

interface PolicyConditionsProps {
	value: ConditionsValue;
	onChange: (next: ConditionsValue) => void;
	options: ConditionOptions;
	editable: boolean;
}

/** Severity threshold + scope filters. */
export function PolicyConditions({
	value,
	onChange,
	options,
	editable,
}: PolicyConditionsProps) {
	const patch = (p: Partial<ConditionsValue>) => onChange({ ...value, ...p });
	const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

	if (!editable) {
		const parts: string[] = [];
		const sevLabel = MIN_SEV_OPTIONS.find(
			(o) => o.value === value.min_severity,
		)?.label;
		if (value.min_severity !== "any" && sevLabel) parts.push(sevLabel);
		if (value.project_ids.length) parts.push(`${value.project_ids.length} project(s)`);
		if (value.job_types.length) parts.push(`${value.job_types.length} job type(s)`);
		if (value.resource_types.length)
			parts.push(`${value.resource_types.length} resource type(s)`);
		if (value.actions.length) parts.push(`${value.actions.length} action(s)`);
		return (
			<p className="text-muted-foreground text-xs">
				{parts.length ? parts.join(" · ") : "Fires on every matching event."}
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<div className="flex items-center gap-1.5">
					<Label>Minimum severity</Label>
					<FieldHelp title="Minimum severity">
						Only fire when the event severity is at or above this level — useful to
						mute info-level noise across many events.
					</FieldHelp>
				</div>
				<Select
					value={value.min_severity}
					onValueChange={(val) => patch({ min_severity: val })}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{MIN_SEV_OPTIONS.map((o) => (
							<SelectItem key={o.value} value={o.value}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				<div className="flex items-center gap-1.5">
					<Label>Scope</Label>
					<FieldHelp title="Scope filters">
						Narrow the policy to specific resources. Each filter is an AND
						constraint; leaving one empty means it matches everything. Job/project
						filters apply to deploy events; resource/action filters apply to access
						(PDP) events.
					</FieldHelp>
				</div>
				<div className="flex flex-wrap gap-2">
					<FacetFilter
						label="Projects"
						icon={Boxes}
						options={options.projects}
						value={value.project_ids}
						onChange={(v) => patch({ project_ids: v })}
						searchPlaceholder="Search projects…"
						emptyText="No projects."
					/>
					<FacetFilter
						label="Job types"
						icon={Workflow}
						options={opts(options.jobTypes)}
						value={value.job_types}
						onChange={(v) => patch({ job_types: v })}
						searchPlaceholder="Search job types…"
					/>
					<FacetFilter
						label="Resource types"
						icon={Boxes}
						options={opts(options.resourceTypes)}
						value={value.resource_types}
						onChange={(v) => patch({ resource_types: v })}
						searchPlaceholder="Search resource types…"
					/>
					<FacetFilter
						label="Actions"
						icon={ListChecks}
						options={opts(options.actions)}
						value={value.actions}
						onChange={(v) => patch({ actions: v })}
						searchPlaceholder="Search actions…"
					/>
				</div>
			</div>
		</div>
	);
}
