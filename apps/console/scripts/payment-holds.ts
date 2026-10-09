// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold operator command (ADR 0002 §5.4 "Commands", §8 "Backfill", Q12; S6 #5783).
//
// Usage (`pnpm -C apps/console billing:payment-holds …`):
//   list [--open] [--payer <user id>]          read-only: the holds, newest first
//   show <subscription_id>                     read-only: its holds, its setup, and the LIVE observation
//   release <subscription_id> --reason "<why>" --operator <your user id>
//                                              T16: releases the subscription's OPEN hold, audited
//   reconcile [--backfill] [--payer <user id>] one sweeper pass now; --backfill first runs the §8 listing
//
// RELEASE (T16). Refuses with no --reason or no --operator. Takes the payer's lease (`user:<payer>`,
// waiting up to 30s, refusing while still busy), prints the live observation, then releases with the
// store's compare-and-set on `version` (`release_reason = operator`, `released_by`, `release_note`). Only
// when that write returned the row is the audit event `billing.payment_hold.released` written — a
// structured log line with that stable name (there is no billing audit table; the durable record is the
// row's `released_by` and `release_note`). A second run finds no open hold and writes nothing.
//   A release closes the hold's OPEN setup in the same transaction (§4.1). Closing the setup of a
// subscription that may still go live would hide it from every reader (I14), so while an open setup names
// the subscription, the release is REFUSED unless Stripe reads it ended or `resource_missing`: cancel it in
// Stripe first (refunding it if it was paid), and the machine settles the hold. From slice 9 a live
// subscription's release runs the link's core instead (§5.6 "When a hold ends").
//
// BACKFILL (§8 B1–B6). The memory-less code before holds kept no record of what it cancelled, so the
// listing has no lower bound: every `canceled` and `incomplete_expired` subscription in the account. A
// subscription is HELD only when every test passes, each read from Stripe:
//   B1 a create-a-team subscription: `metadata.created_by`, and no `metadata.organization_id`;
//   B2 ended by a request: `canceled` with `cancellation_details.reason = cancellation_requested`, or
//      `incomplete_expired`;
//   B3 never renewed or changed: exactly ONE invoice, with `billing_reason = subscription_create`;
//   B4 unpaid when it ended: that invoice is `open`, `uncollectible` or `draft`; or `paid` with
//      `status_transitions.paid_at` after `ended_at`; or it has a PaymentIntent `processing` or
//      `requires_capture`;
//   B5 a card: every PaymentIntent on it used a card (one with no payment method attached and nothing
//      taken counts: nothing was paid by any other method);
//   B6 not a withdrawal: no `commerce_order` names it as `withdrawn` or `refunded`.
// Each hit is opened as a hold (`opened_by = backfill`, `open_note` naming the evidence) under its payer's
// lease and advanced at once; one the machine cannot settle reaches `needs_operator`. Everything else is
// LISTED with the failed test named, and nothing is written for it (Q12: each is a support decision, with
// `show` as the evidence). Safe to re-run: a subscription any hold has ever named — open or released — is
// skipped, so a second run writes nothing for it.
//
// Nothing printed carries an amount, a card, or a customer's email.
//
// Reads ALETHIA_DATABASE_URL (the SERVICE connection) and STRIPE_SECRET_KEY, the same environment the
// console runs with. Exit codes: 0 — done (a release that found nothing open is 0); 1 — refused, or it
// could not run.

import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type Stripe from "stripe";
import { advanceHold, operatorRelease } from "@/lib/billing/payment-holds/machine";
import { type HoldObservation, observeHold } from "@/lib/billing/payment-holds/observe";
import type * as StoreModule from "@/lib/billing/payment-holds/store";
import type * as SweeperModule from "@/lib/billing/payment-holds/sweeper";
import type * as LeaseModule from "@/lib/billing/purchase-lease";
import { getServiceDb } from "@/lib/db";
import { commerceOrder, type PaymentHoldRow, paymentHolds, pendingOrgSetups } from "@/lib/db/schema";

declare module "node:module" {
	/** Node ≥ 22.15's synchronous module hooks (absent from this repo's @types/node). */
	export function registerHooks(hooks: {
		resolve?: (
			specifier: string,
			context: unknown,
			nextResolve: (specifier: string, context: unknown) => { url: string },
		) => { url: string; shortCircuit?: boolean };
	}): unknown;
}

