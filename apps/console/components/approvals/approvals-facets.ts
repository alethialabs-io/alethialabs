// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approvals list's facets, as `ListToolbar` config (spec §1.3; polish-wave spec §3, #7738):
// Status, Operation, Requested through and Environment. Status opens on Waiting — the default view,
// shown as a real selection the person can clear. Option counts come from the server's facet pass
// over the unfiltered universe, so picking an option never makes another vanish. No result count
// anywhere (lib/query/README.md → "Counts").

import type { ListToolbarFacet } from "@repo/ui/list-toolbar";
import { Activity, Layers, Send, Wrench } from "lucide-react";
import type { ApprovalFacets } from "@/lib/queries/approvals";
import type { FacetOption } from "@/lib/queries/facets";
import type { useApprovalsFilters } from "@/lib/stores/use-approvals-filters";
import { lookup } from "@/lib/typed-object";
import { APPROVAL_STATUS, CREDENTIAL_LABEL, OPERATION_LABEL } from "./approval-vocabulary";

/** The approvals filter store's state; the facets' values and mutators are the store's own. */
type ApprovalsFilterStore = ReturnType<typeof useApprovalsFilters.getState>;

/** Facet options with the client's labels; each carries its count over the unfiltered universe. */
function options(facet: FacetOption[] | undefined, label: (o: FacetOption) => string) {
	return (facet ?? []).map((o) => ({ value: o.value, label: label(o), count: o.count }));
}

/** A status value's label, or the raw value for one the vocabulary does not name. */
function statusLabel(value: string): string {
	return lookup(APPROVAL_STATUS, value)?.label ?? value;
}

/** An operation value's label, or the raw value. */
function operationLabel(value: string): string {
	return lookup(OPERATION_LABEL, value) ?? value;
}

/** A credential value's label, or the raw value. */
function credentialLabel(value: string): string {
	return lookup(CREDENTIAL_LABEL, value) ?? value;
}

/**
 * The four facets of the approvals toolbar. `facets` is undefined until the first answer; the
 * facets then show with no options, and a value the link carried (Status: Waiting) still reads by
 * its label.
 */
export function approvalToolbarFacets(
	filters: ApprovalsFilterStore["filters"],
	set: ApprovalsFilterStore["set"],
	facets: ApprovalFacets | undefined,
): ListToolbarFacet[] {
	return [
		{
			label: "Status",
			icon: Activity,
			options: options(facets?.status, (o) => statusLabel(o.value)),
			value: filters.status,
			onChange: (next) => set("status", next),
			searchPlaceholder: "Search statuses…",
			formatValue: statusLabel,
		},
		{
			label: "Operation",
			icon: Wrench,
			options: options(facets?.operation, (o) => operationLabel(o.value)),
			value: filters.operation,
			onChange: (next) => set("operation", next),
			searchPlaceholder: "Search operations…",
			formatValue: operationLabel,
		},
		{
			label: "Requested through",
			icon: Send,
			options: options(facets?.credential, (o) => credentialLabel(o.value)),
			value: filters.credential,
			onChange: (next) => set("credential", next),
			searchPlaceholder: "Search…",
			emptyText: "Nothing has asked yet.",
			formatValue: credentialLabel,
		},
		{
			label: "Environment",
			icon: Layers,
			options: options(facets?.environment, (o) => o.label ?? o.value),
			value: filters.environment,
			onChange: (next) => set("environment", next),
			searchPlaceholder: "Search environments…",
		},
	];
}
