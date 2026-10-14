// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0002 S8 (#5926): the create-a-team purchase on payment holds — the A cases.
//
// The flow runs for real, and so does `advanceHold` (lib/billing/payment-holds/machine.ts) and the
// sweeper's `machineDepsFor`. What is faked is the two boundaries they write through:
//   - STRIPE is a small stateful world (`world`): a subscription the machine cancels then READS
//     `canceled`, an invoice it voids reads `void`, and a test can make a payment land after a cancel
//     (`onCancel`) or make a call fail. So a case reads the way the money moves, not as a script of
//     canned answers.
//   - THE HOLD STORE (lib/billing/payment-holds/store.ts) is an in-memory table with the same
//     compare-and-set on `version`; its SQL and its lease fence are pinned against Postgres in
//     tests/integration/payment-holds.test.ts. The setup record module is mocked as in
//     billing-subscription.test.ts, EXCEPT its three hold readers (`paymentHoldsOfPayer`,
//     `openPaymentHoldOn`, `latestReleasedHoldOn`), which run for real: the fake database below
//     evaluates the predicate each one builds over that table. So the scope filter the create-a-team
//     readers apply (ADR 0004 D1 rule 3: C1, C2) is the readers' own, not this file's.
//
// On dev every case here fails on its assertion: the flow there opens no hold, cancels before it
// voids, and remembers nothing between two requests. ADR 0004 C1 is the one pin (it passes on dev:
// no reader there keys a hold by an org id), and its failing-first twin is the case after it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentHoldRow } from "@/lib/db/schema";

/** A subscription as the fake Stripe holds it. */
interface FakeSub {
	id: string;
	status: string;
	customer: string;
	latest_invoice: string;
	metadata: Record<string, string>;
	currency: string;
	created: number;
}