/** The server modules the commands use, loaded by `main` (they import `server-only`). */
export interface ServerDeps {
	store: Pick<typeof StoreModule, "payerLeaseKey" | "openHold">;
	lease: Pick<typeof LeaseModule, "acquirePurchaseLease" | "releasePurchaseLease">;
	sweeper: Pick<typeof SweeperModule, "runPaymentHoldSweep" | "machineDepsFor">;
	/** The sweeper's Stripe client, alert and email sender (`liveSweepDeps()`, or a test's). */
	sweepDeps: SweeperModule.SweepDeps;
}

/** Where every line meant for the operator goes. */
type Print = (line: string) => void;

/** How long `release` and the backfill wait for a payer's lease. */
const LEASE_WAIT_MS = 30_000;

/** One line describing a hold, for `list` and `show`. No amount, card or email. */
function holdLine(h: PaymentHoldRow): string {
	return [
		`hold ${h.id}`,
		`sub ${h.subscription_id}`,
		`payer ${h.payer_key}`,
		`state ${h.state}${h.release_reason ? `(${h.release_reason})` : ""}`,
		`since ${h.state_since.toISOString()}`,
		`last_pay ${h.last_pay ?? "-"}`,
		`next_check ${h.next_check_at?.toISOString() ?? "-"}`,
		`opened_by ${h.opened_by}`,
		`attempts ${h.attempts}`,
		`refund_attempt ${h.refund_attempt}`,
	].join("  ");
}

/** An observation, as the operator reads it: statuses and PaymentIntent ids only. */
function observationLine(obs: HoldObservation | { error: string }): string {
	if ("error" in obs) return `Live observation FAILED: ${obs.error}`;
	const sub = obs.sub.kind === "live" || obs.sub.kind === "other" ? `${obs.sub.kind}(${obs.sub.status})` : obs.sub.kind;
	let pay: string = obs.pay.kind;
	if (obs.pay.kind === "in_flight" || obs.pay.kind === "capturable") pay = `${obs.pay.kind}(${obs.pay.pi})`;
	if (obs.pay.kind === "succeeded") {
		pay = `succeeded(${obs.pay.pis.map((p) => `${p.id}: refund ${p.refund.kind}${p.refund.byThisHold ? ", by this hold" : ""}`).join("; ")})`;
	}
	return `Live observation: subscription ${sub}, held invoice ${obs.inv}, payments ${pay}`;
}

/** `list`: the holds, newest first (at most 500), optionally only the open ones and one payer's. */
export async function listHolds(input: { open: boolean; payer: string | undefined }, print: Print): Promise<number> {
	const rows = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				input.open ? ne(paymentHolds.state, "released") : undefined,
				input.payer ? eq(paymentHolds.payer_key, input.payer) : undefined,
			),
		)
		.orderBy(desc(paymentHolds.created_at))
		.limit(500);
	for (const h of rows) print(holdLine(h));
	print(`${rows.length} hold(s).`);
	return rows.length;
}

/** The setup row of `subscriptionId`, as one line, or a line saying there is none. */
async function setupLine(subscriptionId: string): Promise<string> {
	const [s] = await getServiceDb()
		.select()
		.from(pendingOrgSetups)
		.where(eq(pendingOrgSetups.subscription_id, subscriptionId))
		.limit(1);
	if (!s) return "Setup: none names this subscription.";
	return (
		`Setup ${s.id}: user ${s.user_id}, org ${s.created_org_id ?? "none"}, linked ${s.linked_at?.toISOString() ?? "no"}, ` +
		`closed ${s.closed_at ? `${s.closed_at.toISOString()} (${s.closed_reason ?? "-"})` : "no"}`
	);
}

