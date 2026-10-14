// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The operator's exit for a paid create-a-team setup no reader can close (ADR 0002 §5.4 "The setup
// command", §5.7; #5714).
//
// An OPEN setup (`linked_at IS NULL AND closed_at IS NULL`) blocks its organization's plan purchases
// (the open-setup guard in app/server/actions/billing.ts). The setup closer ends every setup whose
// subscription reads ended, and adopts one already linked in Stripe. Two states have no automatic exit:
// a live subscription whose creator never comes back, and a subscription Stripe cannot find. For those
// support decides — and runs this.
//
// Usage:
//   pnpm -C apps/console billing:pending-org-setups close-setup <subscription_id> \
//     --reason "<why>" --operator <your user id>
//
// It refuses with no reason (or no operator). It reads the subscription from Stripe and prints it with
// the setup row. It closes only when the subscription reads ended (`canceled`, `incomplete_expired`)
// or Stripe answers `resource_missing` — it then prints "not found in this Stripe account", so a wrong
// key is visible before anything is closed. A live or `incomplete` subscription is refused: cancel it
// in Stripe first (refunding it when it was paid), because closing the setup of a live one would hide it
// from every reader. Any other read failure refuses and writes nothing.
//
// It also refuses while an OPEN payment hold names the subscription (ADR 0002 I16, C92): that hold is
// watching the money, and its release decides the setup. `payment-holds release` is the way out then.
//
// The write is a compare-and-set on `closed_at IS NULL AND linked_at IS NULL` and on no open hold in the
// same statement, run under the same lock as the console's closer (#6052): `payment_holds` in SHARE mode,
// so a hold being opened at that moment is either committed and seen, or waits for the close. When the
// lock is not free within 2s it refuses and writes nothing; run it again. Only when it returned
// the row is the audit event `billing.pending_org_setup.closed` written — a structured log line with
// that stable name (the console has no billing audit table; the durable record is the row's
// `closed_by` and `closed_note`). A second run matches nothing and emits nothing.
//
// Reads ALETHIA_DATABASE_URL (the SERVICE connection) and STRIPE_SECRET_KEY, the same environment the
// console runs with. Exit codes: 0 — closed, or already not open; 1 — refused, or it could not run.

import { fileURLToPath } from "node:url";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { pgErrorCode } from "@/lib/db/pg-error";
import { paymentHolds, pendingOrgSetups } from "@/lib/db/schema";

// This file reads and writes `pending_org_setups` itself rather than through
// lib/billing/pending-org-setup.ts: that module is `server-only`, which nothing resolves outside the
// Next.js server bundle, so a `tsx` script cannot import it. The write below repeats its
// `closePendingOrgSetup` step for step: the 2s `lock_timeout`, the committed-hold fast path, the SHARE
// lock on `payment_holds`, then the compare-and-set.

/** Subscription statuses under which Stripe will never collect a payment for it again. */
const ENDED: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/** One `pending_org_setups` row. */
type SetupRow = typeof pendingOrgSetups.$inferSelect;

/** The record of `subscriptionId`, whoever's it is (the operator has no session). */
async function setupBySubscription(subscriptionId: string): Promise<SetupRow | null> {
	const [row] = await getServiceDb()
		.select()
		.from(pendingOrgSetups)
		.where(eq(pendingOrgSetups.subscription_id, subscriptionId))
		.limit(1);
	return row ?? null;
}

/**
 * Closes the setup if it is still open and no payment hold on it is — one compare-and-set, under the
 * SHARE lock on `payment_holds` that makes it atomic against a hold being opened (#6052) — and returns
 * it, else null. Returns null without locking when a committed open hold is already visible. Throws
 * (SQLSTATE 55P03) with nothing written when the lock is not free within `HOLD_LOCK_WAIT`.
 */
async function closeOpenSetup(subscriptionId: string, operator: string, note: string): Promise<SetupRow | null> {
	const now = new Date();
	return getServiceDb().transaction(async (tx) => {
		await tx.execute(sql`SELECT set_config('lock_timeout', ${HOLD_LOCK_WAIT}, true)`);
		const held = await tx.execute(
			sql`SELECT 1 FROM payment_holds WHERE subscription_id = ${subscriptionId} AND state <> 'released' LIMIT 1`,
		);
		if (held.length > 0) return null;
		await tx.execute(sql`LOCK TABLE payment_holds IN SHARE MODE`);
		const [closed] = await tx
			.update(pendingOrgSetups)
			.set({ closed_at: now, closed_reason: "operator", closed_by: operator, closed_note: note, updated_at: now })
			.where(
				and(
					eq(pendingOrgSetups.subscription_id, subscriptionId),
					isNull(pendingOrgSetups.closed_at),
					isNull(pendingOrgSetups.linked_at),
					sql`NOT EXISTS (SELECT 1 FROM payment_holds h WHERE h.subscription_id = ${subscriptionId} AND h.state <> 'released')`,
				),
			)
			.returning();
		return closed ?? null;
	});
}

/** How long the close waits for its lock on `payment_holds` (the console closer's value). */
const HOLD_LOCK_WAIT = "2s";

/** SQLSTATE `lock_not_available`: `lock_timeout` elapsed while waiting for the lock. */
const LOCK_NOT_AVAILABLE = "55P03";

