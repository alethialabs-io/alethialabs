// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { type Money, money } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionRefusal } from "@/lib/actions/result";
import { authorizeQuiet, authorizeRead, currentActor } from "@/lib/authz/guard";
import { isBillingConfigured, isStripeConfigured } from "@/lib/billing/config";
import { paidSalesOpen } from "@/lib/billing/eligibility";
import { listOrgInvoices } from "@/lib/billing/invoices";
import { backupRankOf } from "@/lib/billing/payment-methods";
import { isManualGrantExpired, PAST_DUE_GRACE_MS } from "@/lib/billing/plan";
import { getAllAiPrices, getAllPlanPrices, getPlanPrice, type LiveAiPriceMap } from "@/lib/billing/pricing";
import { providerForOrg } from "@/lib/billing/provider/select";
import { getOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { readSubscription } from "@/lib/billing/subscription-cache";
import { mapStatus } from "@/lib/billing/sync";
import { getServiceDb } from "@/lib/db";
import { type Invoice, member, type OrganizationBilling, organization, type PaddleTransaction } from "@/lib/db/schema";
import type { BillingProviderId } from "@/lib/db/schema/billing-provider";
import { type BillingPlan, type BillingStatus, type InvoiceStatus, invoiceStatus } from "@/lib/db/schema/enums";
import {
	type InvoiceFacets,
	type InvoiceListRow,
	paddleInvoiceStatus,
	queryInvoicesPage,
	queryTransactionsPage,
	type TransactionInfo,
} from "@/lib/queries/billing";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetPageInput,
} from "@/lib/queries/keyset";
import { query } from "@/lib/rpc/base";
import {
	INVOICE_PAID_WITHIN,
	type InvoiceListParams,
	invoiceReaderFilters,
} from "@/lib/rpc/inputs/invoices";

// The billing domain's reads (#6127, ADR 0005 D1): the Billing settings page and its Invoices page.
// The bodies MOVED here from `app/server/actions/billing.ts`; they are plain functions, so other
// server code (the AI read tools, member invites, the CLI) calls them in-process. This file is the
// single owner of billing reads — the overview reads usage through `procedures/usage.ts`.

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Billing is a hosted-only surface: with no Stripe wired (self-managed, community) there are no
 * cards, charges or plan lifecycle to read. A read that needs Stripe REFUSES with a plan-gated
 * refusal (ENTITLEMENT_REQUIRED on the wire) — the page renders that as its own state, distinct
 * from an empty list and from a failure. It used to throw a plain Error, which a page could only
 * show as "something went wrong".
 */
