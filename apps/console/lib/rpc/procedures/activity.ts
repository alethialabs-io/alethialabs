// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { z } from "zod";
import type { ActivityPage, ActivityQuery } from "@/app/server/actions/activity";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize, currentActor } from "@/lib/authz/guard";
import { queryActivityPage } from "@/lib/queries/activity";
import { query } from "@/lib/rpc/base";

// THE ACTIVITY READS (ADR 0005 D1, #6129). Both bodies MOVED here from `app/server/actions/
// activity.ts` (`getActivityLog`, `getActivityPermissions`) — not wrapped — so the feed reads over
// GET and the route prefetches the first page in-process. The authorization is the one they had:
//
//   · the log answers `activity:view_activity`, ENFORCED — the same permission `app/api/cli/
//     activity/route.ts` enforces (#3932). A successful `view_activity` is not recorded (READ_ONLY in
//     lib/authz/activity.ts), so paging the feed writes nothing into the log it is reading; a denial
//     is recorded, and is a typed FORBIDDEN the page renders as its no-access state;
//   · the permissions answer any member: they are `can()` questions, which record nothing.
//
// TENANCY. The actor is the one the read router bound for the request's ADDRESS (`lib/rpc/base.ts`),
// and `queryActivityPage` puts `org_id = actor.orgId` on every pass (the rows and the facets). The
// ids in the input — actors, resources, a project — are FILTERS inside that org; none widens it.

/** The page size the feed walks the id-descending cursor in. */
const PAGE_SIZE = 50;

/** A short list of ids or tokens, as the filter bar sends them. */
const idList = z.array(z.string().uuid()).max(200).optional();

/** The feed's query (`activityQueryFrom()`), plus the infinite query's cursor. */
const activityPageInput = z.object({
	cursor: z.number().int().positive().nullable().optional(),
	limit: z.number().int().min(1).max(100).optional(),
	projectId: z.string().uuid().optional(),
	from: z.string().datetime({ offset: true }).optional(),
	to: z.string().datetime({ offset: true }).optional(),
	actorIds: idList,
	resourceTypes: z.array(z.string().min(1).max(64)).max(100).optional(),
	decision: z.boolean().nullable().optional(),
	resourceIds: idList,
	search: z.string().max(200).optional(),
});

/**
 * A filtered, cursor-paginated page of the addressed org's Activity log — every recorded action
 * and denial — newest first (by insertion id), with the filter bar's facet counts on the first
 * page. Gated on `activity:view_activity`.
 */
export async function readActivityPage(input: ActivityQuery): Promise<ActivityPage> {
	const actor = await authorize("view_activity", { type: "activity" });
	return queryActivityPage(actor.orgId, input, PAGE_SIZE);
}

/** What the caller may do with the Activity log, and whether the org's plan includes export. */
export interface ActivityPermissions {
	canView: boolean;
	canExport: boolean;
	/** The `activityExport` entitlement — the plan half of the Export button, known at first paint. */
	exportEntitled: boolean;
}

/**
 * The caller's `activity:view_activity` / `activity:export_activity` decisions and the export
 * entitlement, for the Activity pages to decide what to render (#3932). Uses `can()`, so asking
 * records nothing; the reads and the export enforce the same permissions themselves, so this is
 * presentation, not the gate.
 */
export async function readActivityPermissions(): Promise<ActivityPermissions> {
	const actor = await currentActor();
	const pdp = getPdp();
	const [view, exp] = await Promise.all([
		pdp.can(actor, "view_activity", { type: "activity" }),
		pdp.can(actor, "export_activity", { type: "activity" }),
	]);
	return { canView: view.allowed, canExport: exp.allowed, exportEntitled: getEntitlements(actor).activityExport };
}

/** The Activity reads (#6129). */
export const activityRouter = {
	page: query.input(activityPageInput).handler(({ input }) => readActivityPage(input)),
	permissions: query.handler(() => readActivityPermissions()),
};
