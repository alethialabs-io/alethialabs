// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0002 S9 (#5937): the link and the resume lookups on payment holds — the A cases of §5.6.
//
// The link runs for real, and so do its core (`linkSetupToOrg`, lib/billing/payment-holds/sweeper.ts),
// the re-link after an adoption (`relinkAdoptedSetup`) and `advanceHold`. What is faked is what they
// write through:
//   - STRIPE is a small stateful world (`world`): what a write changes, the next read sees.
//   - THE HOLD STORE is an in-memory table with the store's compare-and-set on `version`; its SQL is
//     pinned against Postgres in tests/integration/payment-holds.test.ts.
//   - THE SETUP RECORD MODULE is mocked over an in-memory `pending_org_setups` (`world.setups`) whose
//     writes keep the module's predicates: a close only while the setup is open and no hold is open on
//     its subscription (I16), a mark only while it is not closed. Its SQL is pinned in
//     tests/integration/pending-org-setups.test.ts.
//   - THE ORG'S BILLING ROW is one value (`world.row`), and the sync applies a subscription to it the
//     way #5518's guard does for these cases: it takes a row that names nothing live, or names it.
//
// On dev every case here but C60 and C77 fails on its assertion: the link there consults no hold,
// closes the setup on every refusal, and the lookups report no hold.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentHoldRow } from "@/lib/db/schema";
import type { PendingOrgSetupRow } from "@/lib/billing/pending-org-setup";

/** A subscription as the fake Stripe holds it. */
interface FakeSub {
	id: string;
	status: string;
	customer: string;
	latest_invoice: string;
	metadata: Record<string, string>;
	currency: string;
	created: number;
	items: { data: never[] };
}

const world = vi.hoisted(() => {
	const state = {
		subs: new Map<string, FakeSub>(),
		/** invoice id → status */
		invoices: new Map<string, string>(),
		/** invoice id → its hosted page */
		hosted: new Map<string, string>(),
		/** invoice id → the statuses of its PaymentIntents */
		payments: new Map<string, string[]>(),
		customers: new Map<string, { created_by: string; organization_id?: string }>(),
		holds: [] as PaymentHoldRow[],
		setups: new Map<string, PendingOrgSetupRow>(),
		/** The org's billing row: the subscription it names and that subscription's status. */
		row: null as null | { stripeSubscriptionId: string | null; status: string; stripeCustomerId: string },
		/** Runs when `subscriptions.update` lands: a race the test stages. */
		onUpdate: null as null | (() => void),
		/** The org (`created_org_id` or marker) of a setup. */
		orgOf: new Map<string, string>(),
		/** Whether the setup's creator holds manage_billing in the org (the sessionless check). */
		manageBilling: true,
		/** The org the scope resolver lands on when asked for another (a substitution), or null. */
		scopeOrg: null as string | null,
		/** Whether the org rows exist, and the org's members, as the read-only re-link lookup reads them. */
		orgExists: true,
		members: [{ userId: "user-1", status: "active" }] as { userId: string; status: string }[],
		/** Every direct database write the paths under test made (an INSERT of a member would land here). */
		dbWrites: [] as string[],
		/**
		 * `alert_deliveries`: one row per alert that reached a channel (what `emitAlertEvent` inserts). A
		 * `dead` row is one whose delivery failed for good; the dedupe's read skips it (`ne(status, 'dead')`).
		 */
		deliveries: [] as { id: string; resource_id: string; status?: string }[],
		/** The lease is gone when the store opens a hold (the lease row's FOR SHARE read finds nothing). */
		openLeaseLost: false,
		/** The next subscription the sweep's machine reads goes `active`: its payment landed. */
		activatesOnRead: null as string | null,
	};
	const missing = () => Object.assign(new Error("No such object"), { code: "resource_missing" });
	const intent = (invoice: string, i: number, status: string) => ({
		id: `pi_${invoice}_${i}`,
		status,
		amount_received: status === "succeeded" ? 1000 : 0,
	});
	const stripe = {
		subscriptions: {
			retrieve: vi.fn(async (id: string) => {
				const sub = state.subs.get(id);
				if (!sub) throw missing();
				if (state.activatesOnRead === id) {
					sub.status = "active";
					state.payments.set(sub.latest_invoice, ["succeeded"]);
					state.invoices.set(sub.latest_invoice, "paid");
					state.activatesOnRead = null;
				}
				return { ...sub, metadata: { ...sub.metadata } };
			}),
			update: vi.fn(async (id: string, params: { metadata: Record<string, string> }) => {
				const sub = state.subs.get(id);
				if (!sub) throw missing();
				sub.metadata = { ...sub.metadata, ...params.metadata };
				state.onUpdate?.();
				return { ...sub, metadata: { ...sub.metadata } };
			}),
			cancel: vi.fn(async (id: string) => {
				const sub = state.subs.get(id);
				if (!sub) throw missing();
				sub.status = "canceled";
				return { ...sub };
			}),
			list: vi.fn(async (p: { customer: string; status: string }) => ({
				has_more: false,
				data: [...state.subs.values()].filter((s) => s.customer === p.customer && (p.status === "all" || s.status === p.status)),
			})),
			create: vi.fn(async () => ({
				id: "sub_new",
				latest_invoice: { id: "in_new", confirmation_secret: { client_secret: "cs_new" } },
			})),
			search: vi.fn(async () => ({ data: [] })),
		},
		customers: {
			retrieve: vi.fn(async (id: string) => {
				const c = state.customers.get(id);
				if (!c) throw missing();
				return { id, deleted: false, metadata: { ...c } };
			}),
			update: vi.fn(async (id: string, params: { metadata: { created_by: string; organization_id: string } }) => {
				state.customers.set(id, { ...params.metadata });
				return { id };
			}),
			create: vi.fn(async () => ({ id: "cus_created" })),
		},
		invoices: {
			retrieve: vi.fn(async (id: string) => {
				const status = state.invoices.get(id);
				if (status === undefined) throw missing();
				return { id, status, hosted_invoice_url: state.hosted.get(id) ?? null };
			}),
			voidInvoice: vi.fn(async (id: string) => {
				const status = state.invoices.get(id);
				if (status !== "open" && status !== "uncollectible") throw new Error("You can only void open invoices.");
				state.invoices.set(id, "void");
				return { id, status: "void" };
			}),
			del: vi.fn(async () => ({})),
		},
		invoicePayments: {
			list: vi.fn(async (p: { invoice: string }) => ({
				has_more: false,
				data: (state.payments.get(p.invoice) ?? []).map((status, i) => ({
					status: status === "succeeded" ? "paid" : "open",
					payment: { type: "payment_intent", payment_intent: intent(p.invoice, i, status) },
				})),
			})),
		},
		paymentIntents: {
			retrieve: vi.fn(async () => {
				throw missing();
			}),
			cancel: vi.fn(async () => ({})),
		},
		refunds: {
			list: vi.fn(async () => ({ has_more: false, data: [] })),
			create: vi.fn(async () => ({})),
		},
	};
	return { state, stripe };
});

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
	authorizeInOrg: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
	authorizeQuiet: vi.fn(),
}));
// The sessionless manage_billing check (`holdsManageBilling`): the scope resolves to the org named, and
// the PDP answers what the test says.
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string, orgId?: string) => ({ userId, orgId: world.state.scopeOrg ?? orgId ?? userId })),
}));
vi.mock("@/lib/authz", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/authz")>();
	return { ...actual, getPdp: () => ({ can: async () => ({ allowed: world.state.manageBilling }) }) };
});
// The direct reads in these paths, by table: `organization` answers the org (while `orgExists`), `member`
// answers `world.members`, and everything else (the payer declaration, a billing row) answers nothing.
// Every write is recorded in `dbWrites` and changes nothing.
vi.mock("@/lib/db", async () => {
	const schema = await import("@/lib/db/schema");
	let table: unknown = null;
	const chain: Record<string, unknown> = {};
	for (const m of ["select", "where", "limit", "innerJoin", "set", "orderBy", "returning", "values", "onConflictDoNothing"]) chain[m] = () => chain;
	chain.from = (t: unknown) => {
		table = t;
		return chain;
	};
	for (const w of ["update", "insert", "delete", "execute"]) {
		chain[w] = () => {
			world.state.dbWrites.push(w);
			table = null;
			return chain;
		};
	}
	chain.then = (resolve: (v: unknown[]) => unknown) => {
		const rows =
			table === schema.organization && world.state.orgExists
				? [{ id: "org-1", slug: "acme", metadata: null }]
				: table === schema.member
					? world.state.members.map((m) => ({ ...m }))
					: table === schema.alertDeliveries
						? world.state.deliveries.filter((d) => d.status !== "dead").map((d) => ({ ...d }))
						: [];
		table = null;
		return Promise.resolve(rows).then(resolve);
	};
	return { getServiceDb: () => chain };
});
vi.mock("@/lib/billing/queries", () => ({
	getOrgBilling: vi.fn(async () => (world.state.row ? { ...world.state.row } : null)),
	upsertOrgBilling: vi.fn(),
}));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => world.stripe,
	getPurchaseStripe: () => world.stripe,
	STRIPE_REQUEST_TIMEOUT_MS: 20_000,
	STRIPE_MAX_NETWORK_RETRIES: 1,
}));
vi.mock("@/lib/billing/sync", () => ({
	mapStatus: vi.fn(),
	syncSubscriptionToBilling: vi.fn(async (sub: { id: string; status: string; customer: string }) => {
		const row = world.state.row;
		const takes = !row || row.stripeSubscriptionId === sub.id || !["active", "trialing", "past_due"].includes(row.status);
		if (!takes) return "ignored";
		world.state.row = { stripeSubscriptionId: sub.id, status: sub.status === "incomplete" ? "none" : sub.status, stripeCustomerId: sub.customer };
		return "applied";
	}),
}));
// An alert reaches one channel, and leaves its delivery row, as the real emitter's insert does.
vi.mock("@/lib/alerts/emit", () => ({
	emitAlertEvent: vi.fn(async (_org: string, _event: string, context: { resource_id?: string }) => {
		world.state.deliveries.push({ id: `delivery_${world.state.deliveries.length + 1}`, resource_id: context.resource_id ?? "" });
		return 1;
	}),
	emitAlertEventSafe: vi.fn(),
}));
vi.mock("@/lib/billing/purchase-lease", () => {
	class PurchaseLeaseLostError extends Error {}
	return {
		PurchaseLeaseLostError,
		UNFENCED: async () => undefined,
		renewPurchaseLease: async () => true,
		fenceFor: () => async () => undefined,
		tryAcquirePurchaseLease: vi.fn(),
		releasePurchaseLease: vi.fn(),
		withPurchaseLease: async <T,>(key: string, fn: (lease: { key: string; holder: string }) => Promise<T>) => ({
			acquired: true,
			value: await fn({ key, holder: "holder-1" }),
		}),
	};
});
vi.mock("@/lib/billing/eligibility", () => ({
	assertOrgPaidConversionAllowed: vi.fn(async () => undefined),
	assertPaidConversionAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/config", () => ({
	deploymentMode: vi.fn(() => "self-managed"),
	getStripeConfig: vi.fn(() => ({ appUrl: "https://app.test" })),
	isStripeConfigured: vi.fn(() => true),
	isStripeTaxEnabled: vi.fn(() => false),
	meterPriceIdForPlan: vi.fn(() => undefined),
	priceIdForPlan: vi.fn((plan: string) => `price_${plan}`),
	aiPriceIdForTier: vi.fn((tier: string) => `price_${tier}`),
	planForPriceId: vi.fn(() => null),
	getPublishableKey: vi.fn(() => ""),
	RUNNER_MINUTES_METER_EVENT: "alethia_runner_minutes",
}));
vi.mock("@/lib/billing/currency", () => ({ currencyFromRequest: vi.fn(async () => "eur") }));