function requireHostedRead(): void {
	if (!isStripeConfigured()) {
		throw new ActionRefusal(
			"entitlement",
			"Billing is not enabled on this deployment.",
			"hosted-billing",
		);
	}
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The single, coherent plan lifecycle state the billing card renders off — derived from the
 * live subscription so the badge, period wording, "next charge" line, and CTA can never
 * disagree. `canceling` = live but set to cancel at period end (show "Cancels …" + "Resume");
 * the rest map straight from `BillingStatus`.
 */
export type PlanState =
	| "none"
	| "trialing"
	| "active"
	| "canceling"
	| "past_due"
	| "canceled";

/** Collapses status + the cancel-at-period-end flag into one coherent lifecycle state. */
function derivePlanState(
	status: BillingStatus,
	cancelAtPeriodEnd: boolean,
): PlanState {
	if (cancelAtPeriodEnd && (status === "active" || status === "trialing")) {
		return "canceling";
	}
	return status;
}

/** Read-only billing state for the active org, for the /settings/billing page. */
export interface BillingSummary {
	/** Stripe is wired on this deployment (hosted). Self-managed → no upgrade UI. */
	hosted: boolean;
	/** The actor has a real workspace (org), not just their personal scope. */
	hasOrg: boolean;
	plan: BillingPlan;
	status: BillingStatus;
	/** The one coherent lifecycle state that drives every label + CTA on the plan card. */
	state: PlanState;
	/** ISO timestamp the current paid period ends, if subscribed. */
	currentPeriodEnd: string | null;
	/** A Stripe customer exists → cards/invoices are available. */
	canManage: boolean;
	/**
	 * The ACTOR holds `manage_billing` — the permission every card, charge, invoice and
	 * plan-history read requires. `canManage` above says whether the ORG has a billing account;
	 * this says whether this viewer may see it. The page shows the billing-admin sections only
	 * when both hold, so a member without the permission sees one plain note instead of four
	 * sections that each refuse.
	 */
	canManageBilling: boolean;
	/** The subscription is set to cancel at period end (show "resume"). */
	cancelAtPeriodEnd: boolean;
	/** Subscribed seat count (Team's per-seat quantity), or null for flat plans. */
	seats: number | null;
	/** Current members in the org — the "used" side of the seats meter. */
	memberCount: number;
	/**
	 * The actual per-seat (or flat) monthly amount the org is billed, in MINOR units WITH ITS
	 * CURRENCY — read live from the subscription's Stripe price (so a grandfathered sub shows its
	 * real amount), or the live plan price when there's no sub. null = custom/unknown. Stripe is
	 * authoritative; never compute the displayed amount from the catalog.
	 *
	 * THIS WAS `unitAmountUsd: number` PLUS A SEPARATE `currency: string` (#4176 part b). The name
	 * was false from the day the live-subscription branch read the price's own currency — a EUR
	 * subscription put euros in a field called `Usd` — and the separate `currency` was a second
	 * field a renderer had to remember to read. It is one value now, because the two halves were
	 * only ever meaningful together.
	 *
	 * IT ALSO DROPPED A `/ 100`. The old field held MAJOR units, divided out of Stripe's
	 * `unit_amount` by a hardcoded 100 right here and multiplied back up by a hardcoded 100 three
	 * renders later in `billing-panel.tsx`. The two cancelled for a two-decimal currency and
	 * nothing else: a ¥124,000 subscription would have travelled as 1240 and rendered as ¥124,000
	 * only because the second 100 undid the first. Minor units all the way through means the
	 * conversion has no halves to keep in step.
	 */
	unitAmount: Money | null;
	/**
	 * Which provider this org's billing goes through (`providerForOrg`): its own row's, else the
	 * instance's sales provider. Null when billing is not wired. Decides where the plan card's
	 * "update the payment method" goes — Stripe's in-page cards, or Paddle's customer portal.
	 */
	provider: BillingProviderId | null;
	/**
	 * For a Paddle subscription that is `past_due`: the ISO instant its 7-day grace ends (O8,
	 * `PAST_DUE_GRACE_MS`) — the paid features stay on until then. Null otherwise.
	 */
	pastDueGraceEndsAt: string | null;
}

/** Resolves the active org's billing state for display (read-only; any member). */
export async function getBillingSummary(): Promise<BillingSummary> {
	const actor = await currentActor();
	const hasOrg = actor.orgId !== actor.userId;
	const billing = hasOrg ? await getOrgBilling(actor.orgId) : null;

	// Member count seeds the seats meter; only meaningful in a real org.
	let memberCount = 0;
	if (hasOrg) {
		const [c] = await getServiceDb()
			.select({ n: count() })
			.from(member)
			.where(eq(member.organizationId, actor.orgId));
		memberCount = c?.n ?? 0;
	}
	// A probe, not a gate: a refusal here is an answer ("this viewer may not"), never a failure of
	// the summary. Only meaningful in a real org — the personal scope has no billing to manage.
	const canManageBilling = hasOrg
		? await authorizeQuiet("manage_billing", { type: "billing" })
				.then(() => true)
				.catch(() => false)
		: false;

	const plan = billing?.plan ?? "community";
	// Default to the DB row, then let a readable live subscription override the fields the
	// card renders (status / period / cancel flag) — so a stale or half-synced DB row can
	// never produce a self-contradictory card (e.g. "Canceled" next to "Renews …").
	let status: BillingStatus = billing?.status ?? "none";
	let cancelAtPeriodEnd = false;
	let currentPeriodEnd: string | null =
		billing?.currentPeriodEnd?.toISOString() ?? null;
	// Authoritative price: the subscription's OWN flat (non-metered) Stripe price — this
	// reflects what the org is actually charged, including grandfathered amounts.
	let unitAmount: Money | null = null;
	if (billing?.stripeSubscriptionId && isStripeConfigured()) {
		try {
			const sub = await readSubscription(
				billing.stripeSubscriptionId,
				billing.stripeSubscriptionEventAt,
			);
			status = mapStatus(sub.status);
			cancelAtPeriodEnd = sub.cancel_at_period_end;
			const flat = sub.items.data.find(
				(i) => i.price.recurring?.usage_type !== "metered",
			);
			// Only a LIVE (active/trialing) sub reflects what the org is actually billed. A
			// canceled/past_due sub has reverted to Hobby, so its old price must NOT leak
			// through (otherwise a canceled org shows "Hobby · $20/mo"). Same gate applies to
			// the period end — a lapsed sub shows no renewal/cancellation date.
			const live = status === "active" || status === "trialing";
			if (live && typeof flat?.price.unit_amount === "number") {
				// Stripe's `unit_amount` is already minor units, and so is `Money.minor` — no
				// conversion, which is the point of #4176 part (b). The currency is the price's
				// own, whatever Stripe says it is; nothing here narrows it.
				unitAmount = money(flat.price.unit_amount, flat.price.currency);
			}
			currentPeriodEnd =
				live && flat?.current_period_end
					? new Date(flat.current_period_end * 1000).toISOString()
					: null;
		} catch {
			// Subscription unreadable (deleted upstream) — fall back to the DB row.
		}
	}
	// A Paddle row is read from the row itself, which its webhook keeps (L3): a scheduled cancellation
	// is `cancel_effective_at`, a past-due subscription keeps its plan for the grace window, and a local
	// card-less trial past its end has lapsed to Hobby (`isManualGrantExpired`).
	const provider = providerForOrg(billing);
	let pastDueGraceEndsAt: string | null = null;
	let effectivePlan = plan;
	if (billing && provider === "paddle") {
		const paddle = paddleSummaryFields(billing);
		status = paddle.status;
		effectivePlan = paddle.plan;
		cancelAtPeriodEnd = paddle.cancelAtPeriodEnd;
		currentPeriodEnd = paddle.currentPeriodEnd;
		pastDueGraceEndsAt = paddle.pastDueGraceEndsAt;
	}
	// No live sub price (or no sub yet) → fall back to the plan's live Stripe price, in the
	// currency that price is denominated in. `amounts[currency]` rather than a `usd` field: the
	// fallback used to read `LivePlanPrice.unitAmountUsd` and label it `"usd"` by hand, which is
	// the same assumption one layer up. An org with no live sub sees the plan's base-currency
	// price; which currency it will actually be BILLED in is settled at checkout, not here.
	if (unitAmount === null && effectivePlan !== "community") {
		// Paddle's prices come from its pricing preview (getAllPlanPrices overlays them); Stripe's from
		// the plan's price as before.
		const price =
			provider === "paddle" ? (await getAllPlanPrices())[effectivePlan] : await getPlanPrice(effectivePlan);
		unitAmount = price.amounts[price.currency] ?? null;
	}

	return {
		// Provider-neutral: is billing a surface on this instance (the sales provider is configured).
		hosted: isBillingConfigured(),
		hasOrg,
		plan: effectivePlan,
		status,
		state: derivePlanState(status, cancelAtPeriodEnd),
		currentPeriodEnd,
		canManage: Boolean(billing?.stripeCustomerId),
		canManageBilling,
		cancelAtPeriodEnd,
		seats: billing?.seats ?? null,
		memberCount,
		unitAmount,
		provider,
		pastDueGraceEndsAt,
	};
}

/** The plan-card fields of a Paddle-routed billing row (pure; `now` for the grace and lapse checks). */
export function paddleSummaryFields(
	billing: Pick<
		OrganizationBilling,
		| "plan"
		| "status"
		| "currentPeriodStart"
		| "currentPeriodEnd"
		| "cancelEffectiveAt"
		| "stripeSubscriptionId"
		| "paddleSubscriptionId"
	>,
	now: Date = new Date(),
): {
	plan: BillingPlan;
	status: BillingStatus;
	cancelAtPeriodEnd: boolean;
	currentPeriodEnd: string | null;
	pastDueGraceEndsAt: string | null;
} {
	if (isManualGrantExpired(billing, now)) {
		return { plan: "community", status: "none", cancelAtPeriodEnd: false, currentPeriodEnd: null, pastDueGraceEndsAt: null };
	}
	const live = billing.status === "active" || billing.status === "trialing";
	const cancelAtPeriodEnd = live && billing.cancelEffectiveAt != null;
	const end = cancelAtPeriodEnd ? billing.cancelEffectiveAt : live ? billing.currentPeriodEnd : null;
	const graceEnd =
		billing.status === "past_due" && billing.currentPeriodStart
			? new Date(billing.currentPeriodStart.getTime() + PAST_DUE_GRACE_MS)
			: null;
	return {
		plan: billing.plan,
		status: billing.status,
		cancelAtPeriodEnd,
		currentPeriodEnd: end?.toISOString() ?? null,
		pastDueGraceEndsAt: graceEnd && graceEnd.getTime() > now.getTime() ? graceEnd.toISOString() : null,
	};
}

// ── Payment methods ───────────────────────────────────────────────────────────────────────────────

/** A saved card for the active org's billing UI. */
export interface PaymentMethodInfo {
	id: string;
	brand: string;
	last4: string;
	expMonth: number;
	expYear: number;
	isDefault: boolean;
	/** Backup order (0-based) for dunning failover; null when this card isn't a backup. */
	backupRank: number | null;
}

/** Lists the active org's saved cards (with which one is the default). */
export async function listPaymentMethods(): Promise<PaymentMethodInfo[]> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	requireHostedRead();
	const billing = await getOrgBilling(actor.orgId);
	if (!billing?.stripeCustomerId) return [];

	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(billing.stripeCustomerId);
	const defaultRef =
		"deleted" in customer
			? null
			: customer.invoice_settings.default_payment_method;
	const defaultId =
		typeof defaultRef === "string" ? defaultRef : (defaultRef?.id ?? null);

	const pms = await stripe.paymentMethods.list({
		customer: billing.stripeCustomerId,
		type: "card",
	});
	return pms.data
		.map((pm) => ({
			id: pm.id,
			brand: pm.card?.brand ?? "card",
			last4: pm.card?.last4 ?? "••••",
			expMonth: pm.card?.exp_month ?? 0,
			expYear: pm.card?.exp_year ?? 0,
			isDefault: pm.id === defaultId,
			backupRank: backupRankOf(pm),
		}))
		// Default (primary) first, then ranked backups ascending, then any unranked cards.
		.sort((a, b) => {
			if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
			const ar = a.backupRank ?? Number.MAX_SAFE_INTEGER;
			const br = b.backupRank ?? Number.MAX_SAFE_INTEGER;
			return ar - br;
		});
}