/** Reads the live observation of `hold`, or the error that stopped it. */
async function observe(hold: PaymentHoldRow, stripe: SweeperModule.HoldStripe): Promise<HoldObservation | { error: string }> {
	try {
		return await observeHold(hold, stripe);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** `show`: every hold of the subscription, its setup, and the live observation of the newest hold. */
export async function showHold(subscriptionId: string, deps: Pick<ServerDeps, "sweepDeps">, print: Print): Promise<void> {
	const rows = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(eq(paymentHolds.subscription_id, subscriptionId))
		.orderBy(desc(paymentHolds.created_at));
	if (rows.length === 0) {
		print(`No hold names ${subscriptionId}.`);
		return;
	}
	for (const h of rows) print(holdLine(h));
	print(await setupLine(subscriptionId));
	const newest = rows[0];
	if (newest) print(observationLine(await observe(newest, deps.sweepDeps.stripe())));
}

/** What `release` did. */
export type ReleaseResult =
	| { kind: "released"; holdId: string }
	| { kind: "not_open" }
	| { kind: "refused"; reason: string };

/** Prints a refusal and returns it. */
function refuse(print: Print, reason: string): { kind: "refused"; reason: string } {
	print(`Refused: ${reason}`);
	return { kind: "refused", reason };
}

/** The open hold of `subscriptionId` (at most one, I6), or null. */
async function openHoldOf(subscriptionId: string): Promise<PaymentHoldRow | null> {
	const [row] = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(and(eq(paymentHolds.subscription_id, subscriptionId), ne(paymentHolds.state, "released")));
	return row ?? null;
}

/** Whether an OPEN setup (neither linked nor closed) names `subscriptionId`. */
async function hasOpenSetup(subscriptionId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: pendingOrgSetups.id })
		.from(pendingOrgSetups)
		.where(
			and(
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.linked_at),
				isNull(pendingOrgSetups.closed_at),
			),
		)
		.limit(1);
	return row !== undefined;
}

/**
 * `release` (T16): releases the open hold of `subscriptionId` for an operator, under the rules in the
 * header. Emits the audit event only when its own compare-and-set released the row.
 */
export async function releaseHoldCommand(
	input: { subscriptionId: string; reason: string | undefined; operator: string | undefined },
	deps: ServerDeps,
	print: Print,
): Promise<ReleaseResult> {
	const reason = input.reason?.trim() ?? "";
	const operator = input.operator?.trim() ?? "";
	if (!reason) return refuse(print, "--reason is required: say why this hold is being released.");
	if (!operator) return refuse(print, "--operator is required: your user id, recorded as released_by.");

	const found = await openHoldOf(input.subscriptionId);
	if (!found) {
		print(`No OPEN hold names ${input.subscriptionId}; nothing was changed.`);
		return { kind: "not_open" };
	}
	const lease = await deps.lease.acquirePurchaseLease(deps.store.payerLeaseKey(found.payer_key), LEASE_WAIT_MS);
	if (!lease) {
		return refuse(print, `the payer's purchase lease is still busy after ${LEASE_WAIT_MS / 1000}s (a purchase or the sweeper holds it); try again.`);
	}
	try {
		// Re-read under the lease: the sweeper may have moved or released it while this waited.
		const hold = await openHoldOf(input.subscriptionId);
		if (!hold) {
			print(`The hold was released while this waited for the lease; nothing was changed.`);
			return { kind: "not_open" };
		}
		print(holdLine(hold));
		print(await setupLine(hold.subscription_id));
		const stripe = deps.sweepDeps.stripe();
		const live = await observe(hold, stripe);
		print(observationLine(live));

		if (!("error" in live) && live.sub.kind === "missing") {
			print(`${hold.subscription_id} not found in this Stripe account. Check the key before you release it.`);
		}
		const settled = !("error" in live) && (live.sub.kind === "ended" || live.sub.kind === "missing");
		if (!settled && (await hasOpenSetup(hold.subscription_id))) {
			const read = "error" in live ? "could not be read" : `reads ${live.sub.kind}`;
			return refuse(
				print,
				`the subscription ${read}, and an open setup names it. Releasing would close that setup and hide a subscription that may still go live. Cancel it in Stripe first (refund it if it was paid); the machine then settles the hold.`,
			);
		}

		const { released } = await operatorRelease(hold, deps.sweeper.machineDepsFor(lease, deps.sweepDeps), {
			operatorId: operator,
			reason,
		});
		if (!released) {
			print("Nothing was written: the hold moved on, or the lease was lost. Run `show` and try again.");
			return { kind: "not_open" };
		}
		// The audit event: one structured line with a stable name, from the caller whose write landed.
		console.info(
			JSON.stringify({
				event: "billing.payment_hold.released",
				hold_id: released.id,
				subscription_id: released.subscription_id,
				from_state: hold.state,
				operator,
				reason,
			}),
		);
		print(`Released hold ${released.id} of ${released.subscription_id} (release_reason operator).`);
		return { kind: "released", holdId: released.id };
	} finally {
		await deps.lease.releasePurchaseLease(lease);
	}
}