/** The in-memory `payment_holds`: the store's writes, each a compare-and-set on `version`. */
vi.mock("@/lib/billing/payment-holds/store", () => {
	const find = (ref: { id: string; version: number }) =>
		world.state.holds.find((h) => h.id === ref.id && h.version === ref.version && h.state !== "released");
	return {
		payerLeaseKey: (payer: string) => `user:${payer}`,
		openHold: vi.fn(
			async (
				_lease: unknown,
				input: { subscriptionId: string; customerId: string; payerKey: string; invoiceId: string; state: PaymentHoldRow["state"]; openedBy: PaymentHoldRow["opened_by"]; openNote?: string | null },
			) => {
				if (world.state.openLeaseLost) return { kind: "lease_lost" };
				const open = world.state.holds.find((h) => h.subscription_id === input.subscriptionId && h.state !== "released");
				if (open) return { kind: "already_open", hold: { ...open } };
				const hold = holdRow({
					id: `hold_${world.state.holds.length + 1}`,
					subscription_id: input.subscriptionId,
					customer_id: input.customerId,
					payer_key: input.payerKey,
					invoice_id: input.invoiceId,
					state: input.state,
					opened_by: input.openedBy,
					open_note: input.openNote ?? null,
				});
				world.state.holds.push(hold);
				return { kind: "opened", hold: { ...hold } };
			},
		),
		writeHoldState: vi.fn(async (_lease: unknown, ref: { id: string; version: number }, patch: Record<string, unknown>) => {
			const hold = find(ref);
			if (!hold) return null;
			Object.assign(hold, {
				...(patch.state !== undefined && patch.state !== hold.state ? { state: patch.state, state_since: new Date() } : {}),
				...(patch.lastPay !== undefined ? { last_pay: patch.lastPay } : {}),
				...(patch.alertedAt !== undefined ? { alerted_at: patch.alertedAt } : {}),
				...(patch.nextCheckAt !== undefined ? { next_check_at: patch.nextCheckAt } : {}),
				version: hold.version + 1,
			});
			return { ...hold };
		}),
		reserveRefundAttempt: vi.fn(async () => null),
		// A release decides the setup (§4.1): any reason but `adopted` closes the still-open setup.
		releaseHold: vi.fn(async (_lease: unknown, ref: { id: string; version: number }, input: { reason: PaymentHoldRow["release_reason"]; lastPay?: string | null }) => {
			const hold = find(ref);
			if (!hold) return null;
			Object.assign(hold, { state: "released", release_reason: input.reason, released_at: new Date(), next_check_at: null, version: hold.version + 1 });
			const setup = world.state.setups.get(hold.subscription_id);
			let closedSetupId: string | null = null;
			if (input.reason !== "adopted" && setup && !setup.closed_at && !setup.linked_at) {
				Object.assign(setup, { closed_at: new Date(), closed_reason: "hold_released" });
				closedSetupId = setup.id;
			}
			return { hold: { ...hold }, closedSetupId };
		}),
		nudgeHold: vi.fn(),
		claimHoldNotice: vi.fn(),
		unclaimHoldNotice: vi.fn(),
	};
});