// ── Invoices ──────────────────────────────────────────────────────────────────────────────────────

/** An invoice row for the billing UI — sourced from our locally-mirrored `invoice` table
 *  (only invoices for which money moved), never a live Stripe API call; for a Paddle customer,
 *  also Paddle's invoices from the `paddle_transaction` mirror (`paddleTransactionToInvoiceInfo`). */
export interface InvoiceInfo {
	/** Our invoice id, or a Paddle transaction id (`txn_…`) — either way the preview + PDF-download route's key. */
	id: string;
	/** The фактура's number — null until `facturaIssued`, never Stripe's invoice number. */
	number: string | null;
	/** Total in the smallest currency unit (e.g. cents). */
	total: number;
	currency: string;
	status: InvoiceStatus;
	/** ISO instant the invoice was paid — the primary display/sort date. */
	paidAt: string;
	/** Billing period the invoice covers (ISO), if known. */
	periodStart: string | null;
	periodEnd: string | null;
	description: string | null;
	/**
	 * Our фактура is issued and its PDF is stored, so the PDF route can serve it. False means the
	 * invoice is still being issued (EA-7c, #7341): pending, failed and awaiting an operator, or a
	 * row mirrored before the фактура pipeline existed.
	 */
	facturaIssued: boolean;
}

/**
 * Whether a mirrored row carries OUR issued фактура. Both halves are required: `factura_status`
 * is `issued` only when the console issued the document (lib/billing/invoices.ts), and a row
 * mirrored before that pipeline (status NULL) may still hold a `pdf_key` to a captured Stripe PDF
 * or only Stripe's hosted URL — neither is the customer's invoice, so such a row reads as being
 * issued. `hostedInvoiceUrl` is deliberately not read and not returned.
 */