const world = vi.hoisted(() => {
	const state = {
		subs: new Map<string, FakeSub>(),
		/** invoice id → status */
		invoices: new Map<string, string>(),
		/** invoice id → the statuses of its PaymentIntents */
		payments: new Map<string, string[]>(),
		/** PaymentIntent id → its refunds */
		refunds: new Map<string, { status: string; amount: number }[]>(),
		holds: [] as PaymentHoldRow[],
		/** Runs after a cancel took effect: a payment that lands after it. */
		onCancel: null as null | ((id: string) => void),
		cancelFails: false,
		openFails: false,
		/** The next N state writes throw (a database error after a Stripe write). */
		writeFailures: 0,
		/** Every lease renewal fails: the lease was taken over, or lapsed. */
		leaseLost: false,
		/** A subscription whose first read goes `active`: its payment lands as the machine reads it. */
		activatesOnRead: null as string | null,
		/** The newest `created_at` of user-1's unlinked setup records, as the over-cap dedupe reads it (#5989). */
		newestRecordAt: null as Date | null,
		/** The operator-alert delivery rows written so far: one per alert routed to a channel. */
		deliveries: [] as { resource_id: string; event_key: string; status: string; created_at: Date }[],
	};
	const missing = () => Object.assign(new Error("No such object"), { code: "resource_missing" });
	const piOf = (invoice: string, i: number) => `pi_${invoice}_${i}`;
	const intent = (invoice: string, i: number, status: string) => ({
		id: piOf(invoice, i),
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
				}
				return { ...sub };
			}),
			list: vi.fn(async (p: { customer: string; status: string }) => ({
				has_more: false,
				data: [...state.subs.values()].filter(
					(s) => s.customer === p.customer && (p.status === "all" || s.status === p.status),
				),
			})),
			cancel: vi.fn(async (id: string, _params?: unknown) => {
				if (state.cancelFails) throw new Error("Stripe is unavailable");
				const sub = state.subs.get(id);
				if (!sub) throw missing();
				sub.status = "canceled";
				state.onCancel?.(id);
				return { ...sub };
			}),
			create: vi.fn(async () => ({
				id: "sub_new",
				latest_invoice: { id: "in_new", confirmation_secret: { client_secret: "cs_new" } },
			})),
			search: vi.fn(async () => ({ data: [] })),
		},
		invoices: {
			retrieve: vi.fn(async (id: string) => {
				const status = state.invoices.get(id);
				if (status === undefined) throw missing();
				return { id, status };
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
			list: vi.fn(async (p: { payment_intent: string }) => ({
				has_more: false,
				data: state.refunds.get(p.payment_intent) ?? [],
			})),
			create: vi.fn(async () => ({})),
		},
		customers: {
			retrieve: vi.fn(async (id: string) => ({ id, deleted: false, metadata: { created_by: "user-1" } })),
			create: vi.fn(async () => ({ id: "cus_created" })),
		},
	};
	return { state, stripe };
});

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
	authorizeInOrg: vi.fn(),
	authorizeQuiet: vi.fn(),
}));
// The direct reads in these paths: the payer's email before a customer is minted (none here), and the
// over-cap dedupe's operator-alert deliveries (#5989); its other read, the newest unlinked setup record,
// is `newestUnlinkedSetupAt` in the mocked setup module below. Each query answers by the table it reads
// `from`. The deliveries query is EVALUATED: its
// `where` is rendered to SQL by drizzle's Postgres dialect, and each conjunct — the event key, the
// `resource_id`, `status <> …`, `created_at >= …` — is applied to `world.state.deliveries` with the
// parameter the code bound. A conjunct this reader does not know throws, so a changed query cannot pass
// by being ignored, and a dropped or wrong conjunct changes which deliveries match.
vi.mock("@/lib/db", async () => {
	const schema = await import("@/lib/db/schema");
	type PaymentHoldRow = import("@/lib/db/schema").PaymentHoldRow;
	const { PgDialect } = await import("drizzle-orm/pg-core");
	const { SQL } = await import("drizzle-orm");
	const dialect = new PgDialect();
	type Delivery = (typeof world.state.deliveries)[number];
	/** One conjunct of the deliveries query, as a filter over the fake rows. */
	const conjunct = (clause: string, params: unknown[]): ((d: Delivery) => boolean) => {
		const param = (ref: string | undefined) => params[Number(ref) - 1];
		const m =
			/^"alert_deliveries"\."(event_key|status|created_at)" (=|<>|>=) \$(\d+)$/.exec(clause) ??
			/^"alert_deliveries"\."context"->>'(resource_id)' (=) \$(\d+)$/.exec(clause);
		if (!m) throw new Error(`the fake db cannot evaluate: ${clause}`);
		const [, column, op, ref] = m;
		const value = param(ref);
		if (column === "created_at") return (d) => d.created_at >= new Date(String(value));
		const read = (d: Delivery) => (column === "event_key" ? d.event_key : column === "status" ? d.status : d.resource_id);
		return op === "<>" ? (d) => read(d) !== value : (d) => read(d) === value;
	};
	/**
	 * Evaluates a `payment_holds` predicate, rendered by drizzle's Postgres dialect, over
	 * `world.state.holds`: `and`, `or`, parentheses, and `=`, `<>`, `>`, `in (…)` between a column and a
	 * bound parameter. Anything else in the rendered SQL throws, so a reader cannot pass by being
	 * misread. A NULL column satisfies no comparison, as in SQL.
	 */
	const holdsMatching = (where: unknown): PaymentHoldRow[] => {
		if (!(where instanceof SQL)) throw new Error("the payment_holds query has no where clause");
		const q = dialect.sqlToQuery(where);
		const tokens = q.sql.match(/"payment_holds"\."[a-z_]+"|\$\d+|<>|=|>|\(|\)|,|\b(?:and|or|in)\b/g) ?? [];
		if (tokens.join("") !== q.sql.replace(/\s+/g, "")) throw new Error(`the fake db cannot evaluate: ${q.sql}`);
		let at = 0;
		const next = () => tokens[at++];
		const expect = (t: string) => {
			if (next() !== t) throw new Error(`the fake db cannot evaluate: ${q.sql}`);
		};
		const param = (t: string | undefined) => {
			if (!t?.startsWith("$")) throw new Error(`the fake db cannot evaluate: ${q.sql}`);
			return q.params[Number(t.slice(1)) - 1];
		};
		type Test = (h: PaymentHoldRow) => boolean;
		const compare = (a: unknown, b: unknown): number => {
			if (a instanceof Date) return a.getTime() - new Date(String(b)).getTime();
			return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
		};
		const factor = (): Test => {
			const t = next();
			if (t === "(") {
				const inner = expr();
				expect(")");
				return inner;
			}
			const col = /^"payment_holds"\."([a-z_]+)"$/.exec(t ?? "")?.[1];
			if (!col) throw new Error(`the fake db cannot evaluate: ${q.sql}`);
			const read = (h: PaymentHoldRow): unknown => Reflect.get(h, col);
			const op = next();
			if (op === "in") {
				expect("(");
				const values: unknown[] = [param(next())];
				while (tokens[at] === ",") {
					next();
					values.push(param(next()));
				}
				expect(")");
				return (h) => read(h) != null && values.some((v) => compare(read(h), v) === 0);
			}
			const value = param(next());
			if (op === "=") return (h) => read(h) != null && compare(read(h), value) === 0;
			if (op === "<>") return (h) => read(h) != null && compare(read(h), value) !== 0;
			if (op === ">") return (h) => read(h) != null && compare(read(h), value) > 0;
			throw new Error(`the fake db cannot evaluate: ${q.sql}`);
		};
		const term = (): Test => {
			const tests = [factor()];
			while (tokens[at] === "and") {
				next();
				tests.push(factor());
			}
			return (h) => tests.every((f) => f(h));
		};
		const expr = (): Test => {
			const tests = [term()];
			while (tokens[at] === "or") {
				next();
				tests.push(term());
			}
			return (h) => tests.some((f) => f(h));
		};
		const test = expr();
		if (at !== tokens.length) throw new Error(`the fake db cannot evaluate: ${q.sql}`);
		return world.state.holds.filter(test).map((h) => ({ ...h }));
	};
	const answer = (table: unknown, where: unknown): unknown[] => {
		if (table === schema.paymentHolds) return holdsMatching(where);
		if (table === schema.alertDeliveries) {
			if (!(where instanceof SQL)) throw new Error("the deliveries query has no where clause");
			const q = dialect.sqlToQuery(where);
			const clauses = q.sql.replace(/^\((.*)\)$/, "$1").split(" and ");
			const filters = clauses.map((c) => conjunct(c.trim(), q.params));
			return world.state.deliveries.filter((d) => filters.every((f) => f(d))).map((_, i) => ({ id: `delivery_${i}` }));
		}
		return [];
	};
	const query = () => {
		let table: unknown = null;
		let where: unknown = null;
		const chain: Record<string, unknown> = {};
		// `orderBy` keeps the table's insertion order: every case here has at most one row a sort could move.
		for (const m of ["select", "limit", "innerJoin", "orderBy"]) chain[m] = () => chain;
		chain.from = (t: unknown) => {
			table = t;
			return chain;
		};
		chain.where = (w: unknown) => {
			where = w;
			return chain;
		};
		chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(answer(table, where)).then(resolve);
		return chain;
	};
	return { getServiceDb: () => ({ select: () => query() }) };
});
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn(async () => null), upsertOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => world.stripe,
	getPurchaseStripe: () => world.stripe,
	STRIPE_REQUEST_TIMEOUT_MS: 20_000,
	STRIPE_MAX_NETWORK_RETRIES: 1,
}));
vi.mock("@/lib/billing/sync", () => ({ syncSubscriptionToBilling: vi.fn(), mapStatus: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEvent: vi.fn(async () => 0), emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/billing/purchase-lease", () => {
	class PurchaseLeaseLostError extends Error {}
	const renew = async () => true;
	return {
		PurchaseLeaseLostError,
		UNFENCED: async () => undefined,
		renewPurchaseLease: renew,
		fenceFor: () => async () => {
			if (world.state.leaseLost) throw new PurchaseLeaseLostError("user:user-1");
		},
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

/** An in-memory `payment_holds`: the store's writes, each a compare-and-set on `version`. */
vi.mock("@/lib/billing/payment-holds/store", () => {
	const find = (ref: { id: string; version: number }) =>
		world.state.holds.find((h) => h.id === ref.id && h.version === ref.version && h.state !== "released");
	const failNext = () => {
		if (world.state.writeFailures === 0) return;
		world.state.writeFailures -= 1;
		throw new Error("database is unavailable");
	};
	return {
		openHold: async (_lease: unknown, input: { scope?: PaymentHoldRow["scope"]; subscriptionId: string; customerId: string; payerKey: string; invoiceId: string; state: PaymentHoldRow["state"]; nextCheckAt: Date }) => {
			if (world.state.openFails) throw new Error("database is unavailable");
			const open = world.state.holds.find((h) => h.subscription_id === input.subscriptionId && h.state !== "released");
			if (open) return { kind: "already_open", hold: open };
			const hold = holdRow({
				id: `hold_${world.state.holds.length + 1}`,
				scope: input.scope ?? "new_org",
				subscription_id: input.subscriptionId,
				customer_id: input.customerId,
				payer_key: input.payerKey,
				invoice_id: input.invoiceId,
				state: input.state,
				next_check_at: input.nextCheckAt,
			});
			world.state.holds.push(hold);
			return { kind: "opened", hold: { ...hold } };
		},
		writeHoldState: async (_lease: unknown, ref: { id: string; version: number }, patch: Record<string, unknown>) => {
			failNext();
			const hold = find(ref);
			if (!hold) return null;
			Object.assign(hold, {
				...(patch.state !== undefined ? { state: patch.state } : {}),
				...(patch.lastPay !== undefined ? { last_pay: patch.lastPay } : {}),
				...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
				...(patch.alertedAt !== undefined ? { alerted_at: patch.alertedAt } : {}),
				...(patch.nextCheckAt !== undefined ? { next_check_at: patch.nextCheckAt } : {}),
				version: hold.version + 1,
			});
			return { ...hold };
		},
		reserveRefundAttempt: async (_lease: unknown, ref: { id: string; version: number }) => {
			const hold = find(ref);
			if (!hold) return null;
			hold.refund_attempt += 1;
			hold.version += 1;
			return { attempt: hold.refund_attempt - 1, hold: { ...hold } };
		},
		releaseHold: async (_lease: unknown, ref: { id: string; version: number }, input: { reason: PaymentHoldRow["release_reason"]; lastPay?: string | null }) => {
			failNext();
			const hold = find(ref);
			if (!hold) return null;
			Object.assign(hold, {
				state: "released",
				release_reason: input.reason,
				released_at: new Date(),
				next_check_at: null,
				last_pay: input.lastPay ?? hold.last_pay,
				version: hold.version + 1,
			});
			return { hold: { ...hold }, closedSetupId: null };
		},
		nudgeHold: vi.fn(),
		claimHoldNotice: vi.fn(),
		unclaimHoldNotice: vi.fn(),
	};
});

vi.mock("@/lib/billing/pending-org-setup", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/billing/pending-org-setup")>();
	return {
		pendingOrgSetupBillingSchema: actual.pendingOrgSetupBillingSchema,
		pendingOrgSetupSlugSchema: actual.pendingOrgSetupSlugSchema,
		REPLACEABLE_SUBSCRIPTION_STATUSES: actual.REPLACEABLE_SUBSCRIPTION_STATUSES,
		UNLINKED_SETUP_CUSTOMER_CAP: actual.UNLINKED_SETUP_CUSTOMER_CAP,
		FORGETTABLE_RELEASES: actual.FORGETTABLE_RELEASES,
		logBillingEvent: actual.logBillingEvent,
		closePendingOrgSetup: vi.fn(async () => null),
		openPendingOrgSetupsForOrg: vi.fn(async () => []),
		settleOpenSetup: vi.fn(async () => "open"),
		findSetupOrg: vi.fn(async () => null),
		forgetPendingOrgSetup: vi.fn(async () => true),
		markPendingOrgSetupDeclared: vi.fn(),
		markPendingOrgSetupLinked: vi.fn(),
		pendingOrgSetupFor: vi.fn(async (userId: string, subscriptionId: string) => setupRow(userId, subscriptionId)),
		recordPendingOrgSetup: vi.fn(),
		savePendingOrgSetupDetails: vi.fn(),
		unfinishedPendingOrgSetups: vi.fn(),
		unlinkedPendingOrgSetupCustomers: vi.fn(async () => ({ kind: "all", customers: [] })),
		// The S8 reads: the setup records the live check lists, and the payer's holds.
		liveCheckSetupCustomers: vi.fn(async () => ({ kind: "all", customers: [] })),
		// The over-cap dedupe's cap-state marker (#5989).
		newestUnlinkedSetupAt: vi.fn(async () => world.state.newestRecordAt),
		recordSetupRefusal: vi.fn(async () => null),
		// The hold readers run for real, over the fake database's `payment_holds` (above).
		paymentHoldsOfPayer: actual.paymentHoldsOfPayer,
		openPaymentHoldOn: actual.openPaymentHoldOn,
		latestReleasedHoldOn: actual.latestReleasedHoldOn,
	};
});

import {
	createNewOrgSubscriptionIntent,
	createSubscriptionIntent,
	linkSubscriptionToNewOrg,
	resolveNewOrgSetup,
} from "@/app/server/actions/billing";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { authorizeInOrg } from "@/lib/authz/guard";
import {
	findSetupOrg,
	forgetPendingOrgSetup,
	recordSetupRefusal,
	liveCheckSetupCustomers,
	openPendingOrgSetupsForOrg,
	unlinkedPendingOrgSetupCustomers,
} from "@/lib/billing/pending-org-setup";
import { getOrgBilling } from "@/lib/billing/queries";

/** A full `payment_holds` row, with `overrides`. */
function holdRow(overrides: Partial<PaymentHoldRow>): PaymentHoldRow {
	const now = new Date();
	return {
		id: "hold_seed",
		scope: "new_org",
		subscription_id: "sub_x",
		customer_id: "cus_1",
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

/** The record of `subscriptionId`, as `pendingOrgSetupFor` returns it. */
function setupRow(userId: string, subscriptionId: string) {
	const at = new Date("2026-10-03T12:00:00Z");
	return {
		id: `row_${subscriptionId}`,
		user_id: userId,
		subscription_id: subscriptionId,
		customer_id: "cus_1",
		intended_name: "Acme Cloud",
		intended_slug: "acme",
		billing: null,
		created_org_id: null,
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
}

/** Puts a subscription of user-1's create-a-team flow (unless `metadata` says otherwise) into Stripe. */
function sub(id: string, status: string, pis: string[] = ["requires_payment_method"], metadata: Record<string, string> = { created_by: "user-1" }, customer = "cus_1"): FakeSub {
	const s: FakeSub = { id, status, customer, latest_invoice: `in_${id}`, metadata, currency: "eur", created: 1 };
	world.state.subs.set(id, s);
	world.state.invoices.set(s.latest_invoice, status === "canceled" && pis.includes("succeeded") ? "paid" : "open");
	world.state.payments.set(s.latest_invoice, pis);
	return s;
}

/** Seeds an existing hold of user-1. */
function seedHold(overrides: Partial<PaymentHoldRow>): PaymentHoldRow {
	const hold = holdRow({ id: `hold_seed_${world.state.holds.length + 1}`, ...overrides });
	world.state.holds.push(hold);
	return hold;
}

/** The hold on `subscriptionId`, as the table holds it now. */
function holdOn(subscriptionId: string): PaymentHoldRow | undefined {
	return world.state.holds.find((h) => h.subscription_id === subscriptionId);
}

/** The message of a refusal, failing the test when the purchase was not refused. */
function refusalOf(r: Awaited<ReturnType<typeof createNewOrgSubscriptionIntent>>): string {
	if (r.kind !== "refused") throw new Error(`expected a refusal, got ${r.kind}`);
	// C32: no create-a-team refusal promises what nothing enforces.
	expect(r.message).not.toMatch(/charged (twice|again)/);
	return r.message;
}

const buy = (opts: { priorSubscriptionId?: string; customerId?: string } = { customerId: "cus_1" }) =>
	createNewOrgSubscriptionIntent("team", { orgName: "NewCo", ...opts });

beforeEach(() => {
	// RESET, not clear: a `mockRejectedValue` or `mockImplementation` one test sets must not leak into the
	// next. Every fake above is a `vi.fn(impl)`, which a reset returns to `impl`.
	vi.resetAllMocks();
	world.state.subs.clear();
	world.state.invoices.clear();
	world.state.payments.clear();
	world.state.refunds.clear();
	world.state.holds = [];
	world.state.onCancel = null;
	world.state.cancelFails = false;
	world.state.openFails = false;
	world.state.writeFailures = 0;
	world.state.leaseLost = false;
	world.state.activatesOnRead = null;
	world.state.newestRecordAt = null;
	world.state.deliveries = [];
	vi.unstubAllEnvs();
});

describe("I4 — a hold is written before anything is voided or cancelled, and the void comes first", () => {
	it("C11: the sweep opens a hold, voids the held invoice, then cancels stamped with the hold — and mints", async () => {
		sub("sub_dangling", "incomplete");

		const r = await buy();

		expect(r).toMatchObject({ kind: "intent", subscriptionId: "sub_new" });
		const hold = holdOn("sub_dangling");
		expect(hold).toMatchObject({ state: "released", release_reason: "voided_unpaid", invoice_id: "in_sub_dangling" });
		expect(world.stripe.invoices.voidInvoice).toHaveBeenCalledWith("in_sub_dangling");
		expect(world.stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_dangling", {
			cancellation_details: { comment: `alethia:checkout_closed:${hold?.id}` },
		});
		expect(world.stripe.invoices.voidInvoice.mock.invocationCallOrder[0]).toBeLessThan(
			world.stripe.subscriptions.cancel.mock.invocationCallOrder[0],
		);
		// Its record goes only after a release that proves it was never payable (§8).
		expect(forgetPendingOrgSetup).toHaveBeenCalledWith("user-1", expect.objectContaining({ id: "sub_dangling" }), "never_paid");
	});

	it("C15: a hold that cannot be written voids and cancels nothing, mints nothing, and promises no block", async () => {
		sub("sub_dangling", "incomplete");
		world.state.openFails = true;

		const message = refusalOf(await buy());

		expect(message).not.toMatch(/blocked|won't be charged/);
		expect(world.stripe.invoices.voidInvoice).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.cancel).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});
});

describe("I1 (a) — every open hold of the user blocks the mint, wherever the browser points", () => {
	it("C1, the gap test flipped: a payment processing after the cancel refuses, and so does the retry", async () => {
		sub("sub_prior", "incomplete");
		world.state.onCancel = (id) => world.state.payments.set(`in_${id}`, ["processing"]);

		expect(refusalOf(await buy({ priorSubscriptionId: "sub_prior" }))).toMatch(/still being processed/);
		expect(holdOn("sub_prior")?.state).toBe("payment_in_flight");

		expect(refusalOf(await buy({ priorSubscriptionId: "sub_prior" }))).toMatch(/still being processed/);
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("C7, C38: the same hold refuses with the prior lost, the customer lost, or both — found by the session user", async () => {
		sub("sub_prior", "canceled", ["processing"], { created_by: "user-1" }, "cus_other");
		seedHold({ subscription_id: "sub_prior", customer_id: "cus_other", invoice_id: "in_sub_prior", state: "payment_in_flight", last_pay: "in_flight" });

		for (const opts of [{ priorSubscriptionId: "sub_prior", customerId: "cus_1" }, { customerId: "cus_1" }, {}]) {
			expect(refusalOf(await buy(opts))).toMatch(/still being processed/);
		}
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
		// C37: holds are a database read by payer, never a search.
		expect(world.stripe.subscriptions.search).not.toHaveBeenCalled();
	});

	it("C13: a cancel that fails leaves the hold cancel_unproven; it refuses, and the retry refuses too", async () => {
		sub("sub_prior", "incomplete");
		world.state.cancelFails = true;

		expect(refusalOf(await buy({ priorSubscriptionId: "sub_prior" }))).toMatch(/could not confirm an earlier checkout was closed/);
		expect(holdOn("sub_prior")?.state).toBe("cancel_unproven");
		expect(refusalOf(await buy())).toMatch(/could not confirm an earlier checkout was closed/);
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
		// §8: a record is dropped only after a release that proves it never payable — not under an open hold.
		expect(forgetPendingOrgSetup).not.toHaveBeenCalled();
	});

	it("C16: a failed cancel AND a failed state write after it leave the hold open — the next purchase is refused", async () => {
		sub("sub_prior", "incomplete");
		world.state.cancelFails = true;
		world.state.writeFailures = 1;

		await expect(buy({ priorSubscriptionId: "sub_prior" })).rejects.toThrow(/database is unavailable/);
		expect(holdOn("sub_prior")?.state).toBe("closing");

		expect(refusalOf(await buy())).toMatch(/could not confirm an earlier checkout was closed/);
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("C6, C34: a canceled prior under a payment_in_flight hold refuses; with no hold and a paid invoice it mints and refunds nothing", async () => {
		sub("sub_prior", "canceled", ["processing"]);
		seedHold({ subscription_id: "sub_prior", invoice_id: "in_sub_prior", state: "payment_in_flight", last_pay: "in_flight" });
		refusalOf(await buy({ priorSubscriptionId: "sub_prior", customerId: "cus_1" }));
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();

		world.state.holds = [];
		sub("sub_paid_once", "canceled", ["succeeded"]);
		await expect(buy({ priorSubscriptionId: "sub_paid_once", customerId: "cus_1" })).resolves.toMatchObject({ kind: "intent" });
		expect(world.stripe.refunds.create).not.toHaveBeenCalled();
		expect(world.stripe.invoices.voidInvoice).not.toHaveBeenCalled();
		expect(holdOn("sub_paid_once")).toBeUndefined();
	});

	it("a canceled prior with no hold whose invoice is still open is closed under a hold before the mint", async () => {
		sub("sub_prior", "canceled");

		await expect(buy({ priorSubscriptionId: "sub_prior", customerId: "cus_1" })).resolves.toMatchObject({ kind: "intent" });
		expect(holdOn("sub_prior")).toMatchObject({ state: "released", release_reason: "voided_unpaid" });
		expect(world.stripe.invoices.voidInvoice.mock.invocationCallOrder[0]).toBeLessThan(
			world.stripe.subscriptions.create.mock.invocationCallOrder[0],
		);
	});

	it("C35: a prior another user minted is never held, voided or cancelled", async () => {
		sub("sub_theirs", "incomplete", ["requires_payment_method"], { created_by: "intruder" });

		await expect(buy({ priorSubscriptionId: "sub_theirs", customerId: "cus_1" })).resolves.toMatchObject({ kind: "intent" });
		expect(holdOn("sub_theirs")).toBeUndefined();
		expect(world.stripe.subscriptions.cancel).not.toHaveBeenCalled();
	});
});

describe("the sweep's kept subscriptions, and the copy (§5.5)", () => {
	it.each([
		["processing", /still being processed.*several business days/],
		["requires_capture", /authorised but not completed/],
		["succeeded", /just gone through/],
	])("C36: an incomplete prior whose payment is %s is kept — no hold, no cancel — with its own clause", async (pi, clause) => {
		sub("sub_prior", "incomplete", [pi]);

		expect(refusalOf(await buy({ priorSubscriptionId: "sub_prior" }))).toMatch(clause);
		expect(holdOn("sub_prior")).toBeUndefined();
		expect(world.stripe.subscriptions.cancel).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("C39: an incomplete subscription with no payment at all is kept, and the copy never says 'a minute'", async () => {
		sub("sub_dangling", "incomplete", []);

		const message = refusalOf(await buy());
		expect(message).toMatch(/still open and we could not confirm it is unpaid/);
		expect(message).not.toMatch(/a minute/);
	});

	it("C26: a hold refunded last week and one in flight — the message carries both clauses", async () => {
		seedHold({ subscription_id: "sub_a", state: "released", release_reason: "refunded", released_at: new Date(Date.now() - 6 * 86_400_000) });
		sub("sub_b", "canceled", ["processing"]);
		seedHold({ subscription_id: "sub_b", invoice_id: "in_sub_b", state: "payment_in_flight", last_pay: "in_flight" });

		const message = refusalOf(await buy());
		expect(message).toMatch(/still being processed/);
		expect(message).toMatch(/refunded in full/);
	});

	it("C31: a needs_operator hold claims an alert only when one reached a channel", async () => {
		sub("sub_x", "unpaid");
		seedHold({ state: "needs_operator" });
		const unalerted = refusalOf(await buy());
		expect(unalerted).toMatch(/Contact support/);
		expect(unalerted).not.toMatch(/raised an alert/);

		world.state.holds = [];
		seedHold({ state: "needs_operator", alerted_at: new Date() });
		expect(refusalOf(await buy())).toMatch(/raised an alert/);

		// An alert from an EARLIER state entry (T3b in cancel_unproven) is not this entry's.
		world.state.holds = [];
		seedHold({ state: "needs_operator", alerted_at: new Date(Date.now() - 3_600_000), state_since: new Date() });
		expect(refusalOf(await buy())).not.toMatch(/raised an alert/);
	});

	it("C56: an invoice_payable hold refuses with its own clause", async () => {
		sub("sub_x", "canceled");
		world.stripe.invoices.voidInvoice.mockRejectedValue(new Error("Stripe is unavailable"));
		seedHold({ state: "invoice_payable", last_pay: "awaiting" });

		expect(refusalOf(await buy())).toMatch(/could not yet close an earlier checkout's invoice/);
	});

	it("C56: a refund_due hold whose refund fails again refuses with its own clause", async () => {
		sub("sub_x", "canceled", ["succeeded"]);
		world.stripe.refunds.create.mockRejectedValue(new Error("Stripe is unavailable"));
		seedHold({ state: "refund_due", last_pay: "succeeded" });

		expect(refusalOf(await buy())).toMatch(/Its refund has not gone through yet/);
		expect(holdOn("sub_x")?.state).toBe("refund_due");
	});

	it("C56: a minting response within 14 days of a refund carries the refund clause in `notice`; a refund_pending one warns of two charges", async () => {
		seedHold({ subscription_id: "sub_a", state: "released", release_reason: "refunded", released_at: new Date(Date.now() - 86_400_000) });
		await expect(buy()).resolves.toMatchObject({ kind: "intent", notice: expect.stringMatching(/refunded in full/) });

		sub("sub_b", "canceled", ["succeeded"]);
		world.state.refunds.set("pi_in_sub_b_0", [{ status: "pending", amount: 1000 }]);
		seedHold({ subscription_id: "sub_b", invoice_id: "in_sub_b", state: "refund_pending", last_pay: "succeeded" });
		await expect(buy()).resolves.toMatchObject({ kind: "intent", notice: expect.stringMatching(/both charges/) });

		world.state.holds = [];
		seedHold({ subscription_id: "sub_a", state: "released", release_reason: "refunded", released_at: new Date(Date.now() - 15 * 86_400_000) });
		const late = await buy();
		expect(late).toMatchObject({ kind: "intent" });
		expect(late.kind === "intent" ? late.notice : "not minted").toBeUndefined();
	});
});

describe("ADR 0004 D1 rule 3 — the create-a-team readers read new_org holds only", () => {
	it("C1 (pin): an open org_plan hold of an org the user bought for does not block the user's create-a-team purchase", async () => {
		seedHold({
			scope: "org_plan",
			payer_key: "org-1",
			opened_by_user_id: "user-1",
			subscription_id: "sub_org_plan",
			customer_id: "cus_org",
			invoice_id: "in_sub_org_plan",
			state: "payment_in_flight",
			last_pay: "in_flight",
		});

		expect(await buy()).toMatchObject({ kind: "intent", subscriptionId: "sub_new" });
		expect(holdOn("sub_org_plan")).toMatchObject({ state: "payment_in_flight", version: 0 });
	});

	it("an org_plan hold whose payer_key EQUALS the user id still does not block: scope, not the key's text, decides", async () => {
		seedHold({
			scope: "org_plan",
			payer_key: "user-1",
			opened_by_user_id: null,
			subscription_id: "sub_org_plan",
			customer_id: "cus_org",
			invoice_id: "in_sub_org_plan",
			state: "payment_in_flight",
			last_pay: "in_flight",
		});

		expect(await buy()).toMatchObject({ kind: "intent", subscriptionId: "sub_new" });
		expect(holdOn("sub_org_plan")).toMatchObject({ state: "payment_in_flight", version: 0 });
	});

	it("C2: an org_plan hold on a linked create-a-team X: the resume reports no hold, and the link is not refused with it", async () => {
		sub("sub_linked", "canceled", ["requires_payment_method"], { created_by: "user-1", organization_id: "org-1" });
		seedHold({
			scope: "org_plan",
			payer_key: "org-1",
			opened_by_user_id: null,
			subscription_id: "sub_linked",
			invoice_id: "in_sub_linked",
			state: "closing",
			last_pay: "awaiting",
		});
		vi.mocked(findSetupOrg).mockResolvedValue({ id: "org-1", slug: "acme" });

		const resumed = await resolveNewOrgSetup({ subscriptionId: "sub_linked", customerId: "cus_1" });
		expect(resumed).toMatchObject({ subscriptionId: "sub_linked", hold: null });

		vi.mocked(authorizeInOrg).mockResolvedValue({ orgId: "org-1", userId: "user-1" });
		const linked = await linkSubscriptionToNewOrg({ orgId: "org-1", subscriptionId: "sub_linked", customerId: "cus_1" });
		// The link's hold consult saw no hold, so it judged X on its own read (ended), not on the org's hold.
		expect(recordSetupRefusal).not.toHaveBeenCalledWith(expect.objectContaining({ refused: "held" }));
		expect(recordSetupRefusal).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "sub_linked", refused: "ended" }));
		expect(linked).toMatchObject({ kind: "refused" });
		// The org's hold was neither advanced nor touched.
		expect(holdOn("sub_linked")).toMatchObject({ scope: "org_plan", state: "closing", version: 0 });
	});
});

describe("I1 (c) — the live check, read last (§4.3)", () => {
	it("C24: an active, unlinked create-a-team subscription the webhook has not written is resumed — nothing is minted", async () => {
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "all", customers: ["cus_recorded"] });
		sub("sub_live", "active", ["succeeded"], { created_by: "user-1" }, "cus_recorded");

		await expect(buy()).resolves.toMatchObject({ kind: "resume", setup: { subscriptionId: "sub_live" } });
		expect(world.stripe.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_recorded", status: "all" }));
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("C94: the live check reads its own record set — a record whose org exists, which the reuse helper leaves out", async () => {
		vi.mocked(unlinkedPendingOrgSetupCustomers).mockResolvedValue({ kind: "all", customers: [] });
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "all", customers: ["cus_with_org"] });
		sub("sub_live", "active", ["succeeded"], { created_by: "user-1" }, "cus_with_org");

		await expect(buy({})).resolves.toMatchObject({ kind: "resume" });
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("an adoption in the hold pass is seen by the live check that runs after it — on the hold's own customer", async () => {
		// The hold's customer is named by nothing else: neither the browser, nor a record.
		sub("sub_x", "active", ["succeeded"], { created_by: "user-1" }, "cus_hold");
		seedHold({ state: "cancel_unproven", last_pay: "succeeded", customer_id: "cus_hold" });

		await expect(buy()).resolves.toMatchObject({ kind: "resume", setup: { subscriptionId: "sub_x" } });
		expect(holdOn("sub_x")).toMatchObject({ state: "released", release_reason: "adopted" });
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("an adoption by the SWEEP's own close is seen too: the live check runs after the sweep", async () => {
		sub("sub_landing", "incomplete");
		world.state.activatesOnRead = "sub_landing";

		await expect(buy()).resolves.toMatchObject({ kind: "resume", setup: { subscriptionId: "sub_landing" } });
		expect(holdOn("sub_landing")).toMatchObject({ state: "released", release_reason: "adopted" });
		expect(world.stripe.subscriptions.cancel).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("advisory 1: an incomplete X still settling on a record whose team exists is swept too — never minted beside", async () => {
		// The browser lost its customer; the only record names a team, so the reuse helper leaves it out.
		vi.mocked(unlinkedPendingOrgSetupCustomers).mockResolvedValue({ kind: "all", customers: [] });
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "all", customers: ["cus_with_org"] });
		sub("sub_settling", "incomplete", ["processing"], { created_by: "user-1" }, "cus_with_org");

		expect(refusalOf(await buy({}))).toMatch(/still being processed/);
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("over the live check's record cap, a paid prior still resumes — the cap is read after the resume and the hold pass", async () => {
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });
		sub("sub_paid", "active", ["succeeded"]);

		await expect(buy({ priorSubscriptionId: "sub_paid" })).resolves.toMatchObject({
			kind: "resume",
			setup: { subscriptionId: "sub_paid" },
		});
	});

	it("over the live check's record cap, the refusal raises an operator alert, and nothing is minted", async () => {
		vi.stubEnv("ALETHIA_PLATFORM_ALERT_ORG_ID", "org-platform");
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });

		expect(refusalOf(await buy())).toMatch(/more unfinished checkouts than we can check automatically/);
		expect(emitAlertEvent).toHaveBeenCalledWith(
			"org-platform",
			"system.platform.payment_needs_support",
			expect.objectContaining({ resource_type: "user", resource_id: "user-1" }),
		);
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
		expect(world.stripe.customers.create).not.toHaveBeenCalled();
	});

	it("a live check that cannot list refuses — it never mints on a read it did not make", async () => {
		world.stripe.subscriptions.list.mockImplementation(async (p: { status: string }) => {
			if (p.status === "all") throw new Error("Stripe is unavailable");
			return { has_more: false, data: [] };
		});

		expect(refusalOf(await buy())).toMatch(/could not check your earlier checkouts/);
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});
});

describe("§4.4 rule 1 — a lease lost under the hold pass", () => {
	it("stops before any Stripe write, refuses as not this request's to finish, and leaves the hold open", async () => {
		sub("sub_x", "incomplete");
		seedHold({ state: "closing" });
		world.state.leaseLost = true;

		expect(refusalOf(await buy())).toMatch(/took too long and was stopped/);
		expect(world.stripe.invoices.voidInvoice).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.cancel).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
		expect(holdOn("sub_x")?.state).toBe("closing");
	});
});

describe("§5.7 — the guard's creator message carries an open hold's clause", () => {
	it("the creator of a held setup reads the hold's clause, then where to go", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(openPendingOrgSetupsForOrg).mockResolvedValue([{ ...setupRow("user-1", "sub_x"), created_org_id: "org-1" }]);
		seedHold({ state: "payment_in_flight", last_pay: "in_flight" });

		const r = await createSubscriptionIntent("team");

		expect(r).toEqual({ error: expect.stringMatching(/^An earlier checkout's payment is still being processed.*Open Create a team/) });
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("a refund_pending hold keeps the refusal's own sentence, and never says 'if you buy again now'", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(openPendingOrgSetupsForOrg).mockResolvedValue([{ ...setupRow("user-1", "sub_x"), created_org_id: "org-1" }]);
		seedHold({ state: "refund_pending", last_pay: "succeeded" });

		const r = await createSubscriptionIntent("team");

		expect(r).toEqual({ error: expect.stringMatching(/^Your paid setup .* cannot be started here yet\. .*issued its refund/) });
		expect(r).not.toEqual({ error: expect.stringMatching(/buy again/) });
	});
});

describe("§5.5 — a refusal never invites a purchase", () => {
	it("a refund_pending hold beside a blocking one says the refund was issued, not 'if you buy again now'", async () => {
		sub("sub_a", "canceled", ["succeeded"]);
		world.state.refunds.set("pi_in_sub_a_0", [{ status: "pending", amount: 1000 }]);
		seedHold({ subscription_id: "sub_a", invoice_id: "in_sub_a", state: "refund_pending", last_pay: "succeeded" });
		sub("sub_b", "canceled", ["processing"]);
		seedHold({ subscription_id: "sub_b", invoice_id: "in_sub_b", state: "payment_in_flight", last_pay: "in_flight" });

		const message = refusalOf(await buy());
		expect(message).toMatch(/issued its refund/);
		expect(message).not.toMatch(/buy again/);
	});
});

describe("#5989 — the over-cap refusal alerts once per cap state, and says what fixes it", () => {
	/** An `emitAlertEvent` that routes to one channel: it writes a delivery row, as the real one does. */
	const deliverAlerts = () =>
		vi.mocked(emitAlertEvent).mockImplementation(async (_org, event, context) => {
			world.state.deliveries.push({ resource_id: context.resource_id ?? "", event_key: event, status: "pending", created_at: new Date() });
			return 1;
		});
	/** The operator alerts raised about user-1, in order. */
	const userAlerts = () => vi.mocked(emitAlertEvent).mock.calls.filter(([, , c]) => c.resource_id === "user-1");

	beforeEach(() => {
		vi.stubEnv("ALETHIA_PLATFORM_ALERT_ORG_ID", "org-platform");
		world.state.newestRecordAt = new Date(Date.now() - 60_000);
	});

	it("the live check over its cap: the first refusal alerts with the fix, a user who stays at the cap is not paged again, and the refusal never changes", async () => {
		deliverAlerts();
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });

		const first = refusalOf(await buy());
		const second = refusalOf(await buy());
		const third = refusalOf(await buy({}));

		expect(first).toMatch(/more unfinished checkouts than we can check automatically/);
		expect([second, third]).toEqual([first, first]);
		expect(userAlerts()).toHaveLength(1);
		expect(userAlerts()[0]?.[2]).toMatchObject({
			resource_type: "user",
			summary: expect.stringMatching(/To fix it: .*linked_at IS NULL.*at most 50 distinct Stripe customers/),
		});
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("a newer setup record starts a new cap state: the next refusal alerts again", async () => {
		deliverAlerts();
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });

		refusalOf(await buy());
		world.state.newestRecordAt = new Date(Date.now() + 1_000);
		refusalOf(await buy());

		expect(userAlerts()).toHaveLength(2);
	});

	it("an alert that reached no channel silences nothing: the next refusal alerts again", async () => {
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });

		refusalOf(await buy());
		refusalOf(await buy());

		expect(userAlerts()).toHaveLength(2);
	});

	it("only a live delivery of the operator event about THIS user silences it: a dead one, another event's, or another resource's does not", async () => {
		vi.mocked(emitAlertEvent).mockResolvedValue(0);
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });
		const after = new Date(Date.now() - 1_000);
		world.state.deliveries.push(
			{ resource_id: "user-1", event_key: "system.platform.payment_needs_support", status: "dead", created_at: after },
			{ resource_id: "user-1", event_key: "system.platform.other_event", status: "pending", created_at: after },
			{ resource_id: "sub_x", event_key: "system.platform.payment_needs_support", status: "pending", created_at: after },
		);

		refusalOf(await buy());
		expect(userAlerts()).toHaveLength(1);

		world.state.deliveries.push({ resource_id: "user-1", event_key: "system.platform.payment_needs_support", status: "sent", created_at: after });
		refusalOf(await buy());
		expect(userAlerts()).toHaveLength(1);
	});

	it("the reuse set over its cap refuses the same way, alerts once with the fix, and shares the live check's cap state", async () => {
		deliverAlerts();
		vi.mocked(unlinkedPendingOrgSetupCustomers).mockResolvedValue({ kind: "over_cap" });

		const first = refusalOf(await buy());
		vi.mocked(unlinkedPendingOrgSetupCustomers).mockResolvedValue({ kind: "all", customers: [] });
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "over_cap" });
		const second = refusalOf(await buy());

		expect(second).toBe(first);
		expect(userAlerts()).toHaveLength(1);
		expect(userAlerts()[0]?.[2]).toMatchObject({ summary: expect.stringMatching(/To fix it: /) });
	});
});

describe("#5989 — a refused purchase mints no Stripe customer", () => {
	/** The browser lost its customer, and no record names one this purchase may reuse: a customer would be minted. */
	const noReusableCustomer = () => {
		vi.mocked(unlinkedPendingOrgSetupCustomers).mockResolvedValue({ kind: "all", customers: [] });
		vi.mocked(liveCheckSetupCustomers).mockResolvedValue({ kind: "all", customers: ["cus_with_org"] });
	};

	it("a payment still settling refuses the purchase and its retry, and neither creates a customer", async () => {
		noReusableCustomer();
		sub("sub_settling", "incomplete", ["processing"], { created_by: "user-1" }, "cus_with_org");

		expect(refusalOf(await buy({}))).toMatch(/still being processed/);
		expect(refusalOf(await buy({}))).toMatch(/still being processed/);
		expect(world.stripe.customers.create).not.toHaveBeenCalled();
		expect(world.stripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("a sweep that cannot list refuses and creates no customer", async () => {
		noReusableCustomer();
		world.stripe.subscriptions.list.mockRejectedValue(new Error("Stripe is unavailable"));

		expect(refusalOf(await buy({}))).toMatch(/could not check your earlier checkouts/);
		expect(world.stripe.customers.create).not.toHaveBeenCalled();
	});

	it("a live check that cannot list refuses and creates no customer", async () => {
		noReusableCustomer();
		world.stripe.subscriptions.list.mockImplementation(async (p: { status: string }) => {
			if (p.status === "all") throw new Error("Stripe is unavailable");
			return { has_more: false, data: [] };
		});

		expect(refusalOf(await buy({}))).toMatch(/could not check your earlier checkouts/);
		expect(world.stripe.customers.create).not.toHaveBeenCalled();
	});

	it("a live subscription the live check finds is resumed, and no customer is created for it", async () => {
		noReusableCustomer();
		sub("sub_live", "active", ["succeeded"], { created_by: "user-1" }, "cus_with_org");

		await expect(buy({})).resolves.toMatchObject({ kind: "resume" });
		expect(world.stripe.customers.create).not.toHaveBeenCalled();
	});

	it("a purchase that mints still creates exactly one customer — after every check — and mints on it", async () => {
		noReusableCustomer();

		await expect(buy({})).resolves.toMatchObject({ kind: "intent", customerId: "cus_created" });
		expect(world.stripe.customers.create).toHaveBeenCalledTimes(1);
		const created = world.stripe.customers.create.mock.invocationCallOrder[0] ?? 0;
		const lastList = Math.max(...world.stripe.subscriptions.list.mock.invocationCallOrder);
		expect(created).toBeGreaterThan(lastList);
		expect(world.stripe.subscriptions.create).toHaveBeenCalledWith(
			expect.objectContaining({ customer: "cus_created" }),
			expect.anything(),
		);
	});
});