vi.mock("@/lib/billing/pending-org-setup", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/billing/pending-org-setup")>();
	const openHoldOn = (sub: string) => world.state.holds.some((h) => h.subscription_id === sub && h.state !== "released");
	const isOpen = (s: PendingOrgSetupRow) => !s.closed_at && !s.linked_at;
	return {
		pendingOrgSetupBillingSchema: actual.pendingOrgSetupBillingSchema,
		pendingOrgSetupSlugSchema: actual.pendingOrgSetupSlugSchema,
		REPLACEABLE_SUBSCRIPTION_STATUSES: actual.REPLACEABLE_SUBSCRIPTION_STATUSES,
		UNLINKED_SETUP_CUSTOMER_CAP: actual.UNLINKED_SETUP_CUSTOMER_CAP,
		FORGETTABLE_RELEASES: actual.FORGETTABLE_RELEASES,
		logBillingEvent: actual.logBillingEvent,
		pendingOrgSetupFor: vi.fn(async (userId: string, sub: string) => {
			const s = world.state.setups.get(sub);
			return s && s.user_id === userId ? { ...s } : null;
		}),
		closePendingOrgSetup: vi.fn(async (input: { subscriptionId: string; reason: PendingOrgSetupRow["closed_reason"]; refusedReason?: PendingOrgSetupRow["refused_reason"] }) => {
			const s = world.state.setups.get(input.subscriptionId);
			if (!s || !isOpen(s) || openHoldOn(input.subscriptionId)) return null;
			Object.assign(s, { closed_at: new Date(), closed_reason: input.reason, refused_reason: input.refusedReason ?? s.refused_reason });
			return { ...s };
		}),
		recordSetupRefusal: vi.fn(async (input: { userId: string; subscriptionId: string; refused: PendingOrgSetupRow["refused_reason"]; close: boolean }) => {
			const s = world.state.setups.get(input.subscriptionId);
			if (!s || s.user_id !== input.userId || !isOpen(s)) return null;
			if (input.close && !openHoldOn(input.subscriptionId)) {
				Object.assign(s, { closed_at: new Date(), closed_reason: "ended", refused_reason: input.refused });
				return { ...s };
			}
			s.refused_reason = input.refused;
			return null;
		}),
		markPendingOrgSetupLinked: vi.fn(async (userId: string, sub: string, orgId: string) => {
			const s = world.state.setups.get(sub);
			if (s && s.user_id === userId && !s.closed_at) Object.assign(s, { linked_at: new Date(), created_org_id: orgId });
		}),
		settleOpenSetup: vi.fn(async () => "open"),
		findSetupOrg: vi.fn(async (row: PendingOrgSetupRow) => {
			const id = world.state.orgOf.get(row.subscription_id);
			return id ? { id, slug: "acme" } : null;
		}),
		latestReleasedHoldOn: vi.fn(async (sub: string) => {
			const released = world.state.holds.filter((x) => x.subscription_id === sub && x.state === "released");
			return released.length > 0 ? { ...released[released.length - 1] } : null;
		}),
		openPaymentHoldOn: vi.fn(async (sub: string) => {
			const h = world.state.holds.find((x) => x.subscription_id === sub && x.state !== "released");
			return h ? { ...h } : null;
		}),
		paymentHoldsOfPayer: vi.fn(async (payer: string) => world.state.holds.filter((h) => h.payer_key === payer && h.state !== "released").map((h) => ({ ...h }))),
		openPendingOrgSetupsForOrg: vi.fn(async (orgId: string) =>
			[...world.state.setups.values()].filter((s) => isOpen(s) && world.state.orgOf.get(s.subscription_id) === orgId),
		),
		unfinishedPendingOrgSetups: vi.fn(async (userId: string) => ({
			rows: [...world.state.setups.values()].filter((s) => s.user_id === userId && !s.declared_at),
			next: null,
		})),
		forgetPendingOrgSetup: vi.fn(async () => false),
		markPendingOrgSetupDeclared: vi.fn(),
		recordPendingOrgSetup: vi.fn(),
		savePendingOrgSetupDetails: vi.fn(),
		unlinkedPendingOrgSetupCustomers: vi.fn(async () => ({ kind: "all", customers: [] })),
		liveCheckSetupCustomers: vi.fn(async () => ({ kind: "all", customers: [] })),
	};
});

import {
	createNewOrgSubscriptionIntent,
	createSubscriptionIntent,
	findUnfinishedNewOrgSetup,
	linkSubscriptionToNewOrg,
	resolveNewOrgSetup,
} from "@/app/server/actions/billing";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { liveCheckSetupCustomers, settleOpenSetup } from "@/lib/billing/pending-org-setup";
import { advanceHold } from "@/lib/billing/payment-holds/machine";
import { liveSweepDeps, machineDepsFor, relinkAdoptedSetup } from "@/lib/billing/payment-holds/sweeper";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";

const LEASE = { key: "user:user-1", holder: "holder-1" };
const ALERTED = /We have raised this with support\.$/;
const ORG_HAS_PLAN = /^This team already has an active plan, so this payment was not linked to it\./;