/** The state of the open payment hold on `subscriptionId`, or null when none is open. */
async function openHoldState(subscriptionId: string): Promise<string | null> {
	const [hold] = await getServiceDb()
		.select({ state: paymentHolds.state })
		.from(paymentHolds)
		.where(and(eq(paymentHolds.subscription_id, subscriptionId), ne(paymentHolds.state, "released")))
		.limit(1);
	return hold?.state ?? null;
}

/** True for Stripe's "No such subscription" error — the id names nothing in this account. */
function isResourceMissing(e: unknown): boolean {
	return typeof e === "object" && e !== null && Reflect.get(e, "code") === "resource_missing";
}

/** What `closeSetup` did. */
export type CloseSetupResult =
	| { kind: "closed"; xRead: "ended" | "resource_missing" }
	| { kind: "not_open" }
	| { kind: "refused"; reason: string };

/**
 * `close-setup`: closes the open setup of `subscriptionId` for an operator, under the rules in the
 * header. `print` receives every line meant for the operator.
 */
export async function closeSetup(
	input: { subscriptionId: string; reason: string | undefined; operator: string | undefined },
	print: (line: string) => void,
): Promise<CloseSetupResult> {
	const reason = input.reason?.trim() ?? "";
	const operator = input.operator?.trim() ?? "";
	if (!reason) return refuse(print, "--reason is required: say why this setup is being closed.");
	if (!operator) return refuse(print, "--operator is required: your user id, recorded as closed_by.");

	const row = await setupBySubscription(input.subscriptionId);
	if (!row) return refuse(print, `No setup record names ${input.subscriptionId}.`);
	print(
		`Setup ${row.id}: subscription ${row.subscription_id}, user ${row.user_id}, org ${row.created_org_id ?? "none"}, ` +
			`created ${row.created_at.toISOString()}, linked ${row.linked_at?.toISOString() ?? "no"}, ` +
			`closed ${row.closed_at?.toISOString() ?? "no"}`,
	);

	let sub: Stripe.Subscription | null = null;
	try {
		sub = await getStripe().subscriptions.retrieve(input.subscriptionId);
	} catch (e) {
		if (!isResourceMissing(e)) {
			const message = e instanceof Error ? e.message : String(e);
			return refuse(print, `Could not read ${input.subscriptionId} from Stripe (${message}); nothing was written.`);
		}
	}
	let xRead: "ended" | "resource_missing";
	if (sub === null) {
		print(`${input.subscriptionId} not found in this Stripe account. Check the key before you close it.`);
		xRead = "resource_missing";
	} else {
		print(`Stripe: ${sub.id} is ${sub.status}, metadata ${JSON.stringify(sub.metadata ?? {})}`);
		if (!ENDED.has(sub.status)) {
			return refuse(
				print,
				`${sub.id} is ${sub.status}, not ended. Cancel it in Stripe first (refund it if it was paid); closing the setup of a live subscription would hide it.`,
			);
		}
		xRead = "ended";
	}

	let closed: SetupRow | null;
	try {
		closed = await closeOpenSetup(input.subscriptionId, operator, reason);
	} catch (e) {
		if (pgErrorCode(e) !== LOCK_NOT_AVAILABLE) throw e;
		return refuse(print, "Payment holds are being written right now (the lock was not free within 2s); nothing was written. Run it again.");
	}
	if (!closed) {
		const held = await openHoldState(input.subscriptionId);
		if (held) {
			return refuse(
				print,
				`An open payment hold (${held}) names ${input.subscriptionId}; its release decides this setup. Use "billing:payment-holds show" and "release" instead.`,
			);
		}
		print("The setup is not open (already closed or linked); nothing was changed.");
		return { kind: "not_open" };
	}
	// The audit event: one structured line with a stable name (lib/billing/pending-org-setup.ts's
	// `logBillingEvent` shape).
	console.info(
		JSON.stringify({
			event: "billing.pending_org_setup.closed",
			subscription_id: closed.subscription_id,
			user_id: closed.user_id,
			org_id: closed.created_org_id,
			closed_reason: "operator",
			operator,
			reason,
			x_read: xRead,
		}),
	);
	print(`Closed the setup of ${closed.subscription_id}.`);
	return { kind: "closed", xRead };
}

/** Prints a refusal and returns it. */
function refuse(print: (line: string) => void, reason: string): CloseSetupResult {
	print(`Refused: ${reason}`);
	return { kind: "refused", reason };
}

/** Returns the value of `--name <v>` / `--name=<v>` from `argv`, or undefined. */
function arg(argv: readonly string[], name: string): string | undefined {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = argv.indexOf(`--${name}`);
	return idx !== -1 ? argv[idx + 1] : undefined;
}

/** CLI entry: runs one command and sets the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
	const [command, subscriptionId] = argv;
	if (command !== "close-setup" || !subscriptionId || subscriptionId.startsWith("--")) {
		console.error(
			'Usage: billing:pending-org-setups close-setup <subscription_id> --reason "<why>" --operator <user id>',
		);
		return 1;
	}
	try {
		const result = await closeSetup(
			{ subscriptionId, reason: arg(argv, "reason"), operator: arg(argv, "operator") },
			(line) => console.log(line),
		);
		return result.kind === "refused" ? 1 : 0;
	} catch (err) {
		console.error("close-setup failed:", err);
		return 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	// Exits explicitly: the database pool would otherwise keep the process alive.
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
