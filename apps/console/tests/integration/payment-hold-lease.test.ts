// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the user's purchase lease (ADR 0002 §4.4, S2, #5741) against real Postgres — ADR 0002's
// `L` cases. The action tests run the purchase over an in-memory lease, so they would stay green if the
// SQL stopped excluding anyone. These pin the lease itself, and the create-a-team purchase over it:
//
//   C25  two holders: the second waits — WITHOUT holding a connection — and gets the lease only when the
//        first gives it back; an expired lease is taken over; the stale holder's renewal (the fence every
//        Stripe write runs behind) then matches no row, and its release leaves the new holder's row alone.
//        The hold-write half of C25 needs `payment_holds`, which S4 adds: from S4 a hold's state write
//        carries the same `key AND holder` predicate in its own statement.
//   C28  two purchases of one user, started at once, never run side by side.
//   C52  A's lease expires before `subscriptions.create`; B takes it over and mints. Exactly ONE client
//        secret is returned. After A's failed gate its only Stripe writes are `voidInvoice` on its own
//        subscription Z's first invoice and a `cancel` stamped `alethia:closeout`, and nothing records Z.
//        Variant: A's close-out cannot prove the void, so Z is never cancelled; B's next purchase sweeps it.
//   ---  for one release the purchase also takes the old `new-org:<user>` advisory key, so a pod still
//        running the older build and a pod running this one exclude each other.
//   ---  the shared Stripe client carries the timeout the mint deadline is computed from.
//   ---  RLS: `purchase_leases` is service-role only.
//
// Stripe is the one boundary faked here, as in pending-org-setups.test.ts; the lease, the advisory lock
// and the setup record are real.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

/** One subscription in the fake Stripe account. */
interface FakeSub {
	id: string;
	customer: string;
	status: string;
	latest_invoice: string;
	metadata: Record<string, string>;
}

const fake = vi.hoisted(() => {
	const subs = new Map<string, FakeSub>();
	const invoices = new Map<string, { status: string }>();
	// Every Stripe WRITE, in order, with the request that made it ("A" or "B").
	const writes: { by: string; call: string; id: string; params?: unknown }[] = [];
	const state = {
		// The user every fake customer was minted by.
		userId: "",
		// Which request is making the next writes; set only where the two never run at once.
		by: "A",
		// When set, `subscriptions.create` awaits it before answering — the stalled request.
		stallMint: null as Promise<void> | null,
		// When true, `invoices.voidInvoice` fails and the invoice stays `open` — a close-out that cannot prove its void.
		voidFails: false,
		minted: 0,
	};
	return { subs, invoices, writes, state };
});

const fakeStripe = vi.hoisted(() => ({
	customers: {
		retrieve: vi.fn(async (id: string) => ({ id, deleted: false, metadata: { created_by: fake.state.userId } })),
		create: vi.fn(),
		update: vi.fn(),
	},
	subscriptions: {
		list: vi.fn(async (q: { customer: string; status: string }) => ({
			has_more: false,
			data: [...fake.subs.values()].filter((s) => s.customer === q.customer && s.status === q.status),
		})),
		retrieve: vi.fn(async (id: string) => fake.subs.get(id)),
		create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }, opts: { idempotencyKey: string }) => {
			const by = fake.state.by;
			fake.writes.push({ by, call: "subscriptions.create", id: opts.idempotencyKey });
			if (fake.state.stallMint) {
				const stall = fake.state.stallMint;
				fake.state.stallMint = null;
				await stall;
			}
			fake.state.minted += 1;
			const id = `sub_it_lease_${fake.state.minted}_${randomUUIDish()}`;
			const invoiceId = `in_${id}`;
			fake.invoices.set(invoiceId, { status: "open" });
			fake.subs.set(id, { id, customer: params.customer, status: "incomplete", latest_invoice: invoiceId, metadata: params.metadata });
			return {
				id,
				customer: params.customer,
				status: "incomplete",
				metadata: params.metadata,
				latest_invoice: { id: invoiceId, confirmation_secret: { client_secret: `cs_${id}` } },
			};
		}),
		cancel: vi.fn(async (id: string, params?: unknown) => {
			fake.writes.push({ by: fake.state.by, call: "subscriptions.cancel", id, params });
			const sub = fake.subs.get(id);
			if (sub) sub.status = "canceled";
			return sub;
		}),
	},
	invoices: {
		retrieve: vi.fn(async (id: string) => ({ id, status: fake.invoices.get(id)?.status ?? "open" })),
		voidInvoice: vi.fn(async (id: string) => {
			fake.writes.push({ by: fake.state.by, call: "invoices.voidInvoice", id });
			if (fake.state.voidFails) throw new Error("Stripe is unavailable");
			const invoice = fake.invoices.get(id);
			if (invoice) invoice.status = "void";
			return { id, status: "void" };
		}),
	},
	// Every first invoice awaits the customer: provably never paid.
	invoicePayments: {
		list: vi.fn(async () => ({
			has_more: false,
			data: [{ status: "open", payment: { type: "payment_intent", payment_intent: { id: "pi_it", status: "requires_payment_method" } } }],
		})),
	},
	paymentIntents: { retrieve: vi.fn() },
	refunds: { create: vi.fn() },
}));

