// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold operator command (ADR 0002 §5.4 "Commands", §8 "Backfill", Q12; S6 #5783; ADR 0004
// D1 rule 5).
//
// Usage (`pnpm -C apps/console billing:payment-holds …`):
//   list [--open] [--scope new_org|org_plan] [--payer <user or org id>]
//                                              read-only: the holds, newest first
//   show <subscription_id>                     read-only: its holds, its setup, and the LIVE observation
//   release <subscription_id> --reason "<why>" --operator <your user id>
//                                              T16: releases the subscription's OPEN hold, audited
//   release <subscription_id> --moved-to <team id> --reason "<why>" --operator <your user id>
//                                              T16m: the moved release of a `link_refused` hold (§5.8)
//   reconcile [--backfill] [--scope new_org|org_plan] [--payer <user or org id>]
//                                              one sweeper pass now; --backfill first runs the §8 listing,
//                                              then prints the S1-era closures whose subscription is live
//
// SCOPE (ADR 0004 D1). A hold is `new_org` (create-a-team; its payer is a user id) or `org_plan` (its
// payer is an org id). `--scope` narrows `list` and `reconcile` to one; with `--payer` the pair is the
// filter, since a payer id alone is never a key. Every lease this command takes is the hold's own,
// `leaseKeyFor(scope, payer_key)`: `user:<payer>` or `org-plan:<org>`. An unknown `--scope` is refused
// before anything is read.
//
// RELEASE (T16). Refuses with no --reason or no --operator. Takes the hold's own lease
// (`leaseKeyFor(scope, payer)`, waiting up to 30s, refusing while still busy), prints the live observation, then releases with the
// store's compare-and-set on `version` (`release_reason = operator`, `released_by`, `release_note`). Only
// when that write returned the row is the audit event `billing.payment_hold.released` written — a
// structured log line with that stable name (there is no billing audit table; the durable record is the
// row's `released_by` and `release_note`). A second run finds no open hold and writes nothing.
//   A `new_org` release closes the hold's OPEN setup in the same transaction (§4.1); an `org_plan`
// release closes none (ADR 0004 D1 rule 4), so the setup rule below applies to `new_org` holds only.
// Closing the setup of a
// subscription that may still go live would hide it from every reader (I14), so while an open setup names
// the subscription, the release is REFUSED unless Stripe reads it ended or `resource_missing`, or it reads
// live and its setup has an org. Then the link's core runs FIRST, under the same lease (§5.6 "When a hold
// ends"): a setup it links is no longer open, so the release that follows closes nothing. A re-link
// that does not link — the team's row names another live plan, or one of the link's checks fails (the
// creator no longer holds manage_billing, say) — refuses the release, and says why: decide X, or Y, in
// Stripe first. A live subscription whose setup has
// no org, or any other read, still refuses: cancel it in Stripe first (refunding it if it was paid), and
// the machine settles the hold. When that re-link does not link a hold the link opened on its refusal
// (`open_note = link_refused`), the refusal also names `--moved-to`.
//
// MOVED RELEASE (T16m, E2m, ADR 0002 §5.8). `--moved-to <T>` alone selects it; `--reason` and `--operator`
// stay required, and a `--moved-to` with no value, or a T or X outside the id charset (letters, digits,
// `_`, `-`), is refused before anything is read. Support moved X to
// team T in Stripe; this checks that the move fully happened and releases the hold with T16's own write.
// It moves nothing and makes no Stripe write. Steps 1–3 are T16's (the hold, the payer's lease, the
// re-read under it). Then, in this order:
//   - the database facts: T's `organization` row, the payer U's `member` row in T and
//     `holdsManageBilling(U, T)`, and X's setup — rows 1–4 of `decideMovedRelease` (machine.ts) are
//     decided on these alone, before anything is read from Stripe;
//   - T's org-plan purchase lock (`withPurchaseLock('org-plan:<T>')`), held from the Stripe reads through
//     the release; still busy after its 30s wait, it refuses with `team_purchase_in_progress`;
//   - under it: the live observation (printed, never evidence), then X, X's customer, T's billing row
//     BEFORE any sync, every subscription of T's row's customer, of X's customer and of each customer
//     whose `organization_id` is T (at most 1000 per customer, at most 50 customers), and Stripe's search
//     for T's subscriptions (at most 10 pages of 100). A cap that is reached reads as `stripe_unreadable`;
//   - the decision. Before a sync or a release the payer's lease is renewed (`lease_lost` when another
//     caller took it). `sync_first` syncs X once and decides again; `release` calls `operatorRelease`
//     with `release_note = "moved to <T>: <reason>"` and `expectOrgRow`, so the store writes nothing
//     unless T's row, read FOR SHARE in the release's transaction, still names X (`row_changed`).
// Only the caller whose compare-and-set landed writes the audit event, which then also carries
// `moved_to`, `payer`, `customer_id`, `row_subscription_id`, `row_status`, `listed_customers`,
// `listed_subscription_count` and `setup_closed`. A refusal writes nothing to `payment_holds` or
// `pending_org_setups`, makes no Stripe write, raises no alert and exits 1; only `row_not_x` and
// `row_changed` can follow the one sync of X.
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
//      taken counts: nothing was paid by any other method). An invoice with NO PaymentIntent proves
//      nothing either way: it is held in `needs_operator` and alerted, never advanced;
//   B6 not a withdrawal: no `commerce_order` names it as `withdrawn` or `refunded`.
// Each hit is opened as a `new_org` hold (`opened_by = backfill`, `open_note` naming the evidence) under
// its payer's lease and advanced at once; one the machine cannot settle reaches `needs_operator`.
// Everything else is LISTED with the failed test named, and nothing is written for it (Q12: each is a
// support decision, with `show` as the evidence). Safe to re-run, and to run twice at once: a subscription any hold has ever
// named — open or released — is skipped, and that check is made again under the payer's lease before a
// hold is opened.
//
// S1-ERA CLOSURES (§8). Before holds existed, the link's refusal beside a team's other live plan CLOSED
// the setup (`closed_reason = org_has_plan`) while its subscription could still be live, which hides it
// from every reader. `--backfill` also prints each such setup whose subscription reads live, for the
// operator. It holds none of them and writes nothing: the subscription is paid and live, and only an
// operator decides its money (Q12).
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
import {
	advanceHold,
	decideMovedRelease,
	LINK_REFUSED_NOTE,
	type MovedOrgRow,
	type MovedOtherSubscription,
	type MovedReleaseFacts,
	type MovedReleaseRefusal,
	type MovedStripeFacts,
	operatorRelease,
} from "@/lib/billing/payment-holds/machine";
import { type HoldObservation, isResourceMissing, observeHold } from "@/lib/billing/payment-holds/observe";
import type * as StoreModule from "@/lib/billing/payment-holds/store";
import type * as SweeperModule from "@/lib/billing/payment-holds/sweeper";
import type { PendingOrgSetupRow } from "@/lib/billing/pending-org-setup";
import type * as LockModule from "@/lib/billing/purchase-lock";
import type * as LeaseModule from "@/lib/billing/purchase-lease";
import type * as SyncModule from "@/lib/billing/sync";
import { getServiceDb } from "@/lib/db";
import {
	commerceOrder,
	leaseKeyFor,
	member,
	type OrganizationBilling,
	organization,
	PAYMENT_HOLD_SCOPES,
	type PaymentHoldRow,
	type PaymentHoldScope,
	paymentHolds,
	pendingOrgSetups,
} from "@/lib/db/schema";

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
	store: Pick<typeof StoreModule, "openHold" | "writeHoldState">;
	lease: Pick<typeof LeaseModule, "acquirePurchaseLease" | "releasePurchaseLease">;
	sweeper: Pick<typeof SweeperModule, "runPaymentHoldSweep" | "machineDepsFor" | "holdsManageBilling">;
	/** The sweeper's Stripe client, alert and email sender (`liveSweepDeps()`, or a test's). */
	sweepDeps: SweeperModule.SweepDeps;
	/** What only the moved release (`--moved-to`, §5.8) uses; `main` always loads it. */
	moved?: MovedReleaseDeps;
}

