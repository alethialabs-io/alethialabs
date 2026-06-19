"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { authzAuditLog, user } from "@/lib/db/schema";

export interface AuditRow {
	id: string;
	actorId: string;
	actorName: string | null;
	actorEmail: string | null;
	actorImage: string | null;
	action: string;
	resourceType: string;
	resourceId: string | null;
	decision: boolean;
	reason: string | null;
	ts: string;
}

// The audit log is append-only and unbounded; the UI shows the most recent slice
// (the table paginates client-side), and export dumps a larger cap.
const VIEW_LIMIT = 500;
const EXPORT_LIMIT = 10_000;

/** The "select" shape shared by the viewer + export, joined to the acting user. */
function auditSelect() {
	return {
		id: authzAuditLog.id,
		actorId: authzAuditLog.actor_id,
		actorName: user.name,
		actorEmail: user.email,
		actorImage: user.image,
		action: authzAuditLog.action,
		resourceType: authzAuditLog.resource_type,
		resourceId: authzAuditLog.resource_id,
		decision: authzAuditLog.decision,
		reason: authzAuditLog.reason,
		ts: authzAuditLog.ts,
	};
}

/**
 * The active org's access-events log — every denied check + sensitive allow the PDP
 * recorded — newest first. Community-real (the PDP writes it). Scoped by `org_id`.
 */
export async function getAuditLog(): Promise<AuditRow[]> {
	const actor = await currentActor();
	const rows = await getServiceDb()
		.select(auditSelect())
		.from(authzAuditLog)
		.leftJoin(user, eq(authzAuditLog.actor_id, user.id))
		.where(eq(authzAuditLog.org_id, actor.orgId))
		.orderBy(desc(authzAuditLog.ts))
		.limit(VIEW_LIMIT);
	return rows.map((r) => ({ ...r, id: String(r.id), ts: r.ts.toISOString() }));
}

/** Escapes a value as a CSV cell (always quoted, doubled inner quotes). */
function csvCell(value: string | boolean | null): string {
	const s = value === null ? "" : String(value);
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Exports the org's access log as CSV. Enforces the `auditExport` entitlement
 * server-side (not just in the UI) — community/unlicensed callers are rejected.
 */
export async function getAuditExportCsv(): Promise<string> {
	const actor = await currentActor();
	if (!getEntitlements(actor).auditExport) {
		throw new Error("Audit export requires an Enterprise license.");
	}
	const rows = await getServiceDb()
		.select(auditSelect())
		.from(authzAuditLog)
		.leftJoin(user, eq(authzAuditLog.actor_id, user.id))
		.where(eq(authzAuditLog.org_id, actor.orgId))
		.orderBy(desc(authzAuditLog.ts))
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
