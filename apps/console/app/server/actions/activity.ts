"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Activity log's one WRITE-SHAPED action, plus the feed's types (ADR 0005 D1/D4, #6129). The
// feed's reads — the log page and the caller's permissions — moved to `lib/rpc/procedures/
// activity.ts` and are served over GET. The CSV export stays an action: it is not a page read, and
// an allowed `export_activity` is RECORDED in the log (it is not READ_ONLY), so it is a write to the
// log as much as a read of it. It is a `defineAction` returning `ActionResult<string>`.

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { getEntitlements } from "@/lib/authz/entitlements";
import { getPdp } from "@/lib/authz";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, user } from "@/lib/db/schema";
import { type ActivityFacets, activitySelect } from "@/lib/queries/activity";

export interface ActivityRow {
	id: string;
	actorId: string;
	actorName: string | null;
	actorEmail: string | null;
	actorImage: string | null;
	actorUsername: string | null;
	action: string;
	resourceType: string;
	resourceId: string | null;
	decision: boolean;
	reason: string | null;
	ts: string;
}

/** A filtered, cursor-paginated slice of the Activity log + the cursor for the next page. */
export interface ActivityPage {
	rows: ActivityRow[];
	/** The `id` to pass as `cursor` for the next page, or null when this is the last page. */
	nextCursor: number | null;
	/** The User / Project / Events facet counts over the scope's UNFILTERED log. Present on the
	 *  first page only (null when `cursor` was set): a later page walks the same universe. */
	facets: ActivityFacets | null;
}

/** Filters + cursor for the `activity.page` read; all fields optional (omitted = no filter). */
export interface ActivityQuery {
	/** Last row `id` seen — fetches strictly-older rows. Omit/null for the first page. */
	cursor?: number | null;
	/** Page size (rows returned); defaults to the read's page size (50). */
	limit?: number;
	/** SCOPE, not a filter: a project's own Activity page pins the feed to this project id. The
	 *  facet counts see it; they never see any of the filters below. */
	projectId?: string;
	/** ISO timestamps bounding `ts` (inclusive). */
	from?: string;
	to?: string;
	/** Restrict to these actor user-ids. */
	actorIds?: string[];
	/** Restrict to these resource types (from the event-type "type:" tokens). */
	resourceTypes?: string[];
	/** Restrict to allow (`true`) or deny (`false`); omit/null for both. */
	decision?: boolean | null;
	/** Restrict to these resource ids (the Project facet's selected project ids). */
	resourceIds?: string[];
	/** Case-insensitive match over actor name/email, action, and resource type. */
	search?: string;
}

// Export dumps a larger cap than the feed's page.
const EXPORT_LIMIT = 10_000;

/** The export takes no arguments; the org is the request's address. */
const exportInput = z.object({});

/** Escapes a value as a CSV cell (always quoted, doubled inner quotes). */
function csvCell(value: string | boolean | null): string {
	const s = value === null ? "" : String(value);
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Exports the addressed org's Activity log as CSV. Enforces the `activityExport` entitlement
 * server-side (not just in the UI) — community/unlicensed callers get an `entitlement` refusal —
 * AND the `activity:export_activity` permission (#3932), which the entitlement alone never checked
 * (a `forbidden` result).
 *
 * The entitlement is checked FIRST so an unlicensed call is refused without touching the PDP: an
 * allowed `export_activity` is recorded in the Activity log (it is not READ_ONLY), and a row saying
 * "exported the activity log" must not be written for an export that was then refused.
 */
export async function getActivityExportCsv(raw: z.input<typeof exportInput> = {}): Promise<ActionResult<string>> {
	return defineAction({
		input: exportInput,
		run: async () => {
			const actor = await currentActor();
			if (!getEntitlements(actor).activityExport) {
				throw new ActionRefusal("entitlement", "Activity export requires an Enterprise license.", "activityExport");
			}
			await getPdp().enforce(actor, "export_activity", { type: "activity" });
			const rows = await getServiceDb()
				.select(activitySelect())
				.from(authzActivityLog)
				.leftJoin(user, eq(authzActivityLog.actor_id, user.id))
				.where(eq(authzActivityLog.org_id, actor.orgId))
				.orderBy(desc(authzActivityLog.id))
				.limit(EXPORT_LIMIT);

			const header = ["time", "actor", "action", "resource_type", "resource_id", "decision", "reason"].join(",");
			const lines = rows.map((r) =>
				[
					csvCell(r.ts.toISOString()),
					csvCell(r.actorEmail ?? r.actorId),
					csvCell(r.action),
					csvCell(r.resourceType),
					csvCell(r.resourceId),
					csvCell(r.decision ? "allow" : "deny"),
					csvCell(r.reason),
				].join(","),
			);
			return [header, ...lines].join("\n");
		},
	})(raw);
}