/** The Stripe reads the moved release makes (a structural subset of the SDK; all read-only). */
export interface MovedStripe {
	subscriptions: {
		retrieve(id: string): Promise<Stripe.Subscription>;
		list(params: {
			customer: string;
			status: "all";
			limit: number;
			starting_after?: string;
		}): Promise<{ has_more: boolean; data: Stripe.Subscription[] }>;
		search(params: {
			query: string;
			limit: number;
			page?: string;
		}): Promise<{ has_more: boolean; next_page: string | null; data: Stripe.Subscription[] }>;
	};
	customers: {
		retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
		search(params: { query: string; limit: number }): Promise<{ has_more: boolean; data: Array<{ id: string }> }>;
	};
}

/** The columns of a team's `organization_billing` row the moved release reads. */
type MovedBillingRow = Pick<OrganizationBilling, "stripeSubscriptionId" | "status" | "stripeCustomerId" | "updatedAt">;

/** `ServerDeps` with the moved release's modules loaded. */
type MovedServerDeps = ServerDeps & { moved: MovedReleaseDeps };

/** The moved release's server modules and its Stripe client (the purchase client, `getPurchaseStripe()`). */
export interface MovedReleaseDeps {
	lease: Pick<typeof LeaseModule, "renewPurchaseLease">;
	lock: Pick<typeof LockModule, "withPurchaseLock">;
	sync: Pick<typeof SyncModule, "syncSubscriptionToBilling" | "isOrgPlanSubscription">;
	/** `getOrgBilling` (lib/billing/queries.ts), as far as the moved release reads it. */
	queries: { getOrgBilling(orgId: string): Promise<MovedBillingRow | null> };
	/** `pendingOrgSetupFor` (lib/billing/pending-org-setup.ts), as far as the moved release reads it. */
	setups: {
		pendingOrgSetupFor(userId: string, subscriptionId: string): Promise<Pick<PendingOrgSetupRow, "created_org_id"> | null>;
	};
	stripe: () => MovedStripe;
}

/** Where every line meant for the operator goes. */
type Print = (line: string) => void;

/** How long `release` and the backfill wait for a payer's lease. */
const LEASE_WAIT_MS = 30_000;

