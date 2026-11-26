// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { z } from "zod";
import { currentActor } from "@/lib/authz/guard";
import { viewableProjectIds } from "@/lib/jobs/visibility";
import { type EvidenceWaiversPage, queryEvidenceWaiversPage } from "@/lib/queries/evidence";
import { type EvidencePosturePage, queryEvidencePosturePage } from "@/lib/queries/evidence-posture";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetTextPageRequest,
	keysetPageInput,
	keysetTextPageInput,
} from "@/lib/queries/keyset";
import { query } from "@/lib/rpc/base";

// The Evidence surface's reads (day-2 "keep proving it"): the posture table — the verification +
// drift + security roll-up, filtered, grouped and PAGED on the server so the client only renders —
// and the recorded-waivers log. Moved here from the `getOrgEvidence` server action (#6126, ADR 0005
// D1): GET procedures under `/{org}/~/rpc`, so the tenant is the org the ADDRESS names — never the
// session's — and the reads no longer queue behind other server actions.

/** A filter list as it travels: short strings, a bounded count. Unknown values are dropped later. */
const filterList = z.array(z.string().max(64)).max(32).optional();

/**
 * The posture table's input: its filters (the normalized query, `normalizeEvidenceQuery`) and the
 * paging half — an opaque keyset text cursor over `(group sort text, project id)` and a limit that
 * counts project groups (lib/queries/evidence-posture.ts). Every filter is optional — omitted means
 * "no filter". Values are plain strings because they are whatever a link carried; the builder narrows
 * them to the known keys, so input cannot widen a filter.
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
	...keysetTextPageInput("uuid"),
});

/** Filters describing the current Evidence view (the paging half excluded). */
export type EvidenceQuery = Omit<z.output<typeof evidencePageInput>, "cursor" | "limit">;

/**
 * One page of the addressed org's posture table, over the projects the reader may view. Evidence
 * rows follow project visibility: a member denied `view` on a project sees none of its environments,
 * posture or waivers. The project set is the one job visibility follows (`viewableProjectIds`,
 * lib/jobs/visibility.ts), memoized per render; the roll-up intersects it with the addressed org's
 * own projects (lib/queries/evidence.ts). The personal scope is an org like any other here: its
 * projects carry `org_id = user_id`, so a person's own environments show up rather than "No
 * environments yet".
 */
export async function readOrgEvidence(
	input: EvidenceQuery & Partial<KeysetTextPageRequest> = {},
): Promise<EvidencePosturePage> {
	const { cursor, limit = KEYSET_DEFAULT_LIMIT, ...filters } = input;
	const actor = await currentActor();
	const projectIds = await viewableProjectIds(actor);
	return queryEvidencePosturePage(actor.orgId, projectIds, filters, { cursor, limit });
}

/**
 * The recorded-waivers list's input: the paging half only (an opaque cursor, a limit). The list has
 * no filter bar, so there are no filter fields beside it.
 */
const evidenceWaiversInput = z.object({ ...keysetPageInput("uuid") });

/**
 * One page of the addressed org's recorded waivers — in force and expired, newest first — over the
 * projects the reader may view (the same visibility as {@link readOrgEvidence}; org-level waivers are
 * org-wide). Keyset-paged (#7488): every waiver is reachable, none is cut at a cap.
 */
export async function readOrgEvidenceWaivers(
	input: z.infer<typeof evidenceWaiversInput>,
): Promise<EvidenceWaiversPage> {
	const actor = await currentActor();
	const projectIds = await viewableProjectIds(actor);
	return queryEvidenceWaiversPage(actor.orgId, projectIds, { cursor: input.cursor, limit: input.limit });
}

/**
 * The evidence domain's reads (ADR 0005 D1, #6126). `page` backs `/{org}/~/evidence`'s posture
 * table, keyset-paged (#7755): the route prefetches its first page in-process for the link's filters
 * and the client walks the same infinite key (`useKeysetList`). `waivers` is the page's
 * recorded-waivers list, read page by page the same way.
 */
export const evidenceRouter = {
	page: query.input(evidencePageInput).handler(({ input }) => readOrgEvidence(input)),
	waivers: query.input(evidenceWaiversInput).handler(({ input }) => readOrgEvidenceWaivers(input)),
};