/** A short random suffix, available inside the hoisted fake. */
function randomUUIDish(): string {
	return Math.random().toString(36).slice(2, 10);
}

vi.mock("@/lib/billing/stripe", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/billing/stripe")>();
	return { ...actual, getStripe: () => fakeStripe };
});
// The paid-conversion gate refuses by default (PAID_MARKETS is empty); it is not what this file tests.
vi.mock("@/lib/billing/eligibility", () => ({ assertPaidConversionAllowed: vi.fn(async () => undefined) }));

import { createNewOrgSubscriptionIntent } from "@/app/server/actions/billing";
import { runWithActor } from "@/lib/authz/actor-context";
import type { Actor, Entitlements } from "@/lib/authz/types";
import {
	acquirePurchaseLease,
	fenceFor,
	PurchaseLeaseLostError,
	releasePurchaseLease,
	renewPurchaseLease,
	tryAcquirePurchaseLease,
} from "@/lib/billing/purchase-lease";
import { withPurchaseLock } from "@/lib/billing/purchase-lock";
import { getServiceDb, withScope } from "@/lib/db";
import { pendingOrgSetups, purchaseLeases, user } from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Resolves once `check` is true, polling every 20ms for up to `ms`. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
	const until = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > until) throw new Error("timed out waiting for the condition");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** Pushes `key`'s lease into the past, as if its holder had stalled past its lifetime. */
async function expireLease(key: string): Promise<void> {
	await getServiceDb()
		.update(purchaseLeases)
		.set({ expires_at: sql`now() - interval '1 second'` })
		.where(eq(purchaseLeases.key, key));
}

/** The holder `key`'s row names right now, or null when there is no row. */
async function holderOf(key: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ holder: purchaseLeases.holder })
		.from(purchaseLeases)
		.where(eq(purchaseLeases.key, key));
	return row?.holder ?? null;
}