/** The Stripe reads the backfill makes beyond the machine's (a structural subset of the SDK). */
export interface BackfillStripe {
	subscriptions: {
		list(params: { status: "canceled" | "incomplete_expired"; limit: number }): AsyncIterable<BackfillSubscription>;
	};
	invoices: {
		list(params: { subscription: string; limit: number }): Promise<{
			has_more: boolean;
			data: ReadonlyArray<{
				id: string;
				status: string | null;
				billing_reason: string | null;
				status_transitions: { paid_at: number | null };
			}>;
		}>;
	};
	invoicePayments: {
		list(params: { invoice: string; limit: number; expand: string[] }): Promise<{
			has_more: boolean;
			data: ReadonlyArray<{
				payment: {
					type: string;
					payment_intent?: string | { id: string; status: string; payment_method: string | { type: string } | null } | null;
				};
			}>;
		}>;
	};
}

/** A subscription as the backfill reads it. */
export interface BackfillSubscription {
	id: string;
	status: string;
	customer: string | { id: string };
	ended_at: number | null;
	metadata: Record<string, string> | null;
	cancellation_details?: { reason: string | null } | null;
}

/** The backfill's verdict on one ended subscription. */
export type BackfillVerdict =
	| { kind: "not_create_a_team" }
	| { kind: "listed"; failed: string }
	| { kind: "hold"; payer: string; customerId: string; invoiceId: string; evidence: string };

/** The PaymentIntent statuses under which nothing was ever taken on it. */
const NOTHING_TAKEN: ReadonlySet<string> = new Set(["requires_payment_method", "canceled"]);

/**
 * B1–B6 (§8) for one subscription Stripe lists as `canceled` or `incomplete_expired`, read from Stripe
 * (and, for B6, `commerce_order`). Holds only on positive evidence that the checkout ended before it
 * was ever paid; any test that fails, or cannot be read, LISTS it.
 */
export async function backfillVerdict(sub: BackfillSubscription, stripe: BackfillStripe): Promise<BackfillVerdict> {
	const payer = sub.metadata?.created_by ?? "";
	if (!payer || sub.metadata?.organization_id) return { kind: "not_create_a_team" };

	const reason = sub.cancellation_details?.reason ?? null;
	if (!(sub.status === "incomplete_expired" || (sub.status === "canceled" && reason === "cancellation_requested"))) {
		return { kind: "listed", failed: `B2: ${sub.status} with cancellation reason ${reason ?? "none"}, not ended by a request` };
	}

	const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 2 });
	const invoice = invoices.data[0];
	if (invoices.has_more || invoices.data.length !== 1 || !invoice) {
		return { kind: "listed", failed: `B3: ${invoices.has_more ? "more than 2" : invoices.data.length} invoices, not exactly one` };
	}
	if (invoice.billing_reason !== "subscription_create") {
		return { kind: "listed", failed: `B3: its one invoice is ${invoice.billing_reason ?? "unknown"}, not subscription_create` };
	}

	const payments =
		invoice.status === "draft"
			? { has_more: false, data: [] }
			: await stripe.invoicePayments.list({
					invoice: invoice.id,
					limit: 100,
					expand: ["data.payment.payment_intent.payment_method"],
				});
	if (payments.has_more) return { kind: "listed", failed: "B5: more payments than one page" };
	const intents: Array<{ id: string; status: string; payment_method: string | { type: string } | null }> = [];
	for (const p of payments.data) {
		const pi = p.payment.payment_intent;
		if (p.payment.type !== "payment_intent" || !pi || typeof pi === "string") {
			return { kind: "listed", failed: "B5: a payment that is not a readable PaymentIntent" };
		}
		intents.push(pi);
	}

	const paidAt = invoice.status_transitions.paid_at;
	const inFlight = intents.find((i) => i.status === "processing" || i.status === "requires_capture");
	let b4: string | null = null;
	if (invoice.status === "open" || invoice.status === "uncollectible" || invoice.status === "draft") {
		b4 = `invoice ${invoice.status}`;
	} else if (invoice.status === "paid" && paidAt !== null && sub.ended_at !== null && paidAt > sub.ended_at) {
		b4 = "invoice paid after the subscription ended";
	} else if (inFlight) {
		b4 = `PaymentIntent ${inFlight.id} ${inFlight.status}`;
	}
	if (b4 === null) {
		return { kind: "listed", failed: `B4: invoice ${invoice.status ?? "unknown"}, not proven unpaid when it ended` };
	}

	for (const i of intents) {
		const pm = i.payment_method;
		const card = pm !== null && typeof pm !== "string" && pm.type === "card";
		const nothingAttached = pm === null && NOTHING_TAKEN.has(i.status);
		if (!card && !nothingAttached) {
			return {
				kind: "listed",
				failed: `B5: PaymentIntent ${i.id} did not use a card (${pm === null ? "no payment method" : typeof pm === "string" ? "unreadable payment method" : pm.type})`,
			};
		}
	}

	const [withdrawn] = await getServiceDb()
		.select({ id: commerceOrder.id })
		.from(commerceOrder)
		.where(and(eq(commerceOrder.stripeSubscriptionId, sub.id), inArray(commerceOrder.state, ["withdrawn", "refunded"])))
		.limit(1);
	if (withdrawn) return { kind: "listed", failed: `B6: commerce order ${withdrawn.id} is withdrawn or refunded` };

	const ended = sub.status === "canceled" ? "canceled(cancellation_requested)" : "incomplete_expired";
	return {
		kind: "hold",
		payer,
		customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
		invoiceId: invoice.id,
		evidence: `backfill: B2 ${ended}; B3 one subscription_create invoice ${invoice.id}; B4 ${b4}; B5 card; B6 no withdrawal`,
	};
}

