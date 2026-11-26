// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { PROVIDER_LABELS } from "@repo/ui/provider-icon";
import {
	deriveGroups,
	groupSortText,
	isStatusKey,
	matchesTriage,
	type RowGroup,
	STATUS_FACETS,
	stageLabel,
	waivedEnvSet,
} from "@/components/evidence/evidence-derive";
import { CLOUD_FILTER_VALUES, OTHER_PROVIDER, providerKey } from "@/components/evidence/evidence-query";
import { type EvidenceWaiver, type OrgEvidence, queryOrgEvidence } from "./evidence";
import {
	type KeysetListPage,
	type KeysetTextPageRequest,
	keysetListPage,
	keysetTextPageInMemory,
} from "./keyset";

// The Evidence posture table on the console list standard (lib/query/README.md → "Paging"; #7755).
//
// THE UNIVERSE IS COMPOSED, so it is paged in memory on the server (the runners / clusters shape).
// A posture row is not a table's row: it is an environment joined with its latest verify verdict,
// drift scan, security scan and the waivers in force (queryOrgEvidence's five reads), and the status
// it is filtered under and the worst-first score it is ordered by are DERIVED from all of that. No
// SQL ORDER BY can express that order, so the roll-up is read whole, filtered, grouped and ordered
// here, and only one page of it leaves the server.
//
// WHAT A ROW IS. The table is grouped by project, so a page's row is a PROJECT GROUP — the project
// header and every environment of it that matches the filters — keyed by the project id. A page
// never splits a project across two pages, so a group header is drawn once and its environments stay
// worst-first under it. `limit` counts groups.
//
// THE ORDER is deriveGroups': projects by their most-urgent environment, then by name, then by id —
// one total order, written once as `groupSortText` + `compareGroups` (components/evidence/
// evidence-derive.ts). The cursor is the keyset TEXT mode over `(groupSortText, project id)`, so page
// two starts strictly after the last project of page one in that same order. That is what answers
// the objection the old `bounded` decision recorded: the order is computed over the WHOLE filtered
// universe before the cut, so page one holds the worst projects of the org, not "the worst of page
// one".
//
// THE SORT KEY MOVES. A project's position is its worst score, and a new verdict or scan between two
// page reads can move it: a project that rises above the cursor is not shown again on the walk (the
// change stream invalidates the list, which re-reads from page one), and one that falls below it is
// shown twice, which `useKeysetList` draws once (rows are joined keeping each id once). The same is
// true of every keyset list over a mutable sort key.
//
// FACETS come from the UNFILTERED universe (step 6): the facet pass is handed the whole roll-up and
// never the query, on the first page only. `universeEmpty` is whether the reader can see any
// environment at all — the onboarding render.

/** One selectable option in a Status / Stage / Cloud facet, with its match count over the roll-up. */
export interface EvidenceFacetOption {
	value: string;
	label: string;
	count: number;
}

/** The facet pass over the unfiltered roll-up: the three option lists the filter bar renders. */
export interface EvidenceFacets {
	statusOptions: EvidenceFacetOption[];
	stageOptions: EvidenceFacetOption[];
	/** Provider facet options: every enum cloud (count may be 0) + "other" when present. */
	providerOptions: EvidenceFacetOption[];
}

/** The posture table's filters, as the read procedure's input carries them (untrusted strings). */
export interface EvidencePostureQuery {
	/** Case-insensitive match over project / environment / region / provider. */
	search?: string;
	/** Restrict to these stages (production/staging/development). */
	stages?: string[];
	/** Restrict to these statuses (OR semantics). Unknown keys are dropped. */
	status?: string[];
	/** Restrict to these provider facet keys (cloud slugs or "other"). Unknown keys are dropped. */
	providers?: string[];
}

/** One row of the posture table's page: a project group, keyed by its project id. */
export interface EvidenceGroupRow extends RowGroup {
	/** The project id (= `key`) — the keyset tiebreaker and the row key `useKeysetList` dedupes on. */
	id: string;
	/**
	 * The waivers IN FORCE that name this project — what the detail drawer lists for one of its
	 * environments. Carried on the group so the drawer never needs the org's whole waiver set, which a
	 * paged table no longer holds.
	 */
	waivers: EvidenceWaiver[];
}

/** One page of the posture table. */
export type EvidencePosturePage = KeysetListPage<EvidenceGroupRow, EvidenceFacets>;

const STAGE_SORT = new Map<string, number>([
	["production", 0],
	["staging", 1],
	["development", 2],
]);

/**
 * The facet pass: option counts over the WHOLE roll-up (never the query), so each option shows how
 * many environments it would select and none vanishes as it is picked.
 */
export function evidenceFacets(ev: OrgEvidence): EvidenceFacets {
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

	// Every enum cloud (even at 0, so the filter reads as "what Alethia supports"), plus "other" only
	// when rows fall outside it (null/mixed/unknown providers).
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

	return { statusOptions, stageOptions, providerOptions };
}

/**
 * Pages a roll-up on the keyset contract: filters it by `query` (untrusted values narrowed to the
 * known keys, so input cannot widen a filter), groups it by project in the posture order, and cuts
 * `page.limit` groups strictly after `page.cursor`. Page one also carries the facet pass over the
 * unfiltered roll-up and whether the reader can see any environment at all.
 */
export function evidencePosturePage(
	ev: OrgEvidence,
	query: EvidencePostureQuery,
	page: KeysetTextPageRequest,
): EvidencePosturePage {
	const knownProviders = new Set<string>([...CLOUD_FILTER_VALUES, OTHER_PROVIDER]);
	const { groups } = deriveGroups(ev, {
		search: query.search ?? "",
		stages: query.stages ?? [],
		status: (query.status ?? []).filter(isStatusKey),
		providers: (query.providers ?? []).filter((p) => knownProviders.has(p)),
	});
	const rows: EvidenceGroupRow[] = groups.map((g) => ({
		...g,
		id: g.key,
		waivers: ev.waivers.filter((w) => w.active && w.projectName === g.label),
	}));
	const cut = keysetTextPageInMemory(rows, page, (g) => ({ text: groupSortText(g), id: g.id }));
	const first = page.cursor === undefined ? { facets: evidenceFacets(ev), universeEmpty: ev.rows.length === 0 } : null;
	return keysetListPage(cut, first);
}

/**
 * One page of the posture table of `orgId`, over the projects in `projectIds` — the ones the reader
 * may view. Reads the roll-up (queryOrgEvidence, which scopes every pass to those projects of this
 * org) and pages it with {@link evidencePosturePage}.
 */
export async function queryEvidencePosturePage(
	orgId: string,
	projectIds: readonly string[],
	query: EvidencePostureQuery,
	page: KeysetTextPageRequest,
): Promise<EvidencePosturePage> {
	return evidencePosturePage(await queryOrgEvidence(orgId, projectIds), query, page);
}
