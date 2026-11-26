// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `paddle_transaction` mirror backfill: reads the account's billed, paid, past-due and completed
// transactions from Paddle's list API and feeds each through `applyBillingEvent` as a mirror-only
// event (lib/billing/paddle/events.ts `transactionReadEvent`). It closes the two ways the
// webhook-fed mirror can be incomplete (#7672): transactions from before the notification
// destination existed, and transactions whose webhook could not be tied to an org at the time (the
// operator was alerted; once the org's record exists, a run picks them up).
//
// Nothing here decides anything. Every transaction goes through the same rules as a webhook — the
// org resolution, the record check and the watermark in ./apply.ts — so a run can only write what a
// webhook could have written, and running it twice converges to the same rows. Read-only towards
// Paddle (`GET /transactions` only).
//
// It runs daily in the reconcile loop (lib/reconcile/loop.ts) once ALETHIA_PADDLE_TRANSACTION_BACKFILL=1
// and Paddle is configured, so a transaction that becomes attributable later (the org's Paddle
// customer was stored by hand) is mirrored without anyone remembering to run anything. Its refusals
// are logged, not paged: each was paged once already, by the webhook that was refused. Server-only.

import { z } from "zod";
import { type PaddleClient, paddleClient } from "@/lib/billing/paddle/api";
import { isPaddleConfigured } from "@/lib/billing/paddle/config";
import { PaddlePayloadError, transactionReadEvent } from "@/lib/billing/paddle/events";
import type { NormalizedBillingEvent } from "@/lib/billing/provider/types";
import { log } from "@/lib/observability/log";
import { type ApplyResult, applyBillingEvent, RetryableBillingEventError } from "./apply";
import { postgresBillingEventStore } from "./store";

/** The env flag that turns the daily backfill on. Anything but `1`/`true` leaves it off. */
export const PADDLE_TRANSACTION_BACKFILL_ENV = "ALETHIA_PADDLE_TRANSACTION_BACKFILL";

/** Whether the daily backfill is switched on for this instance. */
export function paddleTransactionBackfillEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const v = env[PADDLE_TRANSACTION_BACKFILL_ENV]?.trim().toLowerCase();
	return (v === "1" || v === "true") && isPaddleConfigured(env);
}

/** The statuses the backfill reads: every status the mirror lists or follows. */
export const BACKFILL_STATUSES = ["billed", "paid", "past_due", "completed"] as const;

/** Paddle's page size for `GET /transactions` (its maximum). */
export const BACKFILL_PAGE_SIZE = 30;

/** The default stop on pages read in one run (6000 transactions). */
export const BACKFILL_DEFAULT_MAX_PAGES = 200;

/** What one transaction came to. `deferred` = the rules asked for it later (a retryable refusal). */
export type BackfillOutcome = ApplyResult["outcome"] | "deferred" | "unreadable";

/** One transaction's line in the report: its id and what happened — never customer data. */
export interface BackfillLine {
	transactionId: string;
	outcome: BackfillOutcome;
	reason: string | null;
}

/** What a run did. `truncated` when it stopped at `maxPages` with more pages left. */
export interface BackfillReport {
	pages: number;
	truncated: boolean;
	lines: BackfillLine[];
	counts: { readonly [O in BackfillOutcome]: number };
}

/** What the backfill needs: a Paddle client and the apply step (the real one, or a dry-run one). */
export interface BackfillDeps {
	client: PaddleClient;
	apply: (event: NormalizedBillingEvent) => Promise<ApplyResult>;
}

const idOnly = z.looseObject({ id: z.string().startsWith("txn_") });

/** Applies one listed transaction and says what came of it. Throws only for a non-rule failure. */
async function backfillOne(raw: unknown, deps: BackfillDeps): Promise<BackfillLine> {
	const id = idOnly.safeParse(raw);
	const transactionId = id.success ? id.data.id : "(no id)";
	let event: NormalizedBillingEvent;
	try {
		event = transactionReadEvent(raw);
	} catch (err) {
		if (err instanceof PaddlePayloadError) return { transactionId, outcome: "unreadable", reason: err.message };
		throw err;
	}
	try {
		const result = await deps.apply(event);
		return { transactionId, outcome: result.outcome, reason: result.reason ?? null };
	} catch (err) {
		if (err instanceof RetryableBillingEventError) return { transactionId, outcome: "deferred", reason: err.message };
		throw err;
	}
}

/**
 * Pages through the account's transactions oldest first and applies each. Stops after `maxPages`
 * (reported as `truncated`; a second run with a larger cap continues from the start and converges).
 * Throws `PaddleApiError` when Paddle cannot be read, and any database failure the apply step throws.
 */
export async function backfillPaddleTransactions(
	deps: BackfillDeps,
	opts: { maxPages?: number } = {},
): Promise<BackfillReport> {
	const maxPages = Math.max(1, Math.floor(opts.maxPages ?? BACKFILL_DEFAULT_MAX_PAGES));
	const lines: BackfillLine[] = [];
	let after: string | undefined;
	let pages = 0;
	let truncated = false;
	for (;;) {
		if (pages >= maxPages) {
			truncated = true;
			break;
		}
		const page = await deps.client.request(
			{
				method: "GET",
				path: "/transactions",
				query: {
					status: BACKFILL_STATUSES.join(","),
					order_by: "id[ASC]",
					per_page: BACKFILL_PAGE_SIZE,
					after,
				},
			},
			z.array(z.unknown()),
		);
		pages++;
		for (const raw of page) lines.push(await backfillOne(raw, deps));
		const last = page.at(-1);
		const lastId = last === undefined ? null : idOnly.safeParse(last);
		if (!lastId?.success || page.length < BACKFILL_PAGE_SIZE) break;
		after = lastId.data.id;
	}
	const counts: Record<BackfillOutcome, number> = {
		applied: 0,
		ignored: 0,
		refused: 0,
		deferred: 0,
		unreadable: 0,
	};
	for (const line of lines) counts[line.outcome]++;
	return { pages, truncated, lines, counts };
}

/**
 * One backfill pass against this instance's Paddle account and database, for the reconcile loop.
 * Logs a summary, and one line per transaction that was not applied; returns the counts.
 */
export async function runPaddleTransactionBackfill(): Promise<BackfillReport["counts"]> {
	const report = await backfillPaddleTransactions({
		client: paddleClient(),
		apply: (event) =>
			applyBillingEvent(event, {
				store: postgresBillingEventStore,
				alert: async (a) => {
					log.warn("[paddle] transaction backfill: not applied", { title: a.title, subject_id: a.subject.id });
				},
				warn: (message, fields) => log.warn(message, fields),
			}),
	});
	for (const line of report.lines) {
		if (line.outcome === "applied" || line.outcome === "ignored") continue;
		log.warn("[paddle] transaction backfill line", {
			transaction_id: line.transactionId,
			outcome: line.outcome,
			reason: line.reason,
		});
	}
	log.info("[paddle] transaction backfill pass", { pages: report.pages, truncated: report.truncated, ...report.counts });
	return report.counts;
}