/** What the backfill did, by count. */
export interface BackfillSummary {
	held: number;
	listed: number;
	alreadyHeld: number;
	notCreateATeam: number;
}

/**
 * `reconcile --backfill`'s listing (§8): every ended subscription in the account through B1–B6. Holds
 * each hit under its payer's lease and advances it at once; lists everything else. Writes nothing for a
 * subscription any hold has ever named, so a re-run is safe.
 */
export async function runBackfill(deps: ServerDeps, stripe: BackfillStripe, print: Print): Promise<BackfillSummary> {
	const summary: BackfillSummary = { held: 0, listed: 0, alreadyHeld: 0, notCreateATeam: 0 };
	for (const status of ["canceled", "incomplete_expired"] as const) {
		for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) {
			let verdict: BackfillVerdict;
			try {
				verdict = await backfillVerdict(sub, stripe);
			} catch (err) {
				summary.listed += 1;
				print(`LISTED ${sub.id}: could not read it (${err instanceof Error ? err.message : String(err)})`);
				continue;
			}
			if (verdict.kind === "not_create_a_team") {
				summary.notCreateATeam += 1;
				continue;
			}
			const [known] = await getServiceDb()
				.select({ id: paymentHolds.id, state: paymentHolds.state })
				.from(paymentHolds)
				.where(eq(paymentHolds.subscription_id, sub.id))
				.limit(1);
			if (known) {
				summary.alreadyHeld += 1;
				print(`SKIPPED ${sub.id}: a hold already names it (${known.id}, ${known.state}).`);
				continue;
			}
			if (verdict.kind === "listed") {
				summary.listed += 1;
				print(`LISTED ${sub.id}: ${verdict.failed}`);
				continue;
			}
			if (await holdFromBackfill(sub.id, verdict, deps, print)) summary.held += 1;
			else summary.listed += 1;
		}
	}
	print(
		`Backfill: ${summary.held} held, ${summary.listed} listed for review, ${summary.alreadyHeld} already held, ` +
			`${summary.notCreateATeam} not create-a-team subscriptions.`,
	);
	return summary;
}

/** Opens and advances one backfill hold under its payer's lease. True when this run opened it. */
async function holdFromBackfill(
	subscriptionId: string,
	verdict: Extract<BackfillVerdict, { kind: "hold" }>,
	deps: ServerDeps,
	print: Print,
): Promise<boolean> {
	const lease = await deps.lease.acquirePurchaseLease(deps.store.payerLeaseKey(verdict.payer), LEASE_WAIT_MS);
	if (!lease) {
		print(`LISTED ${subscriptionId}: its payer's lease stayed busy; re-run the backfill.`);
		return false;
	}
	try {
		const opened = await deps.store.openHold(lease, {
			subscriptionId,
			customerId: verdict.customerId,
			payerKey: verdict.payer,
			invoiceId: verdict.invoiceId,
			state: "closing",
			nextCheckAt: new Date(),
			openedBy: "backfill",
			openNote: verdict.evidence,
		});
		if (opened.kind !== "opened") {
			print(`LISTED ${subscriptionId}: the hold was not written (${opened.kind}).`);
			return false;
		}
		const advanced = await advanceHold(opened.hold, deps.sweeper.machineDepsFor(lease, deps.sweepDeps));
		print(
			`HELD ${subscriptionId}: hold ${opened.hold.id}, ${advanced.hold.state}` +
				`${advanced.hold.release_reason ? `(${advanced.hold.release_reason})` : ""} after ${advanced.rows.join(" → ") || "no row"}.`,
		);
		return true;
	} finally {
		await deps.lease.releasePurchaseLease(lease);
	}
}

