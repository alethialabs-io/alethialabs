// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A tiny per-org cache of enabled alert rules. emitAlertEvent runs on EVERY PDP
// decision (the universal action seam), so it must not hit the DB per call: an org
// with no rules returns an empty list from cache and the emit is a no-op. Rules change
// rarely, so a short TTL + explicit invalidation on rule mutation keeps it correct.
// Per-instance (each app instance caches independently); staleness ≤ TTL is fine for
// alerting.

import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { type AlertRule, alertRules } from "@/lib/db/schema";

const TTL_MS = 30_000;

interface Entry {
	rules: AlertRule[];
	loadedAt: number;
}

const globalForRuleCache = globalThis as unknown as {
	__alethiaAlertRuleCache?: Map<string, Entry>;
};
const cache = (globalForRuleCache.__alethiaAlertRuleCache ??= new Map());

/** Enabled rules for an org, cached for TTL_MS. */
export async function getEnabledRules(orgId: string): Promise<AlertRule[]> {
	const hit = cache.get(orgId);
	if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.rules;

	const rules = await getServiceDb()
		.select()
		.from(alertRules)
		.where(and(eq(alertRules.org_id, orgId), eq(alertRules.enabled, true)));
	cache.set(orgId, { rules, loadedAt: Date.now() });
	return rules;
}

/** Drops an org's cached rules — call after any rule create/update/delete/toggle. */
export function invalidateOrgRules(orgId: string): void {
	cache.delete(orgId);
}
