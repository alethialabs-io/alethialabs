// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Puts the shared `setup` persona's org on an AI tier for the real-model journeys, so the advisor
// the product routes to is the one the run means to exercise (lib/config/ai.ts `getAdvisorModel`):
// ai_plus → the Plus advisor plans step 0; ai_max → the same, upgrading to the Max advisor on the
// deep-reasoning opt-in. The tier comes from `AI_SOAK_TIER` (set per leg by the soak jobs in e2e-ai-nightly.yml) and
// defaults to `ai_plus`.
//
// Why a paid tier by default, even in the nightly: the free tier's session allowance is about
// USD 0.13 per rolling five hours (lib/billing/ai-plan.ts `AI_TIERS.ai_free`), and a dozen real
// turns from one persona cross it — every later journey would then assert against the budget card
// instead of the feature. The nightly pins the Plus advisor to Haiku, so this costs it nothing more.
//
// The row written is exactly what an operator-plane grant writes (`setOrgPlan` with an AI tier, EA-3
// #7325): `ai_tier` + `ai_subscription_status = 'active'`, no provider subscription id, and no term
// end — `billingAiTier` reads that as an open-ended grant, never lapsed.

import type { Page } from "@playwright/test";
import { db } from "./db";

/** The AI tiers a soak leg can seed (mirrors `AiTier` in lib/billing/ai-plan.ts). */
export type SoakTier = "ai_free" | "ai_plus" | "ai_max";

/**
 * Whether the console under test is the COMMUNITY edition. There the tenancy collapses to the
 * person: `getActiveScope` answers `{ orgId: userId }` whatever org the URL names
 * (lib/auth/scope.ts), so every row the app reads is scoped by `org_id = <user id>`, and there is
 * no AI tier to grant — `organization_billing.organization_id` must name a real organization, and
 * the personal scope is not one. The nightly runs community; the soak runs enterprise.
 */
export function isCommunityEdition(): boolean {
	return process.env.ALETHIA_EDITION === "community";
}

/** The tier this run seeds: `AI_SOAK_TIER` when it names a tier, otherwise `ai_plus`. */
export function soakTier(): SoakTier {
	const raw = process.env.AI_SOAK_TIER;
	if (raw === "ai_free" || raw === "ai_plus" || raw === "ai_max") return raw;
	return "ai_plus";
}

/**
 * The org slug the authenticated persona lands on. The console redirects `/` to the active org's
 * home (`/<org>`), so the first path segment once the topbar's "Ask AI" control renders is the slug.
 */
export async function personaOrgSlug(page: Page): Promise<string> {
	await page.goto("/");
	await page.getByRole("button", { name: "Ask AI" }).waitFor({ timeout: 30_000 });
	const slug = new URL(page.url()).pathname.split("/")[1];
	if (!slug) throw new Error(`could not read the persona's org slug from ${page.url()}`);
	return slug;
}

/**
 * Seed the persona org's AI tier (upsert on `organization_billing.organization_id`). Idempotent, so
 * every spec file may call it in `beforeAll` without coordinating with the others.
 */
export async function seedAiTier(orgSlug: string, tier: SoakTier = soakTier()): Promise<void> {
	// Community has no tiers to grant (see isCommunityEdition): the turn reads the personal scope's
	// billing, which no row can name, so it is always ai_free there — and unmetered without billing.
	if (isCommunityEdition()) return;
	const sql = db();
	const rows = await sql<{ id: string }[]>`select id from organization where slug = ${orgSlug} limit 1`;
	const orgId = rows[0]?.id;
	if (!orgId) throw new Error(`no organization with slug ${orgSlug}`);
	await sql`
		insert into organization_billing (organization_id, ai_tier, ai_subscription_status)
		values (${orgId}, ${tier}, ${tier === "ai_free" ? "none" : "active"})
		on conflict (organization_id) do update
			set ai_tier = excluded.ai_tier, ai_subscription_status = excluded.ai_subscription_status,
				updated_at = now()`;
}

/**
 * The scope seeded rows (seed.ts `Owner`) must carry for the console to read them back: the
 * persona's user id, and the org id the app's actor resolves to — the named organization in the
 * enterprise edition, the user id itself in community (see isCommunityEdition). Seeding the
 * organization's id under community wrote rows no page could see (measured on the first live run:
 * the overview showed "No projects yet" and `list_projects` returned none).
 */
export async function personaOwner(orgSlug: string): Promise<{ orgId: string; userId: string }> {
	const rows = await db()<{ orgId: string; userId: string }[]>`
		select o.id as "orgId", m.user_id as "userId"
		from organization o join member m on m.organization_id = o.id
		where o.slug = ${orgSlug} and m.role = 'owner'
		order by m.created_at limit 1`;
	const row = rows[0];
	if (!row) throw new Error(`no owner found for organization ${orgSlug}`);
	return isCommunityEdition() ? { orgId: row.userId, userId: row.userId } : row;
}

/** One ledger aggregate per model that served this org (ai_usage_ledger, settled rows only). */
export interface LedgerModelRow {
	model: string | null;
	rows: number;
	costMicros: number;
}

/** The settled AI usage of an org, grouped by the model that served it. */
export async function ledgerByModel(orgId: string): Promise<LedgerModelRow[]> {
	return db()<LedgerModelRow[]>`
		select model, count(*)::int as rows, coalesce(sum(cost_micros), 0)::bigint::float8 as "costMicros"
		from ai_usage_ledger
		where org_id = ${orgId} and settled_at is not null
		group by model`;
}

/** Holds still outstanding for an org — reservations no turn has reconciled (#2683). */
export async function outstandingHolds(orgId: string): Promise<number> {
	const rows = await db()<{ n: number }[]>`
		select count(*)::int as n from ai_usage_ledger where org_id = ${orgId} and settled_at is null`;
	return rows[0]?.n ?? 0;
}