/** A full `payment_holds` row, with `overrides`. */
function holdRow(overrides: Partial<PaymentHoldRow>): PaymentHoldRow {
	const now = new Date(Date.now() - 60_000);
	return {
		id: "hold_seed",
		subscription_id: "sub_x",
		customer_id: "cus_x",
		payer_key: "user-1",
		invoice_id: "in_sub_x",
		payment_intent_id: null,
		state: "closing",
		release_reason: null,
		released_at: null,
		released_by: null,
		release_note: null,
		refund_attempt: 0,
		attempts: 0,
		last_error: null,
		next_check_at: now,
		alerted_at: null,
		notice_last_sent_at: null,
		notified_state: null,
		notified_at: null,
		opened_by_user_id: "user-1",
		opened_by: "purchase",
		open_note: null,
		state_since: now,
		last_pay: null,
		refund_action_since: null,
		age_alerted_at: null,
		observed_at: now,
		nudged_at: null,
		version: 0,
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

/** Puts X (user-1's create-a-team subscription on cus_x) into Stripe, its first invoice open. */
function subX(status: string, pis: string[] = ["requires_payment_method"], id = "sub_x"): FakeSub {
	const s: FakeSub = { id, status, customer: "cus_x", latest_invoice: `in_${id}`, metadata: { created_by: "user-1" }, currency: "eur", created: 1, items: { data: [] } };
	world.state.subs.set(id, s);
	world.state.invoices.set(s.latest_invoice, pis.includes("succeeded") ? "paid" : "open");
	world.state.payments.set(s.latest_invoice, pis);
	world.state.customers.set("cus_x", { created_by: "user-1" });
	return s;
}

/** user-1's OPEN setup for `sub`, whose org is org-1 unless `org` is null. */
function setup(sub = "sub_x", org: string | null = "org-1"): PendingOrgSetupRow {
	const at = new Date("2026-10-03T12:00:00Z");
	const row: PendingOrgSetupRow = {
		id: `row_${sub}`,
		user_id: "user-1",
		subscription_id: sub,
		customer_id: "cus_x",
		intended_name: "Acme Cloud",
		intended_slug: "acme",
		billing: null,
		created_org_id: org,
		creating_at: null,
		linked_at: null,
		declared_at: null,
		closed_at: null,
		closed_reason: null,
		closed_by: null,
		closed_note: null,
		refused_reason: null,
		created_at: at,
		updated_at: at,
	};
	world.state.setups.set(sub, row);
	if (org) world.state.orgOf.set(sub, org);
	return row;
}

/** Seeds an existing hold of user-1. */
function seedHold(overrides: Partial<PaymentHoldRow>): PaymentHoldRow {
	const hold = holdRow({ id: `hold_seed_${world.state.holds.length + 1}`, ...overrides });
	world.state.holds.push(hold);
	return hold;
}

/** The hold on `sub` that is open now, or the newest one. */
function holdOn(sub = "sub_x"): PaymentHoldRow | undefined {
	const all = world.state.holds.filter((h) => h.subscription_id === sub);
	return all.find((h) => h.state !== "released") ?? all[all.length - 1];
}

const link = () => linkSubscriptionToNewOrg({ orgId: "org-1", subscriptionId: "sub_x", customerId: "cus_x" });

/** The clause of a refused link, failing the test when it was linked. */
async function refusedClause(): Promise<string> {
	const r = await link();
	if (r.kind !== "refused") throw new Error(`expected a refusal, got ${r.kind}`);
	return r.clause;
}

/** Every Stripe WRITE the link could make to X or its customer. */
function stripeWrites(): number {
	return world.stripe.customers.update.mock.calls.length + world.stripe.subscriptions.update.mock.calls.length;
}

beforeEach(() => {
	// RESET, not clear: an implementation one test sets must not leak into the next. Every fake above is
	// a `vi.fn(impl)`, which a reset returns to `impl`.
	vi.resetAllMocks();
	vi.stubEnv("ALETHIA_PLATFORM_ALERT_ORG_ID", "org-platform");
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	Object.assign(world.state, {
		row: null,
		onUpdate: null,
		manageBilling: true,
		scopeOrg: null,
		orgExists: true,
		members: [{ userId: "user-1", status: "active" }],
		dbWrites: [],
		deliveries: [],
		openLeaseLost: false,
		activatesOnRead: null,
		holds: [],
	});
	for (const m of [world.state.subs, world.state.invoices, world.state.hosted, world.state.payments, world.state.customers, world.state.setups, world.state.orgOf]) m.clear();
});

describe("§5.6 — the link consults the hold that names X before any Stripe write", () => {
	it("C57: X canceled under a refund_due hold — no Stripe write, refused with the hold's clause, the setup left OPEN (refused_reason held)", async () => {
		subX("canceled", ["succeeded"]);
		setup();
		seedHold({ state: "refund_due", last_pay: "succeeded" });

		expect(await refusedClause()).toMatch(/^An earlier payment went through after that checkout was cancelled\. Its refund has not gone through yet/);
		expect(stripeWrites()).toBe(0);
		expect(syncSubscriptionToBilling).not.toHaveBeenCalled();
		expect(world.state.setups.get("sub_x")).toMatchObject({ refused_reason: "held", closed_at: null, linked_at: null });
	});

	it("C57: resolveNewOrgSetup reports the held setup with its hold, and no payment link", async () => {
		subX("canceled", ["succeeded"]);
		setup();
		seedHold({ state: "refund_due", last_pay: "succeeded" });

		const state = await resolveNewOrgSetup({ subscriptionId: "sub_x", customerId: "cus_x" });
		expect(state).toMatchObject({ paid: false, paymentUrl: null, hold: { state: "refund_due", notice: expect.stringMatching(/refund has not gone through/) } });
	});

	it("C91 (A): a needs_operator hold on an incomplete X refuses with its clause, and the setup stays open", async () => {
		subX("incomplete", ["processing"]);
		setup();
		seedHold({ state: "needs_operator", alerted_at: new Date() });

		expect(await refusedClause()).toMatch(/^We could not settle an earlier checkout's payment automatically.* We have raised an alert\.$/);
		expect(stripeWrites()).toBe(0);
		expect(world.state.setups.get("sub_x")).toMatchObject({ refused_reason: "held", closed_at: null });
	});

	it("a hold of ANOTHER payer on X refuses with the generic clause, and is never advanced or described", async () => {
		subX("incomplete");
		setup();
		seedHold({ state: "closing", payer_key: "user-9" });

		expect(await refusedClause()).toBe("We could not confirm an earlier checkout was closed, so nothing new was started. Try again in a few minutes.");
		expect(world.stripe.invoices.voidInvoice).not.toHaveBeenCalled();
		expect(stripeWrites()).toBe(0);
	});

	it("a closing hold is advanced under the lease first: a never-paid X is voided and cancelled, then refused as ended", async () => {
		subX("incomplete");
		setup();
		seedHold({ state: "closing" });

		expect(await refusedClause()).toMatch(/^This checkout was closed before its payment completed, so it was not linked to a team\. It was not charged\./);
		expect(world.stripe.invoices.voidInvoice).toHaveBeenCalledWith("in_sub_x");
		expect(holdOn()).toMatchObject({ state: "released", release_reason: "voided_unpaid" });
		expect(stripeWrites()).toBe(0);
		expect(world.state.setups.get("sub_x")?.closed_at).not.toBeNull();
	});

	it("a closing hold whose X went live is adopted by the advance, and X is linked", async () => {
		subX("incomplete");
		setup();
		seedHold({ state: "closing" });
		world.state.activatesOnRead = "sub_x";

		await expect(link()).resolves.toEqual({ kind: "linked", planState: "active", paymentUrl: null });
		expect(holdOn()).toMatchObject({ state: "released", release_reason: "adopted" });
		expect(world.state.subs.get("sub_x")?.metadata.organization_id).toBe("org-1");
		expect(world.state.setups.get("sub_x")?.linked_at).not.toBeNull();
	});

	it("C84: a closing hold on a payment still in flight (T4) links and defers — with no payment link, even when the plan reads action_needed", async () => {
		subX("incomplete", ["processing"]);
		world.state.hosted.set("in_sub_x", "https://invoice.stripe.com/i/acct_1/test_inv");
		setup();
		seedHold({ state: "closing" });
		// The payment needs the customer again by the time the plan state is read.
		world.state.onUpdate = () => world.state.payments.set("in_sub_x", ["requires_action"]);

		await expect(link()).resolves.toEqual({ kind: "linked", planState: "action_needed", paymentUrl: null });
		expect(holdOn()).toMatchObject({ state: "closing" });
		expect(world.state.subs.get("sub_x")?.metadata.organization_id).toBe("org-1");
	});

	it("C84: resolveNewOrgSetup returns no payment link while a closing hold names X — and the page as on dev with no hold", async () => {
		subX("incomplete", ["requires_action"]);
		world.state.hosted.set("in_sub_x", "https://invoice.stripe.com/i/acct_1/test_inv");
		setup();
		const ids = { subscriptionId: "sub_x", customerId: "cus_x" };

		await expect(resolveNewOrgSetup(ids)).resolves.toMatchObject({ planState: "action_needed", paymentUrl: "https://invoice.stripe.com/i/acct_1/test_inv", hold: null });
		seedHold({ state: "closing", last_pay: "awaiting" });
		await expect(resolveNewOrgSetup(ids)).resolves.toMatchObject({ planState: "action_needed", paymentUrl: null, hold: { state: "closing" } });
	});
});

describe("§5.6 — an ended X with no open hold", () => {
	it("C86: payments that may have moved — the contact-support clause, ONE alert, no refund, the setup closed", async () => {
		subX("canceled", ["succeeded"]);
		setup();

		const clause = await refusedClause();
		expect(clause).toMatch(/^This checkout was closed, and we could not confirm whether its payment went through.* We have raised an alert\. A team already created for it stays on the free plan\.$/);
		expect(world.stripe.refunds.create).not.toHaveBeenCalled();
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(emitAlertEvent).toHaveBeenCalledWith("org-platform", "system.platform.payment_needs_support", expect.objectContaining({ resource_id: "sub_x" }));
		expect(stripeWrites()).toBe(0);
		expect(world.state.setups.get("sub_x")).toMatchObject({ closed_reason: "ended", refused_reason: "ended" });
	});

	it("C86: no money moved — the not-charged clause, and no alert", async () => {
		subX("incomplete_expired");
		setup();

		expect(await refusedClause()).toBe(
			"This checkout was closed before its payment completed, so it was not linked to a team. It was not charged. A team already created for it stays on the free plan.",
		);
		expect(emitAlertEvent).not.toHaveBeenCalled();
	});

	it("advisory 2: X a hold REFUNDED in full — the §5.5 refund clause, and no alert", async () => {
		subX("canceled", ["succeeded"]);
		setup();
		seedHold({ state: "released", release_reason: "refunded", released_at: new Date() });

		expect(await refusedClause()).toBe(
			"This checkout was closed, so it was not linked to a team. An earlier payment was refunded in full; it can take 5–10 business days to reach you. A team already created for it stays on the free plan.",
		);
		expect(emitAlertEvent).not.toHaveBeenCalled();
		expect(world.state.setups.get("sub_x")?.closed_reason).toBe("ended");
	});

	it("advisory 2: `already_refunded` reads the same; a voided release still goes by the payments read", async () => {
		subX("canceled", ["succeeded"]);
		setup();
		seedHold({ state: "released", release_reason: "already_refunded", released_at: new Date() });
		expect(await refusedClause()).toMatch(/refunded in full/);
		expect(emitAlertEvent).not.toHaveBeenCalled();

		world.state.holds = [];
		seedHold({ state: "released", release_reason: "voided_unpaid", released_at: new Date() });
		expect(await refusedClause()).toMatch(/^This checkout was closed, and we could not confirm/);
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
	});

	it("advisory 4: money that moved AFTER an earlier close (the webhook holds nothing for it) is alerted by the link", async () => {
		subX("canceled", ["succeeded"]);
		Object.assign(setup(), { closed_at: new Date(), closed_reason: "ended", refused_reason: null });

		expect(await refusedClause()).toMatch(/We have raised an alert\./);
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(vi.mocked(emitAlertEvent).mock.calls[0]?.[2]?.summary).toMatch(/Its setup record is closed \(ended\)\./);
	});

	it("delta advisory 1: a retried refusal of the same ended X does not alert again once an alert reached a channel", async () => {
		subX("canceled", ["succeeded"]);
		setup();

		expect(await refusedClause()).toMatch(/We have raised an alert\./);
		expect(await refusedClause()).toMatch(/We have raised an alert\./);
		expect(await refusedClause()).toMatch(/We have raised an alert\./);
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
	});

	it("delta advisory 1: an alert that reached NO channel does not silence the next one", async () => {
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		subX("canceled", ["succeeded"]);
		setup();

		expect(await refusedClause()).not.toMatch(/raised/);
		expect(await refusedClause()).not.toMatch(/raised/);
		expect(emitAlertEvent).toHaveBeenCalledTimes(2);
	});

	it("advisory 8: with NO setup record, the alert says no setup was closed", async () => {
		subX("canceled", ["succeeded"]);
		await refusedClause();
		expect(vi.mocked(emitAlertEvent).mock.calls[0]?.[2]?.summary).toMatch(/No setup record names this subscription, so no setup was closed\./);
	});

	it("the clause claims the alert only when it reached a channel (I8)", async () => {
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		subX("canceled", ["succeeded"]);
		setup();
		expect(await refusedClause()).not.toMatch(/raised/);
	});

	it("C85: the org created before an ended X's refused link is not locked out, and the setup is not reported unfinished", async () => {
		subX("canceled");
		setup();
		await refusedClause();

		expect(world.state.setups.get("sub_x")?.closed_at).not.toBeNull();
		const bought = await createSubscriptionIntent("team").catch((e: unknown) => ({ thrown: String(e) }));
		expect(JSON.stringify(bought)).not.toMatch(/paid setup for this team has not finished/);
		await expect(findUnfinishedNewOrgSetup()).resolves.toBeNull();
	});
});

describe("§5.6 — beside the org's other live, paid plan (C80)", () => {
	it("C80: refused before any Stripe write, a needs_operator hold opened on X (link_refused) and alerted, the setup left OPEN", async () => {
		subX("active", ["succeeded"]);
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };

		expect(await refusedClause()).toMatch(ALERTED);
		expect(stripeWrites()).toBe(0);
		expect(syncSubscriptionToBilling).not.toHaveBeenCalled();
		expect(world.state.row).toEqual({ stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" });
		expect(holdOn()).toMatchObject({ state: "needs_operator", open_note: "link_refused", opened_by: "link", payer_key: "user-1", invoice_id: "in_sub_x" });
		expect(holdOn()?.alerted_at).not.toBeNull();
		expect(world.state.setups.get("sub_x")).toMatchObject({ refused_reason: "org_has_plan", closed_at: null, linked_at: null });
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(emitAlertEvent).toHaveBeenCalledWith("org-platform", "system.platform.payment_needs_support", expect.objectContaining({ resource_id: "sub_x" }));
	});

	it("C80 (H): the machine's T2o does not adopt that hold, though X is active", async () => {
		subX("active", ["succeeded"]);
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "trialing", stripeCustomerId: "cus_y" };
		await refusedClause();
		const held = holdOn();
		if (!held) throw new Error("no hold was opened");

		const advanced = await advanceHold(held, machineDepsFor(LEASE, liveSweepDeps()));
		expect(advanced.rows).toEqual(["T15"]);
		expect(holdOn()).toMatchObject({ state: "needs_operator" });
	});

	it("a past_due Y refuses an incomplete X the same way, under a hold", async () => {
		subX("incomplete", ["processing"]);
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "past_due", stripeCustomerId: "cus_y" };

		expect(await refusedClause()).toMatch(ORG_HAS_PLAN);
		expect(holdOn()).toMatchObject({ state: "needs_operator", open_note: "link_refused" });
		expect(world.state.setups.get("sub_x")?.closed_at).toBeNull();
	});

	it("an alert that reached no channel is not claimed, and leaves alerted_at unset for the sweeper's age alert", async () => {
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		subX("active", ["succeeded"]);
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };

		expect(await refusedClause()).not.toMatch(/raised/);
		expect(holdOn()?.alerted_at).toBeNull();
	});

	it("#5715 follow-up 2: a refused X with NO setup record is alerted once, however often the link is retried", async () => {
		subX("active", ["succeeded"]);
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };

		expect(await refusedClause()).toMatch(ALERTED);
		expect(await refusedClause()).toMatch(ALERTED);
		expect(await refusedClause()).toMatch(ALERTED);
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(world.state.holds).toHaveLength(1);
	});

	it("#5715 follow-up 1: the closer inside the link never closes beside the live plan, so the refusal's alert is its own and is claimed", async () => {
		subX("active", ["succeeded"]).metadata.organization_id = "org-1";
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };
		const actual = await vi.importActual<typeof import("@/lib/billing/pending-org-setup")>("@/lib/billing/pending-org-setup");
		vi.mocked(settleOpenSetup).mockImplementation(actual.settleOpenSetup);

		expect(await refusedClause()).toMatch(ALERTED);
		expect(settleOpenSetup).toHaveBeenCalledWith(expect.objectContaining({ subscription_id: "sub_x" }), expect.objectContaining({ linkRefuses: true }));
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(world.state.setups.get("sub_x")).toMatchObject({ refused_reason: "org_has_plan", closed_at: null });
	});

	it("race: Y takes the row during the sync — refused after X's metadata write, under a hold, never marked linked", async () => {
		subX("active", ["succeeded"]);
		setup();
		vi.mocked(syncSubscriptionToBilling).mockImplementationOnce(async () => {
			world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };
			return "ignored";
		});

		expect(await refusedClause()).toMatch(ORG_HAS_PLAN);
		expect(world.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
		expect(holdOn()).toMatchObject({ state: "needs_operator", open_note: "link_refused" });
		expect(world.state.setups.get("sub_x")).toMatchObject({ linked_at: null, closed_at: null, refused_reason: "org_has_plan" });
	});

	it("a lease lost when the hold is opened stops the link: nothing is written and the setup is untouched", async () => {
		subX("active", ["succeeded"]);
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };
		world.state.openLeaseLost = true;

		await expect(link()).rejects.toThrow(/took too long and was stopped/);
		expect(emitAlertEvent).not.toHaveBeenCalled();
		expect(world.state.setups.get("sub_x")?.refused_reason).toBeNull();
	});
});

