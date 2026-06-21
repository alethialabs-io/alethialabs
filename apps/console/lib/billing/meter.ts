// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reports managed-runner job-minutes to the Stripe billing meter. Stripe meter events
// are ADDITIVE and the metered Price is GRADUATED (free tier = the plan's included
// minutes, then $0.012/min), so Stripe applies included-then-overage itself — we just
// report each job's minutes once. Hosted-only + best-effort: a metering failure must
// never block a job's status update. Idempotency (never double-report) is enforced by
// the caller via jobs.usage_reported_at.

import { and, eq, isNull } from "drizzle-orm";
import { isStripeConfigured, RUNNER_MINUTES_METER_EVENT } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { jobs, organizationBilling, runners } from "@/lib/db/schema";

/**
 * Reports `minutes` of runner usage for a Stripe customer. No-op when billing isn't
 * wired, the customer is missing, or minutes ≤ 0. Returns whether an event was sent.
 */
export async function reportRunnerMinutes(
	stripeCustomerId: string | null | undefined,
	minutes: number,
): Promise<boolean> {
	if (!isStripeConfigured() || !stripeCustomerId || minutes <= 0) return false;
	await getStripe().billing.meterEvents.create({
		event_name: RUNNER_MINUTES_METER_EVENT,
		payload: {
			// Stripe sums string values per period; round to whole minutes.
			value: String(Math.round(minutes)),
			stripe_customer_id: stripeCustomerId,
		},
	});
	return true;
}

/**
 * Reports a terminal job's managed-runner minutes to the billing meter exactly once.
 * Idempotent: claims the report by setting `jobs.usage_reported_at` first (only the
 * winner proceeds), and rolls the watermark back if the Stripe call fails so a retry
 * can re-report. No-op for self-operated runners, already-reported jobs, or when
 * billing isn't wired. Best-effort — callers should not fail the status update on error.
 */
export async function reportJobUsageOnce(jobId: string): Promise<void> {
	if (!isStripeConfigured()) return;
	const db = getServiceDb();

	const [row] = await db
		.select({
			operator: runners.operator,
			startedAt: jobs.started_at,
			completedAt: jobs.completed_at,
			reportedAt: jobs.usage_reported_at,
			customerId: organizationBilling.stripeCustomerId,
		})
		.from(jobs)
		.leftJoin(runners, eq(runners.id, jobs.runner_id))
		.leftJoin(
			organizationBilling,
			eq(organizationBilling.organizationId, jobs.org_id),
		)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!row || row.operator !== "managed" || row.reportedAt) return;
	if (!row.startedAt || !row.completedAt) return;
	const minutes = (row.completedAt.getTime() - row.startedAt.getTime()) / 60_000;
	if (minutes <= 0) return;

	// Claim the report (idempotency): only the request that flips the watermark sends.
	const claimed = await db
		.update(jobs)
		.set({ usage_reported_at: new Date() })
		.where(and(eq(jobs.id, jobId), isNull(jobs.usage_reported_at)))
		.returning({ id: jobs.id });
	if (claimed.length === 0) return; // already reported by a concurrent request

	try {
		await reportRunnerMinutes(row.customerId, minutes);
	} catch (err) {
		// Release the claim so a later retry can re-report.
		await db
			.update(jobs)
			.set({ usage_reported_at: null })
			.where(eq(jobs.id, jobId));
		throw err;
	}
}
