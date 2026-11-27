// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff side of the complimentary Early Access requests (EA-3, #7325): the minimal drizzle
// declaration of the console-owned `early_access_request` table, and the reads the page makes.
//
// The console owns the table and its migrations (apps/console/lib/db/schema/early-access.ts); only
// the columns read or written here are declared, mirroring the physical schema. This app holds only
// the service (RLS-bypass) connection, which is what the table's policies require for every staff
// decision: the app role cannot UPDATE a request at all.

import { desc, eq } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { getServiceDb } from "@/lib/db";
import { organization } from "@repo/platform/console-refs";

/** The plans a grant can be asked for (console: EARLY_ACCESS_PLANS). */
export const EARLY_ACCESS_PLANS = ["team", "ai_plus", "ai_max"] as const;
export type EarlyAccessPlan = (typeof EARLY_ACCESS_PLANS)[number];

/** A request's lifecycle (console: EARLY_ACCESS_REQUEST_STATUSES). */
export const EARLY_ACCESS_STATUSES = ["open", "granted", "declined", "converted"] as const;
export type EarlyAccessStatus = (typeof EARLY_ACCESS_STATUSES)[number];

export const earlyAccessRequest = pgTable("early_access_request", {
	id: uuid().primaryKey(),
	organizationId: uuid().notNull(),
	country: text().notNull(),
	vatId: text().notNull(),
	planWanted: text().$type<EarlyAccessPlan>().notNull(),
	status: text().$type<EarlyAccessStatus>().notNull(),
	requesterNote: text(),
	viesValid: boolean(),
	viesName: text(),
	viesAddress: text(),
	viesRequestId: text(),
	viesCheckedAt: timestamp({ withTimezone: true }),
	decidedByEmail: text(),
	decidedAt: timestamp({ withTimezone: true }),
	decisionReason: text(),
	createdAt: timestamp({ withTimezone: true }).notNull(),
	updatedAt: timestamp({ withTimezone: true }).notNull(),
});

/** What VIES said about a request's number; `unchecked` when it was not asked successfully. */
export type ViesVerdict = "valid" | "invalid" | "unchecked";

/** One request as the staff page shows it. */
export interface EarlyAccessRow {
	id: string;
	organizationId: string;
	orgName: string | null;
	orgSlug: string | null;
	country: string;
	vatId: string;
	plan: EarlyAccessPlan;
	status: EarlyAccessStatus;
	note: string | null;
	vies: ViesVerdict;
	viesName: string | null;
	viesAddress: string | null;
	viesRequestId: string | null;
	decidedByEmail: string | null;
	decidedAt: Date | null;
	decisionReason: string | null;
	createdAt: Date;
}

/** The verdict of a stored row (console: viesVerdictOf). */
function verdict(valid: boolean | null, checkedAt: Date | null): ViesVerdict {
	if (!checkedAt || valid === null) return "unchecked";
	return valid ? "valid" : "invalid";
}

/** Every request, newest first (bounded), with its organization's name and slug. */
export async function listEarlyAccessRequests(limit = 200): Promise<EarlyAccessRow[]> {
	const rows = await getServiceDb()
		.select({
			r: earlyAccessRequest,
			orgName: organization.name,
			orgSlug: organization.slug,
		})
		.from(earlyAccessRequest)
		.leftJoin(organization, eq(organization.id, earlyAccessRequest.organizationId))
		.orderBy(desc(earlyAccessRequest.createdAt))
		.limit(limit);
	return rows.map(({ r, orgName, orgSlug }) => ({
		id: r.id,
		organizationId: r.organizationId,
		orgName,
		orgSlug,
		country: r.country,
		vatId: r.vatId,
		plan: r.planWanted,
		status: r.status,
		note: r.requesterNote,
		vies: verdict(r.viesValid, r.viesCheckedAt),
		viesName: r.viesName,
		viesAddress: r.viesAddress,
		viesRequestId: r.viesRequestId,
		decidedByEmail: r.decidedByEmail,
		decidedAt: r.decidedAt,
		decisionReason: r.decisionReason,
		createdAt: r.createdAt,
	}));
}