function isFacturaIssued(row: Invoice): boolean {
	return row.facturaStatus === "issued" && Boolean(row.pdfKey);
}

/** Maps a mirrored invoice row to the UI shape. */
function toInvoiceInfo(row: Invoice): InvoiceInfo {
	const facturaIssued = isFacturaIssued(row);
	return {
		id: row.id,
		number: facturaIssued ? row.number : null,
		total: row.amountTotal,
		currency: row.currency,
		status: row.status,
		paidAt: (row.paidAt ?? row.createdAt).toISOString(),
		periodStart: row.periodStart?.toISOString() ?? null,
		periodEnd: row.periodEnd?.toISOString() ?? null,
		description: row.description,
		facturaIssued,
	};
}

export type { InvoiceListParams } from "@/lib/rpc/inputs/invoices";

// NO hosted-billing guard on this read, and its absence is the fix for the HTTP 500 the UI
// conformance audit recorded on `~/settings/billing/invoices` (#3731).
//
// It reads the MIRRORED `invoice` table this deployment already owns and makes no Stripe call.
// Refusing to READ mirrored history because Stripe is not wired is wrong on its own terms — an
// org that once paid keeps its invoices, and an org that never did simply has none, which is an
// empty list, not an error.

/**
 * Lists the active org's Stripe-era invoices (newest paid first) from the local `invoice` mirror — no
 * Stripe call, so only real paid invoices — filterable by period range + status and bounded by
 * `limit`. It does NOT list Paddle invoices: the billing UI reads {@link readInvoicesPage}, which
 * pages this mirror and the `paddle_transaction` mirror together in SQL. (It used to add Paddle's
 * invoices from a LIVE Paddle read; nothing in the UI called that after #7528, so it went, #7672.)
 */
