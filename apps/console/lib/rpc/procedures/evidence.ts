// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { z } from "zod";
import {
	deriveGroups,
	isStatusKey,
	matchesTriage,
	type RowGroup,
	STATUS_FACETS,
	stageLabel,
	waivedEnvSet,
} from "@/components/evidence/evidence-derive";
import {
	CLOUD_FILTER_VALUES,
	OTHER_PROVIDER,
	providerKey,
} from "@/components/evidence/evidence-query";
import { getPdp } from "@/lib/authz";
import { currentActor } from "@/lib/authz/guard";
import {
	type EvidenceSummary,
	type EvidenceWaiver,
	type OrgEvidence,
	queryOrgEvidence,
} from "@/lib/queries/evidence";
import { query } from "@/lib/rpc/base";

// The Evidence surface's read (day-2 "keep proving it"): the verification + drift + waiver roll-up,
// filtered and grouped on the server so the client only renders. Moved here from the
// `getOrgEvidence` server action (#6126, ADR 0005 D1): a GET procedure under `/{org}/~/rpc`, so the
// tenant is the org the ADDRESS names — never the session's — and the read no longer queues behind
// other server actions.

/** A filter list as it travels: short strings, a bounded count. Unknown values are dropped below. */
const filterList = z.array(z.string().max(64)).max(32).optional();

/**
 * The Evidence view's filters (the normalized query, `normalizeEvidenceQuery`). Every field is
 * optional — omitted means "no filter". Values are plain strings because they are whatever a link
 * carried; {@link buildEvidenceResult} narrows them to the known keys, so input cannot widen a filter.
 */
const evidencePageInput = z.object({
	/** Case-insensitive match over project / environment / region / provider. */
	search: z.string().max(200).optional(),
	/** Restrict to these stages (production/staging/development). */
	stages: filterList,
	/** Restrict to these statuses (OR semantics). */
	status: filterList,
	/** Restrict to these provider facet keys (cloud slugs or "other"). */
	providers: filterList,
});

/** Filters describing the current Evidence view. */
export type EvidenceQuery = z.infer<typeof evidencePageInput>;

/** One selectable option in a Status / Stage / Cloud facet, with its match count over the roll-up. */
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
	/** Environments the reader can see (the facet-count / "N of M" denominator). */
	total: number;
	/** Recorded verification waivers (newest first) — the waivers panel. */
	waivers: EvidenceWaiver[];
	/** The posture counters over every visible environment (unfiltered). */
	summary: EvidenceSummary;
	statusOptions: EvidenceFacetOption[];
	stageOptions: EvidenceFacetOption[];
	/** Provider facet options: every enum cloud (count may be 0) + "other" when present. */
	providerOptions: EvidenceFacetOption[];
}

const STAGE_SORT = new Map<string, number>([
	["production", 0],
	["staging", 1],
	["development", 2],
]);

/** Filters + groups a roll-up per the query and computes the facet option counts. */
function buildEvidenceResult(ev: OrgEvidence, input: EvidenceQuery): EvidenceResult {
	// Providers narrow to the known facet keys (enum clouds + "other") so untrusted client strings
	// can't widen the filter.
	const knownProviders = new Set<string>([...CLOUD_FILTER_VALUES, OTHER_PROVIDER]);
	const { groups, resultCount } = deriveGroups(ev, {
		search: input.search ?? "",
		stages: input.stages ?? [],
		status: (input.status ?? []).filter(isStatusKey),
		providers: (input.providers ?? []).filter((p) => knownProviders.has(p)),
	});

	// Facet counts are over the whole roll-up (unfiltered), so each option shows how many
	// environments it would select.
	const waived = waivedEnvSet(ev.waivers);
	const statusOptions: EvidenceFacetOption[] = STATUS_FACETS.map((f) => ({
		value: f.key,
		label: f.label,
		count: ev.rows.filter((r) => matchesTriage(r, f.key, waived)).length,
	}));

	const stageCounts = new Map<string, number>();
	for (const r of ev.rows) stageCounts.set(r.stage, (stageCounts.get(r.stage) ?? 0) + 1);
	const stageOptions: EvidenceFacetOption[] = [...stageCounts.keys()]
		.sort((a, b) => (STAGE_SORT.get(a) ?? 9) - (STAGE_SORT.get(b) ?? 9))
		.map((s) => ({ value: s, label: stageLabel(s), count: stageCounts.get(s) ?? 0 }));

	// Provider facet: every enum cloud (even at 0, so the filter reads as "what Alethia supports"),
	// plus "other" only when rows fall outside it (null/mixed/unknown providers).
	const providerCounts = new Map<string, number>();
	for (const r of ev.rows) {
		const key = providerKey(r.provider);
		providerCounts.set(key, (providerCounts.get(key) ?? 0) + 1);
	}
	const providerOptions: EvidenceFacetOption[] = CLOUD_FILTER_VALUES.map((v) => ({
		value: v,
		label: PROVIDER_LABELS[v],
		count: providerCounts.get(v) ?? 0,
	}));
	const otherCount = providerCounts.get(OTHER_PROVIDER) ?? 0;
	if (otherCount > 0) providerOptions.push({ value: OTHER_PROVIDER, label: "Other", count: otherCount });

	return {
		groups,
		resultCount,
		total: ev.summary.environments,
		waivers: ev.waivers,
		summary: ev.summary,
		statusOptions,
		stageOptions,
		providerOptions,
	};
}

/**
 * The addressed org's evidence roll-up, filtered + grouped by `input`, over the projects the reader
 * may view. Evidence rows follow project visibility: a member denied `view` on a project sees none of
 * its environments, posture or waivers — the same rule the jobs reads apply. The personal scope is
 * an org like any other here: its projects carry `org_id = user_id`, so a person's own environments
 * show up rather than "No environments yet".
 */
export async function readOrgEvidence(input: EvidenceQuery = {}): Promise<EvidenceResult> {
	const actor = await currentActor();
	const projectIds = await getPdp().listAccessible(actor, "view", "project");
	return buildEvidenceResult(await queryOrgEvidence(actor.orgId, projectIds), input);
}

/**
 * The evidence domain's reads (ADR 0005 D1, #6126). `page` backs `/{org}/~/evidence`: the route
 * prefetches it in-process for the link's filters and the client reads the same key.
 */
export const evidenceRouter = {
	page: query.input(evidencePageInput).handler(({ input }) => readOrgEvidence(input)),
};
