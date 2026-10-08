// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reports managed-runner job-minutes to the Stripe billing meter. Stripe meter events
// are ADDITIVE and the metered Price is GRADUATED (free tier = the plan's included
// minutes, then $0.012/min), so Stripe applies included-then-overage itself — we just
// report each job's minutes once. Hosted-only + best-effort: a metering failure must
// never block a job's status update.
//
// Never double-report is enforced in TWO places, and neither is enough alone:
//  1. jobs.usage_reported_at — a claim, so two concurrent requests cannot both send.
//  2. the meter event's `identifier` — derived from the job and the meter, so it is the
//     SAME on every attempt. The claim is released when the Stripe call throws, and a
//     throw does not mean Stripe did not record the event: an accepted event whose reply
//     was lost (socket timeout, reset, 5xx after commit) throws too. The retry then sends
//     the same identifier, and Stripe deduplicates it. The SDK's automatic idempotency key
//     covers only the SDK's own retries of one call, never a later call of ours (#5746).
//
// Stripe's documented limit (API reference, "Create a billing meter event", `identifier`;
// the same text is in stripe-node 22.6.1's Billing.MeterEventCreateParams): "Stripe
// enforces uniqueness within a rolling period of at least 24 hours". So a retry that
// arrives MORE than 24h after an accepted-but-unacknowledged attempt is not guaranteed to
// be deduplicated. Nothing schedules a retry here: the only retry is a later call of
// reportJobUsageOnce for the same job (a re-posted terminal status or mint result), and
// no alert covers a retry past that window — the "usage metering failed" error log at the
// call sites is the only signal.

import { and, eq, isNull } from "drizzle-orm";
import { isStripeConfigured, RUNNER_MINUTES_METER_EVENT } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { jobs, organizationBilling, runners } from "@/lib/db/schema";

/**
 * The meter event identifier for one job's runner-minutes: stable per job and per meter,
 * so every attempt to report the same job sends the same identifier and Stripe
 * deduplicates the repeats. Stripe caps an identifier at 100 characters; a job id is a
 * UUID, so this is 63.
 */
export function runnerMinutesMeterIdentifier(jobId: string): string {
	return `${RUNNER_MINUTES_METER_EVENT}-job-${jobId}`;
}

/**
 * Reports `minutes` of runner usage by job `jobId` for a Stripe customer, under the job's
 * stable meter identifier. No-op when billing isn't wired, the customer is missing, or
 * minutes ≤ 0. Returns whether an event was sent.
 */
export async function reportRunnerMinutes(
	jobId: string,
	stripeCustomerId: string | null | undefined,
	minutes: number,
): Promise<boolean> {
	if (!isStripeConfigured() || !stripeCustomerId || minutes <= 0) return false;
	await getStripe().billing.meterEvents.create({
		event_name: RUNNER_MINUTES_METER_EVENT,
		identifier: runnerMinutesMeterIdentifier(jobId),
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
 * can re-report. The rollback is still needed — without it, an event Stripe genuinely
 * rejected would never be billed — and it is safe within Stripe's ≥24h dedupe window
 * because the retry carries the same identifier (see the header comment). No-op for self-operated runners, already-reported jobs, or when
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
		await reportRunnerMinutes(jobId, row.customerId, minutes);
	} catch (err) {
		// Release the claim so a later retry can re-report. Safe against double billing
		// only because the retry sends the same identifier — see the header comment.
		await db
			.update(jobs)
			.set({ usage_reported_at: null })
			.where(eq(jobs.id, jobId));
		throw err;
	}
}