export async function listInvoices(
	params: InvoiceListParams = {},
): Promise<InvoiceInfo[]> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	const rows = await listOrgInvoices(actor.orgId, invoiceReaderFilters(params));
	return rows.map(toInvoiceInfo);
}

/**
 * A mirrored Paddle invoice (`paddle_transaction`, billed or completed — Paddle is the merchant of
 * record) in the list's shape. Its id is Paddle's (`txn_…`), the PDF route's key for Paddle's own
 * PDF; the row's uuid only orders the list. With an invoice number it is downloadable, as an issued
 * фактура is.
 */
export function paddleTransactionToInvoiceInfo(row: PaddleTransaction): InvoiceInfo {
	return {
		id: row.paddleTransactionId,
		number: row.invoiceNumber,
		total: row.totalMinor,
		currency: row.currency.toLowerCase(),
		status: paddleInvoiceStatus(row),
		paidAt: (row.billedAt ?? row.createdAt).toISOString(),
		periodStart: row.billingPeriodStart?.toISOString() ?? null,
		periodEnd: row.billingPeriodEnd?.toISOString() ?? null,
		description: null,
		facturaIssued: row.invoiceNumber !== null,
	};
}

/** One invoices-list row, of either source, in the UI shape. */
function invoiceListRowToInfo(row: InvoiceListRow): InvoiceInfo {
	return row.source === "invoice" ? toInvoiceInfo(row.invoice) : paddleTransactionToInvoiceInfo(row.transaction);
}

/**
 * One page of the active org's invoices — the Stripe-era mirror plus the mirrored Paddle invoices —
 * newest first, filtered by status and paid-date range SERVER-SIDE (`queryInvoicesPage`), with the
 * status facet over both sources' unfiltered invoices on the first page. The Invoices page reads
 * this; it used to read up to 500 rows in one go and page them in the browser (#7493). No Stripe
 * and no Paddle call: both sources are local mirrors kept by their webhooks.
 */
export async function readInvoicesPage(
	params: Omit<InvoiceListParams, "limit">,
	request: KeysetPageRequest,
): Promise<KeysetListPage<InvoiceInfo, InvoiceFacets>> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	const page = await queryInvoicesPage(actor.orgId, invoiceReaderFilters(params), request);
	return { ...page, rows: page.rows.map(invoiceListRowToInfo) };
}

// ── Transactions (Stripe charges) ─────────────────────────────────────────────────────────────────

export type { TransactionInfo } from "@/lib/queries/billing";

/**
 * One page of the active org's charges (paid / failed / refunded) for the ledger, newest first,
 * through Stripe's own cursor (`queryTransactionsPage`). Every charge is reachable: this used to
 * read `limit: 24` and nothing after it (#7493).
 */
export async function readTransactionsPage(
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<KeysetListPage<TransactionInfo, null>> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	requireHostedRead();
	const billing = await getOrgBilling(actor.orgId);
	return queryTransactionsPage(billing?.stripeCustomerId ?? null, request);
}

/**
 * The active org's NEWEST charges — the first page of {@link readTransactionsPage}, for an
 * in-process caller that wants a glance rather than the ledger. The ledger itself pages.
 */
export async function listTransactions(): Promise<TransactionInfo[]> {
	return (await readTransactionsPage()).rows;
}

// ── Plan history (minimal — derived, no event log yet) ────────────────────────────────────────────

