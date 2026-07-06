// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed reads/writes for the per-org billing record. The billing table is a
// tenancy-control concern (it decides entitlements), so it is queried via the
// service connection (bypasses RLS) and the org boundary is enforced by the caller
// passing the resolved actor.orgId — never user input.

import { and, eq, isNull } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	organizationBilling,
	type OrganizationBilling,
	type OrganizationBillingInsert,
} from "@/lib/db/schema";
import type { Entitlements } from "@/lib/authz/types";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { COMMUNITY_ENTITLEMENTS, resolvePlanEntitlements } from "./plan";

/** Returns an org's billing record, or null if it has none (→ implicitly community). */
export async function getOrgBilling(
	orgId: string,
): Promise<OrganizationBilling | null> {
	const [row] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row ?? null;
}

/**
 * Resolves an org's entitlements from its billing record: the plan's grant when the
 * subscription is live, the community baseline if there's no row or it's inactive.
 * This is the per-org resolution the ee/ entitlements seam delegates to (replacing
 * the global ALETHIA_LICENSE_ACTIVE env flag).
 */
export async function resolveOrgEntitlements(
	orgId: string,
): Promise<Entitlements> {
	const billing = await getOrgBilling(orgId);
	if (!billing) return COMMUNITY_ENTITLEMENTS;
	return resolvePlanEntitlements(billing.plan, billing.status);
}

/** Fields the Stripe webhook writes onto an org's billing record. */
export interface BillingUpsert {
	organizationId: string;
	plan: BillingPlan;
	status: BillingStatus;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
	seats?: number | null;
	currentPeriodEnd?: Date | null;
}

/**
 * Upserts an org's billing record (one row per org). The single write path for
 * Stripe webhook events — idempotent on organization_id, so replayed events converge
 * to the same state. Entitlements then resolve from the new plan + status on the next
 * request (no cache to invalidate — getActiveScope reads it fresh).
 */
export async function upsertOrgBilling(input: BillingUpsert): Promise<void> {
	const now = new Date();
	const values: OrganizationBillingInsert = {
		organizationId: input.organizationId,
		plan: input.plan,
		status: input.status,
		stripeCustomerId: input.stripeCustomerId ?? null,
		stripeSubscriptionId: input.stripeSubscriptionId ?? null,
		seats: input.seats ?? null,
		currentPeriodEnd: input.currentPeriodEnd ?? null,
		updatedAt: now,
	};
	await getServiceDb()
		.insert(organizationBilling)
		.values(values)
		.onConflictDoUpdate({
			target: organizationBilling.organizationId,
			set: {
				plan: values.plan,
				status: values.status,
				stripeCustomerId: values.stripeCustomerId,
				stripeSubscriptionId: values.stripeSubscriptionId,
				seats: values.seats,
				currentPeriodEnd: values.currentPeriodEnd,
				updatedAt: now,
			},
		});
}

/**
 * Atomically claims the one-time "welcome to your plan" email for an org: sets
 * `welcomed_at` only if it was null, returning true for the single caller that won
 * the claim. Makes the welcome exactly-once across the webhook, the synchronous
 * trial-start path, and Stripe retries — no matter how many `sync` calls race.
 */
export async function claimPlanWelcome(orgId: string): Promise<boolean> {
	const rows = await getServiceDb()
		.update(organizationBilling)
		.set({ welcomedAt: new Date() })
		.where(
			and(
				eq(organizationBilling.organizationId, orgId),
				isNull(organizationBilling.welcomedAt),
			),
		)
		.returning({ id: organizationBilling.id });
	return rows.length > 0;
}

/** Looks up the org a Stripe customer belongs to (set as subscription metadata). */
export async function getOrgByStripeCustomer(
	stripeCustomerId: string,
): Promise<OrganizationBilling | null> {
	const [row] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.stripeCustomerId, stripeCustomerId))
		.limit(1);
	return row ?? null;
}