describe("§5.6 — what is linked as before", () => {
	it("C60: an incomplete X whose payment is processing links and defers — confirming, no payment link, the row on community", async () => {
		subX("incomplete", ["processing"]);
		setup();

		await expect(link()).resolves.toEqual({ kind: "linked", planState: "confirming", paymentUrl: null });
		expect(world.state.subs.get("sub_x")?.metadata.organization_id).toBe("org-1");
		expect(world.state.row).toMatchObject({ stripeSubscriptionId: "sub_x", status: "none" });
		expect(world.state.holds).toHaveLength(0);
	});

	it("C77: the row names an abandoned `none` Y — X takes it and is linked active", async () => {
		subX("active", ["succeeded"]);
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "none", stripeCustomerId: "cus_y" };

		await expect(link()).resolves.toEqual({ kind: "linked", planState: "active", paymentUrl: null });
		expect(world.state.row).toMatchObject({ stripeSubscriptionId: "sub_x" });
		expect(world.state.holds).toHaveLength(0);
	});
});

describe("§5.6 'When a hold ends' — an adoption re-links a setup that has an org (C91)", () => {
	/** Seeds the T2o shape: a needs_operator hold the purchase opened (not the link's) on X, now active. */
	function adoptable(): void {
		subX("active", ["succeeded"]);
		seedHold({ state: "needs_operator", opened_by: "purchase" });
	}

	/** Runs the machine's pass on X's hold as the sweeper's visit does, then the re-link it runs. */
	async function sweepAndRelink() {
		const held = holdOn();
		if (!held) throw new Error("no hold");
		const advanced = await advanceHold(held, machineDepsFor(LEASE, liveSweepDeps()));
		expect(advanced.hold).toMatchObject({ state: "released", release_reason: "adopted" });
		return relinkAdoptedSetup(LEASE, advanced.hold, liveSweepDeps().alert);
	}

	it("C91 (H): T2o adopts; with an org the core links X — linked_at set, the row names X", async () => {
		adoptable();
		setup();

		await expect(sweepAndRelink()).resolves.toMatchObject({ kind: "linked" });
		expect(world.state.subs.get("sub_x")?.metadata).toEqual({ created_by: "user-1", organization_id: "org-1" });
		expect(world.state.setups.get("sub_x")?.linked_at).not.toBeNull();
		expect(world.state.row).toMatchObject({ stripeSubscriptionId: "sub_x", status: "active" });
	});

	it("C91: with no org the setup stays open, findUnfinishedNewOrgSetup returns it, and the purchase resumes it (§4.3)", async () => {
		adoptable();
		setup("sub_x", null);
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "all", customers: ["cus_x"] });

		await expect(sweepAndRelink()).resolves.toEqual({ kind: "no_org" });
		expect(stripeWrites()).toBe(0);
		expect(world.state.setups.get("sub_x")).toMatchObject({ linked_at: null, closed_at: null });
		await expect(findUnfinishedNewOrgSetup()).resolves.toMatchObject({ subscriptionId: "sub_x", paid: true, hold: null });
		await expect(createNewOrgSubscriptionIntent("team", { orgName: "NewCo" })).resolves.toMatchObject({ kind: "resume" });
	});

	it("C91 variant: the creator no longer holds manage_billing — no link, an alert with X as the subject, the setup open", async () => {
		adoptable();
		setup();
		world.state.manageBilling = false;

		await expect(sweepAndRelink()).resolves.toMatchObject({ kind: "not_linked", why: expect.stringMatching(/manage_billing/) });
		expect(stripeWrites()).toBe(0);
		expect(world.state.setups.get("sub_x")).toMatchObject({ linked_at: null, closed_at: null });
		expect(emitAlertEvent).toHaveBeenCalledWith("org-platform", "system.platform.payment_needs_support", expect.objectContaining({ resource_id: "sub_x" }));
	});

	it("BLOCKER: the creator was removed from the recorded team — no link, an alert, the setup open (never `no_org`)", async () => {
		adoptable();
		setup();
		world.state.members = [{ userId: "user-2", status: "active" }];

		await expect(sweepAndRelink()).resolves.toEqual({ kind: "not_linked", why: "its creator is no longer an active member of team org-1" });
		expect(stripeWrites()).toBe(0);
		expect(world.state.setups.get("sub_x")).toMatchObject({ linked_at: null, closed_at: null });
		expect(emitAlertEvent).toHaveBeenCalledWith("org-platform", "system.platform.payment_needs_support", expect.objectContaining({ resource_id: "sub_x" }));
	});

	// `created_org_id` is ON DELETE SET NULL (migration 0159), so a team deleted BEFORE the setup is read
	// reads as `no_org`. Only a deletion between the setup read and the org read reaches this branch.
	it("race: the team is deleted between the setup read and the org read — no link, an alert, the setup open", async () => {
		adoptable();
		setup();
		world.state.orgExists = false;

		await expect(sweepAndRelink()).resolves.toEqual({ kind: "not_linked", why: "its recorded team org-1 no longer exists" });
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
	});

	it("advisory 6: a team with NO members is never repaired by the sessionless re-link — no member write, no link, an alert", async () => {
		adoptable();
		setup();
		world.state.members = [];

		await expect(sweepAndRelink()).resolves.toEqual({ kind: "not_linked", why: "its team org-1 has no members" });
		expect(world.state.dbWrites.filter((w) => w === "insert" || w === "execute")).toEqual([]);
		expect(stripeWrites()).toBe(0);
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
	});

	it("advisory 5: a scope resolver that substitutes another org is a no — no link, an alert", async () => {
		adoptable();
		setup();
		world.state.scopeOrg = "org-other";

		await expect(sweepAndRelink()).resolves.toMatchObject({ kind: "not_linked", why: expect.stringMatching(/manage_billing/) });
		expect(stripeWrites()).toBe(0);
	});

	it("a re-link beside a live Y takes the table's row: a new link_refused hold, alerted, and the setup open", async () => {
		adoptable();
		setup();
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };

		await expect(sweepAndRelink()).resolves.toMatchObject({ kind: "refused", clause: expect.stringMatching(ALERTED) });
		expect(holdOn()).toMatchObject({ state: "needs_operator", open_note: "link_refused" });
		expect(world.state.setups.get("sub_x")).toMatchObject({ linked_at: null, closed_at: null, refused_reason: "org_has_plan" });
	});

	it("a re-link beside Y while a hold on X is still open (the hold `release` is releasing) opens nothing and alerts nothing again", async () => {
		subX("active", ["succeeded"]);
		setup();
		seedHold({ state: "needs_operator", open_note: "link_refused", alerted_at: new Date() });
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };

		await expect(relinkAdoptedSetup(LEASE, { payer_key: "user-1", subscription_id: "sub_x", customer_id: "cus_x" }, liveSweepDeps().alert)).resolves.toMatchObject({
			kind: "refused",
			clause: expect.stringMatching(ALERTED),
		});
		expect(world.state.holds).toHaveLength(1);
		expect(emitAlertEvent).not.toHaveBeenCalled();
		expect(stripeWrites()).toBe(0);
	});

	it("the purchase's own hold pass re-links an adopted setup with an org, and mints only after", async () => {
		subX("incomplete");
		setup();
		seedHold({ state: "closing" });
		world.state.activatesOnRead = "sub_x";

		await expect(createNewOrgSubscriptionIntent("team", { orgName: "NewCo" })).resolves.toMatchObject({ kind: "intent" });
		expect(holdOn()).toMatchObject({ state: "released", release_reason: "adopted" });
		expect(world.state.subs.get("sub_x")?.metadata.organization_id).toBe("org-1");
		expect(world.state.setups.get("sub_x")?.linked_at).not.toBeNull();
	});

	it("a re-link the purchase runs that is refused beside Y opens a hold that refuses THIS purchase too (I1 (a))", async () => {
		subX("incomplete");
		setup();
		seedHold({ state: "closing" });
		world.state.activatesOnRead = "sub_x";
		world.state.row = { stripeSubscriptionId: "sub_y", status: "active", stripeCustomerId: "cus_y" };

		const r = await createNewOrgSubscriptionIntent("team", { orgName: "NewCo" });
		expect(r).toMatchObject({ kind: "refused", message: expect.stringMatching(/^We could not settle an earlier checkout's payment automatically/) });
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
		expect(holdOn()).toMatchObject({ state: "needs_operator", open_note: "link_refused" });
	});
});

// ADR 0002 S10b (amendment 2026-10-14): the resume lookup reports an ended setup, with the sentence the
// link would refuse it with and under the link's alert rule. The expected sentences are LITERALS (C106's
// rule): read from the module under test, they could not see the two copies drift.
const NOT_CHARGED_CLAUSE =
	"This checkout was closed before its payment completed, so it was not linked to a team. It was not charged. A team already created for it stays on the free plan.";
const UNCONFIRMED_CLAUSE =
	"This checkout was closed, and we could not confirm whether its payment went through, so it was not linked to a team. Contact support at support@alethialabs.io with the time of the payment.";
const ALERT_SENTENCE = " We have raised an alert.";
const FREE_PLAN_SENTENCE = " A team already created for it stays on the free plan.";
/** What `alertPaymentNeedsSupport` puts before the detail for `context: "setup_closed"`. */
const SETUP_CLOSED_SUMMARY = "a create-a-team subscription whose unfinished setup was closed because the subscription ended: ";

const resolve = () => resolveNewOrgSetup({ subscriptionId: "sub_x", customerId: "cus_x" });

/** The lookup's answer, failing the test when it returned none. */
async function resolved() {
	const state = await resolve();
	if (!state) throw new Error("expected a setup state, got null");
	return state;
}

/** user-1's setup for X, CLOSED earlier for `reason`, so the closer writes nothing and alerts nothing. */
function closedSetup(reason: PendingOrgSetupRow["closed_reason"], org: string | null = "org-1"): PendingOrgSetupRow {
	return Object.assign(setup("sub_x", org), { closed_at: new Date(Date.now() - 3_600_000), closed_reason: reason });
}

/** The summaries of every operator alert raised so far. */
function alertSummaries(): string[] {
	return vi.mocked(emitAlertEvent).mock.calls.map((c) => String(c[2]?.summary ?? ""));
}

describe("§5.6 'The lookup reports an ended setup' (S10b)", () => {
	it("C103: X canceled, no hold, nothing paid — `ended` carries the not-charged clause, no hold, no alert", async () => {
		subX("canceled");
		closedSetup("ended");

		const state = await resolved();
		expect(state).toMatchObject({ ended: { clause: NOT_CHARGED_CLAUSE }, hold: null });
		expect(emitAlertEvent).not.toHaveBeenCalled();
		expect(settleOpenSetup).not.toHaveBeenCalled();
	});

	it("C103: X incomplete_expired gives the same result", async () => {
		subX("incomplete_expired");
		closedSetup("ended");

		await expect(resolved()).resolves.toMatchObject({ ended: { clause: NOT_CHARGED_CLAUSE }, hold: null });
		expect(emitAlertEvent).not.toHaveBeenCalled();
	});

	for (const status of ["paused", "incomplete", "active"]) {
		it(`C103: X ${status} is not ended — the link would link it`, async () => {
			subX(status, status === "active" ? ["succeeded"] : ["requires_payment_method"]);
			setup();

			await expect(resolved()).resolves.toMatchObject({ ended: null });
			expect(emitAlertEvent).not.toHaveBeenCalled();
		});
	}

	it("C103: an open refund_due hold on a canceled X reports the hold, and `ended` is null", async () => {
		subX("canceled", ["succeeded"]);
		setup();
		seedHold({ state: "refund_due", last_pay: "succeeded" });

		await expect(resolved()).resolves.toMatchObject({ ended: null, hold: { state: "refund_due" } });
		expect(emitAlertEvent).not.toHaveBeenCalled();
	});

	const refundReasons: Array<NonNullable<PaymentHoldRow["release_reason"]>> = ["refunded", "already_refunded"];
	for (const reason of refundReasons) {
		it(`C104: X a hold released as ${reason} — 'refunded in full', never 'could not confirm', and the link's exact clause`, async () => {
			subX("canceled", ["succeeded"]);
			closedSetup("hold_released");
			seedHold({ state: "released", release_reason: reason, released_at: new Date() });

			const state = await resolved();
			expect(state.planState).toBe("not_active");
			expect(state.hold).toBeNull();
			expect(state.ended?.clause).toMatch(/refunded in full/);
			expect(state.ended?.clause).not.toMatch(/could not confirm/);
			expect(emitAlertEvent).not.toHaveBeenCalled();
			// Drift check: the link refuses the same fixture with the same string.
			expect(await refusedClause()).toBe(state.ended?.clause);
		});
	}
});

describe("§5.6 'The alert: the link's, under the link's rule' (C105)", () => {
	/** X canceled, no hold of any kind, the setup closed earlier for `reason`, and money that moved since. */
	function fixture(reason: PendingOrgSetupRow["closed_reason"], org: string | null = "org-1"): PendingOrgSetupRow {
		subX("canceled", ["succeeded"]);
		return closedSetup(reason, org);
	}

	/** Clears what a run left behind (the delivery rows, the alert calls) and stages the fixture again. */
	function restage(reason: PendingOrgSetupRow["closed_reason"], org: string | null = "org-1"): PendingOrgSetupRow {
		world.state.deliveries = [];
		world.state.setups.clear();
		world.state.orgOf.clear();
		vi.mocked(emitAlertEvent).mockClear();
		return fixture(reason, org);
	}

	// `ended` is the closer's own close on a `never_paid` read, which alerted nothing: the payments moved
	// after it read them. `hold_released` is a hold's release, which alerts nothing about the setup.
	const earlierCloses: Array<NonNullable<PendingOrgSetupRow["closed_reason"]>> = ["hold_released", "ended"];
	for (const reason of earlierCloses) {
		it(`(a) closed earlier as ${reason}, no delivery row since — ONE alert from the lookup, and the clause claims it`, async () => {
			fixture(reason);

			const state = await resolved();
			expect(emitAlertEvent).toHaveBeenCalledTimes(1);
			expect(emitAlertEvent).toHaveBeenCalledWith("org-platform", "system.platform.payment_needs_support", expect.objectContaining({ resource_id: "sub_x" }));
			expect(alertSummaries()[0]).toContain(`${SETUP_CLOSED_SUMMARY}a resume of the setup was stopped`);
			expect(state.ended?.clause).toBe(`${UNCONFIRMED_CLAUSE}${ALERT_SENTENCE}${FREE_PLAN_SENTENCE}`);
			expect(state.hold).toBeNull();

			// Drift check: the link, on the same fixture, refuses with the same string and alerts as often.
			restage(reason);
			expect(await refusedClause()).toBe(state.ended?.clause);
			expect(emitAlertEvent).toHaveBeenCalledTimes(1);
			expect(alertSummaries()[0]).toContain(`${SETUP_CLOSED_SUMMARY}the link to team org-1 was refused`);
		});
	}

	it("(a) with no team, the same clause without the free-plan sentence", async () => {
		fixture("hold_released", null);

		const state = await resolved();
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(state.ended?.clause).toBe(`${UNCONFIRMED_CLAUSE}${ALERT_SENTENCE}`);
	});

	it("(b) the alert reached no channel — the clause does not claim it", async () => {
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		fixture("ended");
		expect((await resolved()).ended?.clause).toBe(`${UNCONFIRMED_CLAUSE}${FREE_PLAN_SENTENCE}`);

		restage("ended", null);
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		expect((await resolved()).ended?.clause).toBe(UNCONFIRMED_CLAUSE);
	});

	it("(c) a delivered row about X since the close — no alert, and the clause of (a)", async () => {
		fixture("ended");
		world.state.deliveries.push({ id: "delivery_earlier", resource_id: "sub_x", status: "delivered" });

		const state = await resolved();
		expect(emitAlertEvent).not.toHaveBeenCalled();
		expect(state.ended?.clause).toBe(`${UNCONFIRMED_CLAUSE}${ALERT_SENTENCE}${FREE_PLAN_SENTENCE}`);

		// Drift check: the link is silenced by the same row, and says the same thing.
		restage("ended");
		world.state.deliveries.push({ id: "delivery_earlier", resource_id: "sub_x", status: "delivered" });
		expect(await refusedClause()).toBe(state.ended?.clause);
		expect(emitAlertEvent).not.toHaveBeenCalled();
	});

	it("(d) only a dead row — as (a), one alert", async () => {
		fixture("ended");
		world.state.deliveries.push({ id: "delivery_dead", resource_id: "sub_x", status: "dead" });

		const state = await resolved();
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(state.ended?.clause).toBe(`${UNCONFIRMED_CLAUSE}${ALERT_SENTENCE}${FREE_PLAN_SENTENCE}`);
	});

	it("the lookup writes nothing for an ended setup: no setup write, no Stripe write", async () => {
		const row = fixture("ended");
		const before = { ...row };

		await resolved();
		expect(world.state.setups.get("sub_x")).toEqual(before);
		expect(stripeWrites()).toBe(0);
		expect(world.stripe.refunds.create).not.toHaveBeenCalled();
	});
});