/** One line describing a hold, for `list` and `show`. No amount, card or email. */
function holdLine(h: PaymentHoldRow): string {
	return [
		`hold ${h.id}`,
		`scope ${h.scope}`,
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

/** `list`: the holds, newest first (at most 500), optionally only the open ones, one scope's and one payer's. */
export async function listHolds(
	input: { open: boolean; scope?: PaymentHoldScope; payer: string | undefined },
	print: Print,
): Promise<number> {
	const rows = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(
			and(
				input.open ? ne(paymentHolds.state, "released") : undefined,
				input.scope ? eq(paymentHolds.scope, input.scope) : undefined,
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

/** What `release` did. A moved release's refusal carries its typed `code` (§5.8). */
export type ReleaseResult =
	| { kind: "released"; holdId: string }
	| { kind: "not_open" }
	| { kind: "refused"; reason: string; code?: MovedReleaseRefusal };

/**
 * Whether `id` is made only of the characters a team id (a UUID) or a Stripe id (`sub_…`) uses. The moved
 * release puts the team id into a Stripe search query string (`metadata['organization_id']:'<T>'`), so a
 * quote or a space there could change the query; this refuses such a value before anything is read.
 */
function isPlainId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id);
}

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
	input: {
		subscriptionId: string;
		reason: string | undefined;
		operator: string | undefined;
		/** `--moved-to`: present (even empty) selects the moved release (§5.8). */
		movedTo?: string;
	},
	deps: ServerDeps,
	print: Print,
): Promise<ReleaseResult> {
	const reason = input.reason?.trim() ?? "";
	const operator = input.operator?.trim() ?? "";
	if (!reason) return refuse(print, "--reason is required: say why this hold is being released.");
	if (!operator) return refuse(print, "--operator is required: your user id, recorded as released_by.");
	const movedTo = input.movedTo?.trim();
	if (movedTo !== undefined && (movedTo === "" || movedTo.startsWith("--"))) {
		return refuse(print, "--moved-to needs the id of the team support moved the subscription to.");
	}
	if (movedTo !== undefined && (!isPlainId(input.subscriptionId) || !isPlainId(movedTo))) {
		return refuse(print, "the subscription id and --moved-to may contain only letters, digits, '_' and '-'.");
	}

	const found = await openHoldOf(input.subscriptionId);
	if (!found) {
		print(`No OPEN hold names ${input.subscriptionId}; nothing was changed.`);
		return { kind: "not_open" };
	}
	const lease = await deps.lease.acquirePurchaseLease(leaseKeyFor(found.scope, found.payer_key), LEASE_WAIT_MS);
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
		if (movedTo !== undefined) {
			if (!deps.moved) throw new Error("payment-holds release --moved-to: the moved release's server modules are not loaded.");
			return await movedRelease(lease, hold, { teamId: movedTo, reason, operator }, { ...deps, moved: deps.moved }, print);
		}
		const stripe = deps.sweepDeps.stripe();
		const live = await observe(hold, stripe);
		print(observationLine(live));

		if (!("error" in live) && live.sub.kind === "missing") {
			print(`${hold.subscription_id} not found in this Stripe account. Check the key before you release it.`);
		}
		const settled = !("error" in live) && (live.sub.kind === "ended" || live.sub.kind === "missing");
		// Only a `new_org` release closes a setup (ADR 0004 D1 rule 4), so only it can hide one.
		if (hold.scope === "new_org" && !settled && (await hasOpenSetup(hold.subscription_id))) {
			const relinked = !("error" in live) && live.sub.kind === "live" ? await relinkBeforeRelease(lease, hold, deps) : null;
			if (relinked?.kind === "linked") {
				print(`Linked ${hold.subscription_id} to its team first (§5.6); its setup is no longer open.`);
			} else if (relinked?.kind === "refused" || relinked?.kind === "not_linked") {
				const why = relinked.kind === "refused" ? "the team's billing row names another live plan" : relinked.why;
				// §5.8: a hold the link opened on its refusal may have been moved to another team by support.
				const moved =
					relinked.kind === "not_linked" && hold.open_note === LINK_REFUSED_NOTE
						? ` If support moved ${hold.subscription_id} to another team, run \`release\` with \`--moved-to <that team's id>\`.`
						: "";
				return refuse(
					print,
					`the subscription is live and its team setup could not be linked (${why}). Releasing would close that setup and hide a paid, live subscription. Cancel and refund it, or the team's other plan, in Stripe first.${moved}`,
				);
			} else {
				const read = "error" in live ? "could not be read" : `reads ${live.sub.kind}`;
				return refuse(
					print,
					`the subscription ${read}, and an open setup names it${relinked?.kind === "no_org" ? " with no team (none was made, or it was deleted)" : ""}. Releasing would close that setup and hide a subscription that may still go live. Cancel it in Stripe first (refund it if it was paid); the machine then settles the hold.`,
				);
			}
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

/**
 * §5.6 "When a hold ends", for a release of a LIVE subscription: the link's core for its open setup, under
 * the payer's lease this command holds (`relinkAdoptedSetup`, loaded here because it imports
 * `server-only`). A link it refuses beside another live plan opens nothing new: the hold being released
 * already names the subscription.
 */
async function relinkBeforeRelease(
	lease: LeaseModule.PurchaseLease,
	hold: PaymentHoldRow,
	deps: ServerDeps,
): Promise<SweeperModule.RelinkResult> {
	const { relinkAdoptedSetup } = await import("@/lib/billing/payment-holds/sweeper");
	return relinkAdoptedSetup(lease, hold, deps.sweepDeps.alert);
}

// ── The moved release (T16m, E2m, ADR 0002 §5.8) ───────────────────────────────────────────────────

/** The most subscriptions read on one customer before the listing counts as unreadable (§5.8 step 7). */
const MOVED_LIST_CAP = 1000;
/** One page of `subscriptions.list`: Stripe's maximum. */
const MOVED_LIST_PAGE = 100;
/** The most customers whose `organization_id` is the team before the search counts as unreadable. */
const MOVED_CUSTOMER_CAP = 50;
/** The most pages of `subscriptions.search` read before it counts as unreadable. */
const MOVED_SEARCH_PAGES = 10;
/** One page of `subscriptions.search`: Stripe's maximum. */
const MOVED_SEARCH_PAGE = 100;

/** What each refusal tells the operator to do instead (§5.8, the checks table). */
function movedRefusalText(code: MovedReleaseRefusal, x: string, t: string, payer: string, detail: string): string {
	switch (code) {
		case "not_link_refused":
			return "This hold was not opened by a refused link; use `release` without `--moved-to`.";
		case "team_not_found":
			return `No team has id ${t}; check the id.`;
		case "same_team":
			return `That is the team this setup was made for; \`release\` without \`--moved-to\` re-links ${x} to it once its other plan is gone (ADR 0002 §5.6 'When a hold ends').`;
		case "payer_not_in_team":
			return `${payer}'s customer, and so ${payer}'s payment method, would pay for ${x} and for every later purchase ${t} makes, and ${payer} is not an active owner of ${t} who can manage its billing. Do not move ${x} there: refund it (\`release\` once it is cancelled). If ${payer} should own ${t}, ${t}'s existing owner must agree and make ${payer} an owner first: that changes who governs ${t}, not only who pays.`;
		case "team_purchase_in_progress":
			return `${t} is buying a plan right now; try again in a minute, then check ${t}'s subscriptions with \`show\`.`;
		case "x_missing":
			return `${x} is not in this Stripe account; check the key, then use \`release\` without \`--moved-to\`, which accepts a missing ${x}.`;
		case "stripe_unreadable":
			return `Could not read everything about ${x} and ${t} from Stripe (${detail}); nothing was written; try again, or work it by hand.`;
		case "x_ended":
			return `${x} has ended (${detail}); use \`release\` without \`--moved-to\`, which releases and closes the setup.`;
		case "x_not_movable":
			return `${x} is ${detail}; only a paid ${x} is moved. Wait until it is paid, or cancel and refund it.`;
		case "subscription_not_moved":
			return `${x}'s organization_id names ${detail}. Set ${x}'s organization_id to ${t} in Stripe first.`;
		case "customer_not_moved":
			return `${x}'s customer's organization_id names ${detail}. Set ${x}'s customer's organization_id to ${t} in Stripe first.`;
		case "team_has_other_plan":
			return `${t} has another plan subscription on its billing row or in Stripe, ${detail}. ${t} is billed by, or is buying, another plan, and moving ${x} there would bill ${t} twice. Decide ${x} or that subscription in Stripe first, or wait for it to settle. If it has ended in Stripe but ${t}'s row still names it \`none\` (its ending webhook never landed), redeliver its \`customer.subscription.deleted\` event from the Stripe dashboard, then run this again.`;
		case "too_soon":
			return `${x} was moved to ${t} less than 15 minutes ago. Run this again after ${detail}, so that Stripe's search can see everything ${t} bought before the move.`;
		case "row_not_x":
			return `${t}'s billing row names ${detail}; nothing was released.`;
		case "lease_lost":
			return "Another request took this payer's lease while the command read Stripe; nothing was written. Run it again.";
		case "row_changed":
			return `${t}'s billing row changed while this ran (it names ${detail}); nothing was written. Run \`show\` and decide again.`;
	}
}

/** Prints a moved release's refusal and returns it, with its typed code. */
function refuseMoved(
	print: Print,
	code: MovedReleaseRefusal,
	ctx: { x: string; t: string; payer: string },
	detail = "",
): ReleaseResult {
	const reason = movedRefusalText(code, ctx.x, ctx.t, ctx.payer, detail);
	print(`Refused (${code}): ${reason}`);
	return { kind: "refused", code, reason };
}

/** A team's billing row, as `decideMovedRelease` reads it; null when the team has none. */
function movedRow(row: MovedBillingRow | null): MovedOrgRow | null {
	if (!row) return null;
	return {
		subscriptionId: row.stripeSubscriptionId,
		status: row.status,
		customerId: row.stripeCustomerId,
		updatedAt: row.updatedAt,
	};
}

/** Step 7's reads, and what the audit event records of them. */
interface MovedStripeRead {
	facts: MovedStripeFacts;
	/** X as this run read it: the object the one sync is made with. Null unless X was read. */
	sub: Stripe.Subscription | null;
	/** Every customer whose subscriptions were listed. */
	listedCustomers: string[];
	/** Every distinct subscription the listings and the search returned, X included. */
	listedSubscriptionCount: number;
}

/**
 * Every subscription of `customerId`, of every status, paged to the end; null when there are more than
 * `MOVED_LIST_CAP` (a cap that is reached is not a clean read). A page that fails is thrown.
 */
async function listAllSubscriptions(stripe: MovedStripe, customerId: string): Promise<Stripe.Subscription[] | null> {
	const subs: Stripe.Subscription[] = [];
	let startingAfter: string | undefined;
	for (;;) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			status: "all",
			limit: MOVED_LIST_PAGE,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		subs.push(...page.data);
		const last = page.data.at(-1);
		if (!page.has_more || !last) return subs;
		if (subs.length >= MOVED_LIST_CAP) return null;
		startingAfter = last.id;
	}
}

/**
 * §5.8 step 7, all read-only: X, X's customer, T's billing row BEFORE any sync, every subscription on
 * each of T's row's customer, X's customer and the customers whose `organization_id` is T, and Stripe's
 * search for T's subscriptions. `resource_missing` for X is `x_missing`; any other failure, and any cap
 * that is reached, is `unreadable`. A database failure is thrown.
 */
async function readMovedStripe(x: string, t: string, deps: MovedServerDeps): Promise<MovedStripeRead> {
	const stripe = deps.moved.stripe();
	const unread = (what: string): MovedStripeRead => ({
		facts: { kind: "unreadable", what },
		sub: null,
		listedCustomers: [],
		listedSubscriptionCount: 0,
	});
	let sub: Stripe.Subscription;
	try {
		sub = await stripe.subscriptions.retrieve(x);
	} catch (err) {
		if (isResourceMissing(err)) return { facts: { kind: "x_missing" }, sub: null, listedCustomers: [], listedSubscriptionCount: 0 };
		return unread(`subscriptions.retrieve: ${err instanceof Error ? err.message : String(err)}`);
	}
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	let customer: Stripe.Customer | Stripe.DeletedCustomer;
	try {
		customer = await stripe.customers.retrieve(customerId);
	} catch (err) {
		return unread(`customers.retrieve: ${err instanceof Error ? err.message : String(err)}`);
	}
	const row = movedRow(await deps.moved.queries.getOrgBilling(t));

	const query = `metadata['organization_id']:'${t}'`;
	const seen = new Map<string, Stripe.Subscription>([[sub.id, sub]]);
	const customers = new Set<string>();
	try {
		const found = await stripe.customers.search({ query, limit: MOVED_CUSTOMER_CAP });
		if (found.has_more) return unread(`more than ${MOVED_CUSTOMER_CAP} customers name ${t}`);
		for (const c of [row?.customerId ?? null, customerId, ...found.data.map((d) => d.id)]) if (c) customers.add(c);
		for (const c of customers) {
			const listed = await listAllSubscriptions(stripe, c);
			if (!listed) return unread(`more than ${MOVED_LIST_CAP} subscriptions on customer ${c}`);
			for (const s of listed) seen.set(s.id, s);
		}
		let page: string | undefined;
		for (let n = 0; ; n++) {
			if (n === MOVED_SEARCH_PAGES) return unread(`more than ${MOVED_SEARCH_PAGES} pages of subscriptions name ${t}`);
			const hits = await stripe.subscriptions.search({ query, limit: MOVED_SEARCH_PAGE, ...(page ? { page } : {}) });
			for (const s of hits.data) seen.set(s.id, s);
			if (!hits.has_more || !hits.next_page) break;
			page = hits.next_page;
		}
	} catch (err) {
		return unread(`a listing or the search: ${err instanceof Error ? err.message : String(err)}`);
	}

	const others: MovedOtherSubscription[] = [];
	for (const s of seen.values()) {
		if (s.id === x) continue;
		others.push({
			id: s.id,
			status: s.status,
			orgId: s.metadata?.organization_id ?? null,
			orgPlan: deps.moved.sync.isOrgPlanSubscription(s),
		});
	}
	return {
		facts: {
			kind: "read",
			x: { status: sub.status, orgId: sub.metadata?.organization_id ?? null, customerId },
			customer: { deleted: customer.deleted === true, orgId: customer.deleted ? null : (customer.metadata?.organization_id ?? null) },
			row,
			others,
		},
		sub,
		listedCustomers: [...customers],
		listedSubscriptionCount: seen.size,
	};
}

/**
 * The moved release (§5.8 steps 5–11), under the payer's lease the caller holds and after T16's steps
 * 1–4: the database facts, rows 1–4; T's purchase lock; under it the Stripe facts, the decision, at most
 * one sync, and the release with `expectOrgRow`. The caller gives the lease back; the lock is released
 * when this returns or throws.
 */
async function movedRelease(
	lease: LeaseModule.PurchaseLease,
	hold: PaymentHoldRow,
	input: { teamId: string; reason: string; operator: string },
	deps: MovedServerDeps,
	print: Print,
): Promise<ReleaseResult> {
	const x = hold.subscription_id;
	const t = input.teamId;
	const ctx = { x, t, payer: hold.payer_key };
	const db = getServiceDb();

	// Step 5: the database facts. Nothing is read from Stripe until rows 1–4 pass.
	const [team] = await db
		.select({ id: organization.id, metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, t))
		.limit(1);
	const [membership] = team
		? await db
				.select({ role: member.role, status: member.status })
				.from(member)
				.where(and(eq(member.organizationId, t), eq(member.userId, hold.payer_key)))
				.limit(1)
		: [];
	const activeOwner = membership?.role === "owner" && membership.status === "active";
	const managesBilling = activeOwner ? await deps.sweeper.holdsManageBilling(hold.payer_key, t) : false;
	const setup = await deps.moved.setups.pendingOrgSetupFor(hold.payer_key, x);
	const facts: MovedReleaseFacts = {
		hold,
		teamId: t,
		team: team ?? null,
		setupOrgId: setup?.created_org_id ?? null,
		payer: { member: membership ?? null, managesBilling },
		syncedOnce: false,
		rowAfterSync: null,
		now: deps.sweepDeps.now(),
	};
	const first = decideMovedRelease(facts);
	if (first.kind === "refuse") return refuseMoved(print, first.code, ctx, first.detail);

	// Step 6: T's org-plan purchase lock, held through step 9.
	const locked = await deps.moved.lock.withPurchaseLock(`org-plan:${t}`, () =>
		movedReleaseUnderLock(lease, hold, input, facts, deps, print),
	);
	if (locked.acquired) return locked.value;
	const busy = decideMovedRelease({ ...facts, lock: "busy" });
	if (busy.kind !== "refuse") throw new Error(`payment-holds release --moved-to: unexpected decision ${busy.kind}`);
	return refuseMoved(print, busy.code, ctx, busy.detail);
}

/** §5.8 steps 7–10, inside T's purchase lock. */
async function movedReleaseUnderLock(
	lease: LeaseModule.PurchaseLease,
	hold: PaymentHoldRow,
	input: { teamId: string; reason: string; operator: string },
	before: MovedReleaseFacts,
	deps: MovedServerDeps,
	print: Print,
): Promise<ReleaseResult> {
	const x = hold.subscription_id;
	const t = input.teamId;
	const ctx = { x, t, payer: hold.payer_key };

	// Step 7. The live observation is a display read only, printed once rows 1–4 have passed.
	print(observationLine(await observe(hold, deps.sweepDeps.stripe())));
	const read = await readMovedStripe(x, t, deps);
	const facts: MovedReleaseFacts = { ...before, lock: "held", stripe: read.facts, now: deps.sweepDeps.now() };
	let decision = decideMovedRelease(facts);
	if (decision.kind === "refuse") return refuseMoved(print, decision.code, ctx, decision.detail);

	// The payer's lease is renewed before anything the decision may lead to: a sync, or the release.
	if (!(await deps.moved.lease.renewPurchaseLease(lease))) return refuseMoved(print, "lease_lost", ctx);

	// Step 8: at most one sync of X, with the object this run read and no event time.
	if (decision.kind === "sync_first" && read.sub) {
		await deps.moved.sync.syncSubscriptionToBilling(read.sub);
		decision = decideMovedRelease({
			...facts,
			syncedOnce: true,
			rowAfterSync: movedRow(await deps.moved.queries.getOrgBilling(t)),
		});
		if (decision.kind === "refuse") return refuseMoved(print, decision.code, ctx, decision.detail);
	}
	if (decision.kind !== "release") {
		throw new Error(`payment-holds release --moved-to: unexpected decision ${decision.kind}`);
	}

	// Step 9: T16's compare-and-set, with T's row checked FOR SHARE in the same transaction.
	const out = await operatorRelease(hold, deps.sweeper.machineDepsFor(lease, deps.sweepDeps), {
		operatorId: input.operator,
		reason: `moved to ${t}: ${input.reason}`,
		expectOrgRow: { orgId: t, subscriptionId: x },
	});
	if (!out.released) {
		const now = movedRow(await deps.moved.queries.getOrgBilling(t));
		if (now?.subscriptionId !== x) {
			return refuseMoved(print, "row_changed", ctx, now?.subscriptionId ? `${now.subscriptionId}, ${now.status}` : "nothing");
		}
		print("Nothing was written: the hold moved on, or the lease was lost. Run `show` and try again.");
		return { kind: "not_open" };
	}

	// Step 10: the audit event, only from the caller whose write landed.
	const customerId = read.facts.kind === "read" ? read.facts.x.customerId : null;
	console.info(
		JSON.stringify({
			event: "billing.payment_hold.released",
			hold_id: out.released.id,
			subscription_id: out.released.subscription_id,
			from_state: hold.state,
			operator: input.operator,
			reason: input.reason,
			moved_to: t,
			payer: hold.payer_key,
			customer_id: customerId,
			row_subscription_id: out.checkedOrgRow?.subscriptionId ?? null,
			row_status: out.checkedOrgRow?.status ?? null,
			listed_customers: read.listedCustomers,
			listed_subscription_count: read.listedSubscriptionCount,
			setup_closed: out.closedSetupId,
		}),
	);
	print(`Released hold ${out.released.id} of ${out.released.subscription_id}, moved to ${t} (release_reason operator).`);
	return { kind: "released", holdId: out.released.id };
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
	| {
			kind: "hold";
			payer: string;
			customerId: string;
			invoiceId: string;
			evidence: string;
			/**
			 * B5 passed only on ABSENCE: the invoice carries no PaymentIntent, so nothing proves the method was
			 * a card. Held for an operator (`needs_operator`, alerted), never advanced by the machine.
			 */
			toOperator: boolean;
		};

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
	const toOperator = intents.length === 0;
	const b5 = toOperator ? "B5 unproven (no PaymentIntent on the invoice; held for an operator)" : "B5 card";
	return {
		kind: "hold",
		payer,
		customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
		invoiceId: invoice.id,
		evidence: `backfill: B2 ${ended}; B3 one subscription_create invoice ${invoice.id}; B4 ${b4}; ${b5}; B6 no withdrawal`,
		toOperator,
	};
}

/** What the backfill did, by count. */
export interface BackfillSummary {
	/** Held and advanced by the machine. */
	held: number;
	/** Held in `needs_operator` and alerted: B5 had no PaymentIntent to prove a card. */
	toOperator: number;
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
	const summary: BackfillSummary = { held: 0, toOperator: 0, listed: 0, alreadyHeld: 0, notCreateATeam: 0 };
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
			// A cheap first look; `holdFromBackfill` asks again under the payer's lease.
			const known = await knownHold(sub.id);
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
			const outcome = await holdFromBackfill(sub.id, verdict, deps, print);
			if (outcome === "held") summary.held += 1;
			else if (outcome === "to_operator") summary.toOperator += 1;
			else if (outcome === "already") summary.alreadyHeld += 1;
			else summary.listed += 1;
		}
	}
	print(
		`Backfill: ${summary.held} held, ${summary.toOperator} held for an operator, ${summary.listed} listed for review, ${summary.alreadyHeld} already held, ` +
			`${summary.notCreateATeam} not create-a-team subscriptions.`,
	);
	return summary;
}

/** What one backfill hit came to. */
type BackfillOutcome = "held" | "to_operator" | "already" | "listed";

/** Whether any hold, open or released, has ever named `subscriptionId`; the hold's id and state if so. */
async function knownHold(subscriptionId: string): Promise<{ id: string; state: string } | null> {
	const [known] = await getServiceDb()
		.select({ id: paymentHolds.id, state: paymentHolds.state })
		.from(paymentHolds)
		.where(eq(paymentHolds.subscription_id, subscriptionId))
		.limit(1);
	return known ?? null;
}

/**
 * Opens one backfill hold under its payer's lease, and advances it — or, when B5 rested on no
 * PaymentIntent at all, opens it in `needs_operator` and alerts instead. The "a hold already names it"
 * check is made again UNDER the lease, so two backfills running at once cannot both open one.
 */
async function holdFromBackfill(
	subscriptionId: string,
	verdict: Extract<BackfillVerdict, { kind: "hold" }>,
	deps: ServerDeps,
	print: Print,
): Promise<BackfillOutcome> {
	const lease = await deps.lease.acquirePurchaseLease(leaseKeyFor("new_org", verdict.payer), LEASE_WAIT_MS);
	if (!lease) {
		print(`LISTED ${subscriptionId}: its payer's lease stayed busy; re-run the backfill.`);
		return "listed";
	}
	try {
		const known = await knownHold(subscriptionId);
		if (known) {
			print(`SKIPPED ${subscriptionId}: a hold already names it (${known.id}, ${known.state}).`);
			return "already";
		}
		const now = new Date();
		const opened = await deps.store.openHold(lease, {
			subscriptionId,
			customerId: verdict.customerId,
			payerKey: verdict.payer,
			invoiceId: verdict.invoiceId,
			state: verdict.toOperator ? "needs_operator" : "closing",
			nextCheckAt: verdict.toOperator ? new Date(now.getTime() + 24 * 60 * 60_000) : now,
			openedBy: "backfill",
			openNote: verdict.evidence,
		});
		if (opened.kind !== "opened") {
			print(`LISTED ${subscriptionId}: the hold was not written (${opened.kind}).`);
			return "listed";
		}
		if (verdict.toOperator) {
			const alerted = await deps.sweepDeps.alert({
				subscriptionId,
				customerId: verdict.customerId,
				paymentIntentId: null,
				detail: `backfill held it for an operator: its invoice ${verdict.invoiceId} carries no PaymentIntent, so nothing proves it was paid by card (B5)`,
			});
			if (alerted) {
				await deps.store.writeHoldState(lease, { id: opened.hold.id, version: opened.hold.version }, { alertedAt: now });
			}
			print(`HELD ${subscriptionId}: hold ${opened.hold.id}, needs_operator (B5 unproven: no PaymentIntent)${alerted ? ", alerted" : ""}.`);
			return "to_operator";
		}
		const advanced = await advanceHold(opened.hold, deps.sweeper.machineDepsFor(lease, deps.sweepDeps));
		print(
			`HELD ${subscriptionId}: hold ${opened.hold.id}, ${advanced.hold.state}` +
				`${advanced.hold.release_reason ? `(${advanced.hold.release_reason})` : ""} after ${advanced.rows.join(" → ") || "no row"}.`,
		);
		return "held";
	} finally {
		await deps.lease.releasePurchaseLease(lease);
	}
}

/** Statuses under which a subscription still exists and may bill (ADR 0002 §2, "Live subscription"). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

/**
 * §8's S1-era listing: prints every setup closed with `closed_reason = org_has_plan` whose subscription
 * reads live, with its user and team, and returns how many. A read that fails is printed as such. It
 * holds nothing and writes nothing.
 */
export async function listLiveOrgHasPlanClosures(
	stripe: Pick<SweeperModule.HoldStripe, "subscriptions">,
	print: Print,
): Promise<number> {
	const closed = await getServiceDb()
		.select()
		.from(pendingOrgSetups)
		.where(eq(pendingOrgSetups.closed_reason, "org_has_plan"))
		.orderBy(desc(pendingOrgSetups.closed_at));
	let live = 0;
	for (const s of closed) {
		let status: string;
		try {
			status = (await stripe.subscriptions.retrieve(s.subscription_id)).status;
		} catch (err) {
			print(`S1-ERA ${s.subscription_id}: could not read it (${err instanceof Error ? err.message : String(err)})`);
			continue;
		}
		if (!LIVE_STATUSES.has(status)) continue;
		live += 1;
		print(
			`S1-ERA ${s.subscription_id}: reads ${status}, setup ${s.id} of user ${s.user_id}, team ${s.created_org_id ?? "none"}, ` +
				`closed ${s.closed_at?.toISOString() ?? "-"} as org_has_plan. Paid, live and unlinked: refund it or move it by hand.`,
		);
	}
	print(`S1-era closures: ${live} of ${closed.length} read live.`);
	return live;
}

/** `reconcile`: the backfill and the S1-era listing when asked, then one sweeper pass, printing its counts. */
export async function reconcile(
	input: { backfill: boolean; scope?: PaymentHoldScope; payer: string | undefined },
	deps: ServerDeps,
	stripe: BackfillStripe,
	print: Print,
): Promise<void> {
	if (input.backfill) {
		await runBackfill(deps, stripe, print);
		await listLiveOrgHasPlanClosures(deps.sweepDeps.stripe(), print);
	}
	const result = await deps.sweeper.runPaymentHoldSweep({ scope: input.scope, payerKey: input.payer, deps: deps.sweepDeps });
	print(`Sweep: ${JSON.stringify(result)}`);
}

/** Returns the value of `--name <v>` / `--name=<v>` from `argv`, or undefined. */
function arg(argv: readonly string[], name: string): string | undefined {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = argv.indexOf(`--${name}`);
	return idx !== -1 ? argv[idx + 1] : undefined;
}

/** The scope `--scope` names, or null when it names none of them. */
function scopeArg(value: string): PaymentHoldScope | null {
	return PAYMENT_HOLD_SCOPES.find((s) => s === value) ?? null;
}

const USAGE = [
	"Usage: billing:payment-holds <command>",
	"  list [--open] [--scope new_org|org_plan] [--payer <user or org id>]",
	"  show <subscription_id>",
	'  release <subscription_id> --reason "<why>" --operator <your user id>',
	'  release <subscription_id> --moved-to <team id> --reason "<why>" --operator <your user id>',
	"  reconcile [--backfill] [--scope new_org|org_plan] [--payer <user or org id>]",
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
	const [store, lease, sweeper, lock, sync, queries, setups, stripe] = await Promise.all([
		import("@/lib/billing/payment-holds/store"),
		import("@/lib/billing/purchase-lease"),
		import("@/lib/billing/payment-holds/sweeper"),
		import("@/lib/billing/purchase-lock"),
		import("@/lib/billing/sync"),
		import("@/lib/billing/queries"),
		import("@/lib/billing/pending-org-setup"),
		import("@/lib/billing/stripe"),
	]);
	return {
		store,
		lease,
		sweeper,
		sweepDeps: sweeper.liveSweepDeps(),
		moved: { lease, lock, sync, queries, setups, stripe: () => stripe.getPurchaseStripe() },
	};
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
	// `--scope` names one of the known scopes, or the command is refused before anything is read. A
	// `--scope` with no value is refused too: it must never read as "every scope".
	const hasScope = argv.some((a) => a === "--scope" || a.startsWith("--scope="));
	const scope = hasScope ? scopeArg(arg(argv, "scope") ?? "") : undefined;
	if (scope === null) {
		console.error(`--scope must be one of: ${PAYMENT_HOLD_SCOPES.join(", ")}.\n${USAGE}`);
		return 1;
	}
	try {
		if (command === "list") {
			await listHolds({ open: argv.includes("--open"), scope, payer: arg(argv, "payer") }, print);
			return 0;
		}
		if (command === "release" && subject) {
			// The refusals that need nothing loaded come first.
			if (!arg(argv, "reason")?.trim() || !arg(argv, "operator")?.trim()) {
				refuse(print, "release needs --reason \"<why>\" and --operator <your user id>.");
				return 1;
			}
			// `--moved-to` selects the moved release by its presence alone (§5.8); a missing value is refused here.
			const hasMovedTo = argv.some((a) => a === "--moved-to" || a.startsWith("--moved-to="));
			const movedTo = hasMovedTo ? (arg(argv, "moved-to") ?? "") : undefined;
			if (movedTo !== undefined && (movedTo.trim() === "" || movedTo.startsWith("--"))) {
				refuse(print, "--moved-to needs the id of the team support moved the subscription to.");
				return 1;
			}
			// Both ids reach a Stripe search query string on the moved path: refuse anything outside the id
			// charset before anything is read.
			if (movedTo !== undefined && (!isPlainId(subject) || !isPlainId(movedTo.trim()))) {
				refuse(print, "the subscription id and --moved-to may contain only letters, digits, '_' and '-'.");
				return 1;
			}
			const result = await releaseHoldCommand(
				{ subscriptionId: subject, reason: arg(argv, "reason"), operator: arg(argv, "operator"), movedTo },
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
			{ backfill: argv.includes("--backfill"), scope, payer: arg(argv, "payer") },
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