/** A plan-history timeline entry. */
export interface PlanHistoryEntry {
	when: string;
	title: string;
	detail: string;
	/** The current (most recent) entry — rendered as the active node. */
	current: boolean;
}

/**
 * A best-effort plan-history timeline for the active org. We don't keep a billing
 * event log yet, so this is derived honestly from what we know: when the org was
 * created, and the plan it's on now. (A real ledger is future work.)
 */
export async function getPlanHistory(): Promise<PlanHistoryEntry[]> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	// No Stripe call below: any hosted rail (Stripe, or a Paddle sales provider) may read it.
	if (!isBillingConfigured()) requireHostedRead();
	if (actor.orgId === actor.userId) return [];

	const [org] = await getServiceDb()
		.select({ name: organization.name, createdAt: organization.createdAt })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	if (!org) return [];

	const billing = await getOrgBilling(actor.orgId);
	const entries: PlanHistoryEntry[] = [
		{
			when: org.createdAt.toISOString(),
			title: "Organization created",
			detail: `${org.name} started on the Hobby plan.`,
			current: false,
		},
	];
	const isLive =
		billing && (billing.status === "active" || billing.status === "trialing");
	if (isLive && billing.plan !== "community") {
		const meta = planMeta(billing.plan);
		const since =
			billing.currentPeriodEnd?.toISOString() ?? new Date().toISOString();
		entries.push({
			when: since,
			title: `On the ${meta.name} plan`,
			detail: meta.tagline,
			current: true,
		});
	} else {
		// No live paid plan → the "created" entry is the current state.
		entries[0].current = true;
	}
	return entries.reverse(); // newest first
}

// ── Live AI prices ────────────────────────────────────────────────────────────────────────────────

/**
 * Live prices for every standalone AI tier (Stripe-authoritative, catalog fallback). The AI
 * section's tier price line reads this over GET so its first paint carries the live figure.
 * Signed-in only (the route handler resolved the actor): each call is several Stripe price reads,
 * so an anonymous caller could spend the rate limit checkout depends on (#5219).
 */
async function readLiveAiPrices(): Promise<LiveAiPriceMap> {
	return getAllAiPrices();
}

// ── Is Pro on sale ────────────────────────────────────────────────────────────────────────────────

/**
 * Whether Pro is on sale anywhere — the upgrade sheet's first question (#6132, F030). The answer is
 * the same for every org (the market is a property of the product, not the tenant); it is a read
 * procedure so the sheet asks it over GET like every other read, signed-in only because the route
 * handler resolved the actor before this runs.
 */
function readSalesOpen(): { open: boolean } {
	return { open: paidSalesOpen() };
}

// ── Inputs + router ───────────────────────────────────────────────────────────────────────────────

/** The invoices list's filters, as the page builds them (`normalizeInvoiceQuery`). */
const invoiceFilterFields = {
	status: z.array(z.enum(invoiceStatus.enumValues)).max(10).optional(),
	paidWithin: z.enum(INVOICE_PAID_WITHIN).optional(),
	paidFrom: z.iso.datetime().optional(),
	paidTo: z.iso.datetime().optional(),
};

/**
 * The invoices read: the filters plus the paging contract (`keysetPageInput`: an opaque cursor,
 * a malformed one a 400; `limit` defaulting to 50 and refused above 100). The Billing page's
 * five-row preview reads the first page with `limit: 5`; the Invoices page walks every page.
 */
const invoicesInput = z.object({ ...invoiceFilterFields, ...keysetPageInput("uuid") });

/**
 * The transaction history's input: only the paging contract (the cursor's id is a Stripe charge
 * id, so text-kind). Optional as a whole, so a caller that names nothing reads the first page.
 */
const transactionsInput = z.object(keysetPageInput("text")).optional();

/** The billing domain's read procedures (ADR 0005 D1). */
export const billingRouter = {
	summary: query.handler(() => getBillingSummary()),
	paymentMethods: query.handler(() => listPaymentMethods()),
	invoices: query
		.input(invoicesInput)
		.handler(({ input: { cursor, limit, ...filters } }) => readInvoicesPage(filters, { cursor, limit })),
	transactions: query.input(transactionsInput).handler(({ input }) => readTransactionsPage(input)),
	planHistory: query.handler(() => getPlanHistory()),
	liveAiPrices: query.handler(() => readLiveAiPrices()),
	salesOpen: query.handler(() => readSalesOpen()),
};
