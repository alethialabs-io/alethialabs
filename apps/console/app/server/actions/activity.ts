"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, gte, ilike, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import { getEntitlements } from "@/lib/authz/entitlements";
import { getPdp } from "@/lib/authz";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import { authzActivityLog, user } from "@/lib/db/schema";

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
}

/** Filters + cursor for {@link getActivityLog}; all fields optional (omitted = no filter). */
export interface ActivityQuery {
	/** Last row `id` seen — fetches strictly-older rows. Omit/null for the first page. */
	cursor?: number | null;
	/** Page size (rows returned); defaults to {@link PAGE_SIZE}. */
	limit?: number;
	/** ISO timestamps bounding `ts` (inclusive). */
	from?: string;
	to?: string;
	/** Restrict to these actor user-ids. */
	actorIds?: string[];
	/** Restrict to these resource types (from the event-type "type:" tokens). */
	resourceTypes?: string[];
	/** Restrict to allow (`true`) or deny (`false`); omit/null for both. */
	decision?: boolean | null;
	/** Restrict to these resource ids (the Project filter, resolved to project ids). */
	resourceIds?: string[];
	/** Case-insensitive match over actor name/email, action, and resource type. */
	search?: string;
}

// The viewer pages the log a screenful at a time (cursor by id); export dumps a larger cap.
const PAGE_SIZE = 50;
const EXPORT_LIMIT = 10_000;

/** The "select" shape shared by the viewer + export, joined to the acting user. */
function activitySelect() {
	return {
		id: authzActivityLog.id,
		actorId: authzActivityLog.actor_id,
		actorName: user.name,
		actorEmail: user.email,
		actorImage: user.image,
		actorUsername: user.username,
		action: authzActivityLog.action,
		resourceType: authzActivityLog.resource_type,
		resourceId: authzActivityLog.resource_id,
		decision: authzActivityLog.decision,
		reason: authzActivityLog.reason,
		ts: authzActivityLog.ts,
	};
}

/**
 * A filtered, cursor-paginated page of the active org's Activity log — every recorded action +
 * denial — newest first (by insertion id). Community-real (the PDP writes it). Scoped by
 * `org_id`; all filtering happens here so paging stays correct across pages.
 *
 * Gated on `activity:view_activity`, the same permission `app/api/cli/activity/route.ts`
 * enforces (#3932) — before this, any org member read the whole log here while the CLI refused
 * them. A successful `view_activity` is not recorded (READ_ONLY in lib/authz/activity.ts), so
 * paging the feed does not write rows into the log it is reading; a denial is recorded.
 */
export async function getActivityLog(query: ActivityQuery = {}): Promise<ActivityPage> {
	const actor = await authorize("view_activity", { type: "activity" });
	const limit = query.limit ?? PAGE_SIZE;

	const conditions: (SQL | undefined)[] = [
		eq(authzActivityLog.org_id, actor.orgId),
		query.cursor != null ? lt(authzActivityLog.id, query.cursor) : undefined,
		query.from ? gte(authzActivityLog.ts, new Date(query.from)) : undefined,
		query.to ? lte(authzActivityLog.ts, new Date(query.to)) : undefined,
		query.actorIds?.length
			? inArray(authzActivityLog.actor_id, query.actorIds)
			: undefined,
		query.resourceTypes?.length
			? inArray(authzActivityLog.resource_type, query.resourceTypes)
			: undefined,
		query.resourceIds?.length
			? inArray(authzActivityLog.resource_id, query.resourceIds)
			: undefined,
		query.decision != null ? eq(authzActivityLog.decision, query.decision) : undefined,
	];
	if (query.search?.trim()) {
		const like = likeTerm(query.search.trim());
		conditions.push(
			or(
				ilike(user.name, like),
				ilike(user.email, like),
				ilike(authzActivityLog.action, like),
				ilike(authzActivityLog.resource_type, like),
			),
		);
	}

	// Fetch one extra row to detect whether a further page exists.
	const rows = await getServiceDb()
		.select(activitySelect())
		.from(authzActivityLog)
		.leftJoin(user, eq(authzActivityLog.actor_id, user.id))
		.where(and(...conditions))
		.orderBy(desc(authzActivityLog.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore ? page[page.length - 1].id : null;

	return {
		rows: page.map((r) => ({ ...r, id: String(r.id), ts: r.ts.toISOString() })),
		nextCursor,
	};
}

/** What the caller may do with the Activity log: read it, and export it. */
export interface ActivityPermissions {
	canView: boolean;
	canExport: boolean;
}

/**
 * The caller's `activity:view_activity` / `activity:export_activity` decisions, for the Activity
 * pages to decide what to render (#3932). Uses `can()`, so asking records nothing; the actions
 * above enforce the same permissions themselves, so this is presentation, not the gate.
 */
export async function getActivityPermissions(): Promise<ActivityPermissions> {
	const actor = await currentActor();
	const pdp = getPdp();
	const [view, exp] = await Promise.all([
		pdp.can(actor, "view_activity", { type: "activity" }),
		pdp.can(actor, "export_activity", { type: "activity" }),
	]);
	return { canView: view.allowed, canExport: exp.allowed };
}

/** Escapes a value as a CSV cell (always quoted, doubled inner quotes). */
function csvCell(value: string | boolean | null): string {
	const s = value === null ? "" : String(value);
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Exports the org's Activity log as CSV. Enforces the `activityExport` entitlement
 * server-side (not just in the UI) — community/unlicensed callers are rejected — AND the
 * `activity:export_activity` permission (#3932), which the entitlement alone never checked.
 *
 * The entitlement is checked FIRST so an unlicensed call is refused without touching the PDP:
 * an allowed `export_activity` is recorded in the Activity log (it is not READ_ONLY), and a row
 * saying "exported the activity log" must not be written for an export that was then refused.
 */
export async function getActivityExportCsv(): Promise<string> {
	const actor = await currentActor();
	if (!getEntitlements(actor).activityExport) {
		throw new Error("Activity export requires an Enterprise license.");
	}
	await getPdp().enforce(actor, "export_activity", { type: "activity" });
	const rows = await getServiceDb()
		.select(activitySelect())
		.from(authzActivityLog)
		.leftJoin(user, eq(authzActivityLog.actor_id, user.id))
		.where(eq(authzActivityLog.org_id, actor.orgId))
		.orderBy(desc(authzActivityLog.id))
		.limit(EXPORT_LIMIT);

	const header = [
		"time",
		"actor",
		"action",
		"resource_type",
		"resource_id",
		"decision",
		"reason",
	].join(",");
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
}
