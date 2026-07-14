"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Evidence surface server action (day-2 "keep proving it"): the org-wide verification +
// drift + waiver roll-up, filtered + grouped server-side (mirrors getActivityLog — all
// filtering happens here, off the client). Read-only; scoped to the actor's active org
// (never a client-supplied org id). Personal scope has no org-level evidence → empty roll-up.

import {
	deriveGroups,
	isStatusKey,
	matchesTriage,
	type RowGroup,
	STATUS_FACETS,
	stageLabel,
	toGroupMode,
	toSortKey,
	waivedEnvSet,
} from "@/components/evidence/evidence-derive";
import { currentActor } from "@/lib/authz/guard";
import {
	type EvidenceWaiver,
	type OrgEvidence,
	queryOrgEvidence,
} from "@/lib/queries/evidence";

// Filter fields are plain strings (whatever the facet/select sends) — the action narrows
// them to the known GroupMode/SortKey/Status keys, so untrusted client input can't widen them.
/** Filters describing the current Evidence view; all fields optional (omitted = default). */
export interface EvidenceQuery {
	/** Case-insensitive match over project / environment / region / provider. */
	search?: string;
	/** Restrict to these stages (production/staging/development); empty = all. */
	stages?: string[];
	/** Restrict to these statuses (OR semantics); empty = all. Unknown keys are ignored. */
	status?: string[];
	/** Row grouping; defaults to triage buckets. */
	group?: string;
	/** Row ordering within each group; defaults to worst-first. */
	sort?: string;
}

/** One selectable option in a Status / Stage facet, with its match count over the roll-up. */
export interface EvidenceFacetOption {
	value: string;
	label: string;
	count: number;
}

/** The filtered, grouped Evidence view + the facet options that drive its filter bar. */
export interface EvidenceResult {
	/** Filtered → grouped → sorted rows (from deriveGroups); drives the posture table. */
	groups: RowGroup[];
	/** Environments matching the current filters. */
	resultCount: number;
	/** Total environments in the org (the facet-count / "N of M" denominator). */
	total: number;
	/** Recorded verification waivers (newest first) — the waivers panel. */
	waivers: EvidenceWaiver[];
	statusOptions: EvidenceFacetOption[];
	stageOptions: EvidenceFacetOption[];
}

const STAGE_SORT: Record<string, number> = {
	production: 0,
	staging: 1,
	development: 2,
};

/** The empty roll-up returned for personal scope (no org projects/environments to prove). */
const EMPTY_EVIDENCE: OrgEvidence = {
	rows: [],
	waivers: [],
	summary: {
		environments: 0,
		verified: 0,
		warning: 0,
		failing: 0,
		notEvaluable: 0,
		unverified: 0,
		inSync: 0,
		drifted: 0,
		driftUnknown: 0,
		activeWaivers: 0,
		criticalHighVulns: 0,
		securityUnknown: 0,
	},
};

/** Filters + groups a roll-up per the query and computes the facet option counts. */
function buildEvidenceResult(
	ev: OrgEvidence,
	query: EvidenceQuery,
): EvidenceResult {
	const { groups, resultCount } = deriveGroups(ev, {
		search: query.search ?? "",
		stages: query.stages ?? [],
		status: (query.status ?? []).filter(isStatusKey),
		group: toGroupMode(query.group),
		sort: toSortKey(query.sort),
	});

	// Facet counts are over the whole roll-up (unfiltered), so each option shows how many
	// environments it would select — like the Activity facets' fixed option lists.
	const waived = waivedEnvSet(ev.waivers);
	const statusOptions: EvidenceFacetOption[] = STATUS_FACETS.map((f) => ({
		value: f.key,
		label: f.label,
		count: ev.rows.filter((r) => matchesTriage(r, f.key, waived)).length,
	}));

	const stageCounts = new Map<string, number>();
	for (const r of ev.rows)
		stageCounts.set(r.stage, (stageCounts.get(r.stage) ?? 0) + 1);
	const stageOptions: EvidenceFacetOption[] = [...stageCounts.keys()]
		.sort((a, b) => (STAGE_SORT[a] ?? 9) - (STAGE_SORT[b] ?? 9))
		.map((s) => ({
			value: s,
			label: stageLabel(s),
			count: stageCounts.get(s) ?? 0,
		}));

	return {
		groups,
		resultCount,
		total: ev.summary.environments,
		waivers: ev.waivers,
		statusOptions,
		stageOptions,
	};
}

/**
 * The active org's evidence roll-up (verify verdicts, drift posture, active waivers), filtered
 * + grouped by `query`. Scoped to the actor's active org; all filtering happens here so the
 * client only renders. Personal scope (orgId === userId) returns an empty view.
 */
export async function getOrgEvidence(
	query: EvidenceQuery = {},
): Promise<EvidenceResult> {
	const actor = await currentActor();
	const ev =
		actor.orgId === actor.userId
			? EMPTY_EVIDENCE
			: await queryOrgEvidence(actor.orgId);
	return buildEvidenceResult(ev, query);
}