/** `reconcile`: the backfill when asked, then one sweeper pass, printing its counts. */
export async function reconcile(
	input: { backfill: boolean; payer: string | undefined },
	deps: ServerDeps,
	stripe: BackfillStripe,
	print: Print,
): Promise<void> {
	if (input.backfill) await runBackfill(deps, stripe, print);
	const result = await deps.sweeper.runPaymentHoldSweep({ payerKey: input.payer, deps: deps.sweepDeps });
	print(`Sweep: ${JSON.stringify(result)}`);
}

/** Returns the value of `--name <v>` / `--name=<v>` from `argv`, or undefined. */
function arg(argv: readonly string[], name: string): string | undefined {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = argv.indexOf(`--${name}`);
	return idx !== -1 ? argv[idx + 1] : undefined;
}

const USAGE = [
	"Usage: billing:payment-holds <command>",
	"  list [--open] [--payer <user id>]",
	"  show <subscription_id>",
	'  release <subscription_id> --reason "<why>" --operator <your user id>',
	"  reconcile [--backfill] [--payer <user id>]",
].join("\n");

/**
 * Loads the server modules. They `import "server-only"`, a marker Next.js resolves at build time and
 * that is not installed on its own; outside Next it is resolved to Next's own empty build of it, which
 * is the file Next maps it to on the server.
 */
async function loadServerDeps(): Promise<ServerDeps> {
	if (typeof nodeModule.registerHooks !== "function") {
		throw new Error("billing:payment-holds needs Node 22.15 or later (module.registerHooks).");
	}
	const empty = pathToFileURL(nodeModule.createRequire(import.meta.url).resolve("next/dist/compiled/server-only/empty.js")).href;
	nodeModule.registerHooks({
		resolve: (specifier, context, nextResolve) =>
			specifier === "server-only" ? { url: empty, shortCircuit: true } : nextResolve(specifier, context),
	});
	const [store, lease, sweeper] = await Promise.all([
		import("@/lib/billing/payment-holds/store"),
		import("@/lib/billing/purchase-lease"),
		import("@/lib/billing/payment-holds/sweeper"),
	]);
	return { store, lease, sweeper, sweepDeps: sweeper.liveSweepDeps() };
}

/** The live Stripe client, for the backfill's own reads. */
async function liveBackfillStripe(): Promise<Stripe> {
	const { getStripe } = await import("@/lib/billing/stripe");
	return getStripe();
}

/** CLI entry: runs one command and returns the exit code. */
export async function main(argv: readonly string[], print: Print = (line) => console.log(line)): Promise<number> {
	const [command, subject] = argv;
	const needsSubject = command === "show" || command === "release";
	if (
		!command ||
		!["list", "show", "release", "reconcile"].includes(command) ||
		(needsSubject && (!subject || subject.startsWith("--")))
	) {
		console.error(USAGE);
		return 1;
	}
	try {
		if (command === "list") {
			await listHolds({ open: argv.includes("--open"), payer: arg(argv, "payer") }, print);
			return 0;
		}
		if (command === "release" && subject) {
			// The refusals that need nothing loaded come first.
			if (!arg(argv, "reason")?.trim() || !arg(argv, "operator")?.trim()) {
				refuse(print, "release needs --reason \"<why>\" and --operator <your user id>.");
				return 1;
			}
			const result = await releaseHoldCommand(
				{ subscriptionId: subject, reason: arg(argv, "reason"), operator: arg(argv, "operator") },
				await loadServerDeps(),
				print,
			);
			return result.kind === "refused" ? 1 : 0;
		}
		const deps = await loadServerDeps();
		if (command === "show" && subject) {
			await showHold(subject, deps, print);
			return 0;
		}
		await reconcile(
			{ backfill: argv.includes("--backfill"), payer: arg(argv, "payer") },
			deps,
			await liveBackfillStripe(),
			print,
		);
		return 0;
	} catch (err) {
		console.error(`payment-holds ${command} failed:`, err);
		return 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	// Exits explicitly: the database pool would otherwise keep the process alive.
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