describeIfDb("purchase_leases — C25: the lease row, its takeover and its fence", () => {
	it("a second taker is refused while the first holds it, and waits for it WITHOUT holding a connection", async () => {
		const key = `it-lease:${randomUUID()}`;
		const first = await tryAcquirePurchaseLease(key);
		if (!first) throw new Error("fixture: the first taker did not get a free lease");
		expect(await tryAcquirePurchaseLease(key)).toBeNull();

		let second: Awaited<ReturnType<typeof acquirePurchaseLease>> | undefined;
		const waiting = acquirePurchaseLease(key, 10_000).then((lease) => {
			second = lease;
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(second).toBeUndefined();
		// The advisory lock this replaces kept a session in an open transaction, blocked on a lock, for
		// the whole wait. The lease's waiter holds nothing between polls.
		const busy = await getServiceDb().execute(sql`
			select count(*)::int as n from pg_stat_activity
			where datname = current_database() and pid <> pg_backend_pid()
			  and (state = 'idle in transaction' or wait_event_type = 'Lock')`);
		expect(busy[0]?.n).toBe(0);

		await releasePurchaseLease(first);
		await waiting;
		expect(second?.holder).toBeDefined();
		expect(second?.holder).not.toBe(first.holder);
		if (second) await releasePurchaseLease(second);
	});

	it("a lease that is not taken back within the wait is not taken at all", async () => {
		const key = `it-lease:${randomUUID()}`;
		const first = await tryAcquirePurchaseLease(key);
		if (!first) throw new Error("fixture: the first taker did not get a free lease");
		expect(await acquirePurchaseLease(key, 400)).toBeNull();
		expect(await holderOf(key)).toBe(first.holder);
		await releasePurchaseLease(first);
	});

	it("an expired lease is taken over; the stale holder's renewal and fence then fail, and its release leaves the new row alone", async () => {
		const key = `it-lease:${randomUUID()}`;
		const stale = await tryAcquirePurchaseLease(key);
		if (!stale) throw new Error("fixture: the first taker did not get a free lease");
		expect(await renewPurchaseLease(stale)).toBe(true);

		await expireLease(key);
		const taker = await tryAcquirePurchaseLease(key);
		if (!taker) throw new Error("an expired lease was not taken over");
		expect(await holderOf(key)).toBe(taker.holder);

		expect(await renewPurchaseLease(stale)).toBe(false);
		await expect(fenceFor(stale)()).rejects.toBeInstanceOf(PurchaseLeaseLostError);
		await releasePurchaseLease(stale);
		expect(await holderOf(key)).toBe(taker.holder);

		await expect(fenceFor(taker)()).resolves.toBeUndefined();
		await releasePurchaseLease(taker);
		expect(await holderOf(key)).toBeNull();
	});

	it("a renewal reports the lease's remaining time by the database's clock (the mint deadline)", async () => {
		const key = `it-lease:${randomUUID()}`;
		const lease = await tryAcquirePurchaseLease(key);
		if (!lease) throw new Error("fixture: the first taker did not get a free lease");
		expect(await renewPurchaseLease(lease, 50_000)).toBe(true);
		expect(await renewPurchaseLease(lease, 121_000)).toBe(false);
		await releasePurchaseLease(lease);
	});

	it("RLS: the table is service-role only — RLS enabled, no policy, and the app role cannot read it", async () => {
		const [rls] = await getServiceDb().execute(sql`
			select c.relrowsecurity as rls,
			       (select count(*)::int from pg_policies p where p.tablename = 'purchase_leases') as policies
			from pg_class c where c.relname = 'purchase_leases'`);
		expect(rls).toEqual({ rls: true, policies: 0 });
	});

	it.skipIf(!APP_ROLE_DISTINCT)("RLS: an app-role session can neither read nor take a lease", async () => {
		const owner = randomUUID();
		const read = await refusalText(() =>
			withScope({ ownerId: owner, orgId: owner }, (tx) => tx.select().from(purchaseLeases)),
		);
		expect(read).toMatch(/permission denied/);
		const write = await refusalText(() =>
			withScope({ ownerId: owner, orgId: owner }, (tx) =>
				tx.insert(purchaseLeases).values({ key: `user:${owner}`, holder: randomUUID(), expires_at: new Date() }),
			),
		);
		expect(write).toMatch(/permission denied/);
	});
});

const ENTITLEMENTS: Entitlements = {
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	quotas: { maxConcurrentJobs: null, priorityLevel: 30, includedRunnerMinutes: 0, activityRetentionDays: 365 },
};

describeIfDb("the create-a-team purchase under the lease — C28, C52 and the old advisory key", () => {
	const USER = randomUUID();
	const CUSTOMER = `cus_it_lease_${randomUUID().slice(0, 8)}`;
	const KEY = `user:${USER}`;
	const actor: Actor = { userId: USER, orgId: USER, entitlements: ENTITLEMENTS };
	const saved: Record<string, string | undefined> = {};

	/** The purchase as request `by` ("A" or "B") makes it, on the user's one customer. */
	function purchase(by: string): ReturnType<typeof createNewOrgSubscriptionIntent> {
		return runWithActor(actor, async () => {
			fake.state.by = by;
			return createNewOrgSubscriptionIntent("team", { orgName: "Leased", customerId: CUSTOMER, currency: "eur" });
		});
	}

	beforeAll(async () => {
		for (const k of ["STRIPE_SECRET_KEY", "STRIPE_PRICE_TEAM"]) saved[k] = process.env[k];
		process.env.STRIPE_SECRET_KEY = "sk_test_integration_never_used";
		process.env.STRIPE_PRICE_TEAM = "price_it_team";
		fake.state.userId = USER;
		await getServiceDb().insert(user).values({ id: USER, email: `it-lease-${USER}@example.test` });
	});

	beforeEach(() => {
		fake.subs.clear();
		fake.invoices.clear();
		fake.writes.length = 0;
		fake.state.stallMint = null;
		fake.state.voidFails = false;
	});

	afterAll(async () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		const db = getServiceDb();
		await db.delete(pendingOrgSetups).where(eq(pendingOrgSetups.user_id, USER));
		await db.delete(purchaseLeases).where(eq(purchaseLeases.key, KEY));
		await db.delete(user).where(eq(user.id, USER));
	});

	it("the shared Stripe client has the timeout the mint deadline is computed from", async () => {
		const actual = await vi.importActual<typeof import("@/lib/billing/stripe")>("@/lib/billing/stripe");
		const client = actual.getStripe();
		expect(client.getApiField("timeout")).toBe(actual.STRIPE_REQUEST_TIMEOUT_MS);
		expect(actual.STRIPE_REQUEST_TIMEOUT_MS).toBe(20_000);
		expect(client.getMaxNetworkRetries()).toBe(1);
	});

	it("C28: two purchases started at once run one after the other, and the second sweeps the first's subscription", async () => {
		const [a, b] = await Promise.all([purchase("A"), purchase("B")]);
		const kinds = [a.kind, b.kind];
		expect(kinds).toEqual(["intent", "intent"]);
		// The second one's sweep found the first's subscription `incomplete` and closed it before minting:
		// at most one payable create-a-team subscription at a time.
		const open = [...fake.subs.values()].filter((s) => s.status === "incomplete");
		expect(open).toHaveLength(1);
		expect(await holderOf(KEY)).toBeNull();
	});

	it("for one release the purchase also takes the old new-org: advisory key — an old pod's purchase excludes it", async () => {
		const oldPod = deferred();
		let oldPodInside = false;
		const old = withPurchaseLock(`new-org:${USER}`, async () => {
			oldPodInside = true;
			await oldPod.promise;
		});
		await waitFor(() => oldPodInside);

		const mine = purchase("A");
		// The new build took the lease, but waits on the advisory key the old pod holds: no Stripe write.
		await waitFor(async () => (await holderOf(KEY)) !== null);
		await new Promise((r) => setTimeout(r, 500));
		expect(fake.writes).toEqual([]);

		oldPod.resolve();
		await old;
		await expect(mine).resolves.toMatchObject({ kind: "intent" });
	});

	it("C52: A's lease expires before its mint returns; B mints; exactly one secret leaves, and A closes Z out", async () => {
		const stall = deferred();
		fake.state.stallMint = stall.promise;
		const aResult = purchase("A");
		await waitFor(() => fake.writes.some((w) => w.call === "subscriptions.create"));
		const aHolder = await holderOf(KEY);

		// A stalls past its lease; B takes it over, and waits behind A on the old advisory key.
		await expireLease(KEY);
		const bResult = purchase("B");
		await waitFor(async () => (await holderOf(KEY)) !== aHolder);

		stall.resolve();
		const [a, b] = await Promise.all([aResult, bResult]);

		const secrets = [a, b].filter((r) => r.kind === "intent");
		expect(secrets).toHaveLength(1);
		expect(a).toEqual({
			kind: "refused",
			message:
				"Another purchase on this account is being started right now, so nothing new was started. Wait a moment and try again.",
		});
		expect(b).toMatchObject({ kind: "intent" });

		// Z is A's subscription. Apart from the two mints, the only Stripe writes either request made are
		// A's close-out of Z: B's sweep, run after A let go of the advisory key, found Z already ended.
		const z = [...fake.subs.values()].find((s) => b.kind === "intent" && s.id !== b.subscriptionId);
		if (!z) throw new Error("A's subscription Z was never minted");
		const notMints = fake.writes
			.filter((w) => w.call !== "subscriptions.create")
			.map(({ call, id, params }) => ({ call, id, params }));
		expect(notMints).toEqual([
			{ call: "invoices.voidInvoice", id: z.latest_invoice, params: undefined },
			{ call: "subscriptions.cancel", id: z.id, params: { cancellation_details: { comment: "alethia:closeout" } } },
		]);
		expect(z.status).toBe("canceled");
		// Each holder minted under its own idempotency key.
		const mintKeys = fake.writes.filter((w) => w.call === "subscriptions.create").map((w) => w.id);
		expect(new Set(mintKeys).size).toBe(2);
		// No record of Z: its secret never left, so nothing will ever be offered for it.
		const records = await getServiceDb()
			.select({ sub: pendingOrgSetups.subscription_id })
			.from(pendingOrgSetups)
			.where(eq(pendingOrgSetups.user_id, USER));
		expect(records.map((r) => r.sub)).not.toContain(z.id);
	});

	it("C52 variant: A's close-out cannot prove its void, so Z is NOT cancelled — and B's next purchase sweeps Z", async () => {
		const stall = deferred();
		fake.state.stallMint = stall.promise;
		const aResult = purchase("A");
		await waitFor(() => fake.writes.some((w) => w.call === "subscriptions.create"));
		const aHolder = await holderOf(KEY);
		await expireLease(KEY);
		// B takes the lease over and holds it while A wakes, then finds nothing to do yet.
		const bLease = await tryAcquirePurchaseLease(KEY);
		if (!bLease) throw new Error("B did not take the expired lease");
		expect(bLease.holder).not.toBe(aHolder);

		fake.state.voidFails = true;
		stall.resolve();
		await expect(aResult).resolves.toMatchObject({ kind: "refused" });
		const z = [...fake.subs.values()][0];
		expect(z?.status).toBe("incomplete");
		expect(fake.writes.filter((w) => w.call === "subscriptions.cancel")).toEqual([]);
		await releasePurchaseLease(bLease);

		fake.state.voidFails = false;
		const next = await purchase("B");
		expect(next).toMatchObject({ kind: "intent" });
		expect(z?.status).toBe("canceled");
		expect(fake.writes.find((w) => w.call === "subscriptions.cancel" && w.id === z?.id)?.by).toBe("B");
	});
});
