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
//   ---  from S3 (#5754) the purchase no longer takes the old `new-org:<user>` advisory key, which S2
//        took for one release only: an advisory lock held on that key does not hold the purchase back.
//   ---  the purchase path's Stripe client carries the timeout the mint deadline is computed from; the
//        shared client keeps the SDK's defaults.
//   ---  RLS: `purchase_leases` is service-role only.
//
// And ADR 0004's `L` cases for the org-plan purchase (O4, #6037), whose `org-plan:<org>` lease runs INSIDE
// the old `org-plan:<org>` advisory key for one release (D3):
//   C25  an old pod's advisory key alone holds the new purchase back before it takes the lease; while the
//        purchase runs it holds both; afterwards neither is held.
//   C20  A's `org-plan:<org>` lease expires before its mint returns, and another request takes it over.
//        Under O4 that taker cannot be a second O4 purchase — it would wait on the advisory key A still
//        holds — so it is a lease-only one: the Pro trial (`startProTrial`, run for real here), or an O6
//        pod during O6's rollout. The trial mints while A is still stalled. A's gate then fails: no secret
//        leaves, and A's only Stripe writes after its mint are `voidInvoice` on its own subscription's
//        first invoice and a `cancel` stamped `alethia:closeout`. The trial hands out no secret either, so
//        the org ends with one live subscription, the trial, and nothing payable.
//
// Stripe is the one boundary faked here, as in pending-org-setups.test.ts; the lease, the advisory lock
// and the setup record are real.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

/** One licensed plan line, as the sync and the org-plan classifier read it (`planItem`). */
interface FakeItem {
	price: { id: string; recurring: { usage_type: string } };
	quantity: number;
	current_period_end: number;
}

/** One subscription in the fake Stripe account. */
interface FakeSub {
	id: string;
	customer: string;
	status: string;
	latest_invoice: string;
	metadata: Record<string, string>;
	items: { data: FakeItem[] };
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
			data: [...fake.subs.values()].filter(
				(s) => s.customer === q.customer && (q.status === "all" || s.status === q.status),
			),
		})),
		retrieve: vi.fn(async (id: string) => fake.subs.get(id)),
		create: vi.fn(async (
			params: { customer: string; metadata: Record<string, string>; trial_period_days?: number },
			opts?: { idempotencyKey: string },
		) => {
			const by = fake.state.by;
			fake.writes.push({ by, call: "subscriptions.create", id: opts?.idempotencyKey ?? "(no idempotency key)" });
			if (fake.state.stallMint) {
				const stall = fake.state.stallMint;
				fake.state.stallMint = null;
				await stall;
			}
			fake.state.minted += 1;
			const id = `sub_it_lease_${fake.state.minted}_${randomUUIDish()}`;
			const invoiceId = `in_${id}`;
			fake.invoices.set(invoiceId, { status: "open" });
			// A card-less trial starts `trialing`; every other mint awaits its first payment.
			const status = params.trial_period_days ? "trialing" : "incomplete";
			const items = {
				data: [
					{
						price: { id: process.env.STRIPE_PRICE_TEAM ?? "price_it_team", recurring: { usage_type: "licensed" } },
						quantity: 1,
						current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
					},
				],
			};
			fake.subs.set(id, { id, customer: params.customer, status, latest_invoice: invoiceId, metadata: params.metadata, items });
			return {
				id,
				customer: params.customer,
				status,
				metadata: params.metadata,
				items,
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
	return { ...actual, getStripe: () => fakeStripe, getPurchaseStripe: () => fakeStripe };
});
// The paid-conversion gate refuses by default (PAID_MARKETS is empty); it is not what this file tests.
vi.mock("@/lib/billing/eligibility", () => ({
	assertPaidConversionAllowed: vi.fn(async () => undefined),
	assertOrgPaidConversionAllowed: vi.fn(async () => undefined),
}));

import { createNewOrgSubscriptionIntent, createSubscriptionIntent, startProTrial } from "@/app/server/actions/billing";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
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
import {
	authzActivityLog,
	grants,
	member,
	organization,
	organizationBilling,
	pendingOrgSetups,
	purchaseLeases,
	user,
} from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, purgeAuthzActivityLog, refusalText } from "./db";

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
		// the whole wait. The lease's waiter holds nothing between polls. Only sessions whose last
		// statement touched `purchase_leases` are counted — no other integration file uses that table,
		// so a file running in parallel cannot make this flake.
		const busy = await getServiceDb().execute(sql`
			select count(*)::int as n from pg_stat_activity
			where datname = current_database() and pid <> pg_backend_pid()
			  and query ilike '%purchase_leases%'
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

	// A held lease always reports its whole lifetime left (the renewal sets it), so the mint deadline is
	// met by construction; this pins only that the comparison is made, by the database's clock.
	it("a renewal compares the remaining time against the asked minimum (met by construction below the lifetime)", async () => {
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
	const actor: Actor = { credential: "session", userId: USER, orgId: USER, entitlements: ENTITLEMENTS };
	const saved: Record<string, string | undefined> = {};

	/** The purchase as request `by` ("A" or "B") makes it, on the user's one customer. */
	function purchase(by: string): ReturnType<typeof createNewOrgSubscriptionIntent> {
		return runWithActor(actor, async () => {
			fake.state.by = by;
			return createNewOrgSubscriptionIntent("team", { orgName: "Leased", customerId: CUSTOMER, currency: "eur" });
		});
	}

	beforeAll(async () => {
		// Everything the Stripe config schema requires (lib/billing/config.ts): without the webhook secret
		// `getStripeConfig` throws before the purchase reaches the lease.
		for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_TEAM", "NEXT_PUBLIC_APP_URL"]) {
			saved[k] = process.env[k];
		}
		process.env.STRIPE_SECRET_KEY = "sk_test_integration_never_used";
		process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration_never_used";
		process.env.STRIPE_PRICE_TEAM = "price_it_team";
		process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
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

	it("the purchase client has the timeout the mint deadline is computed from; the shared client keeps the SDK's", async () => {
		const actual = await vi.importActual<typeof import("@/lib/billing/stripe")>("@/lib/billing/stripe");
		const purchaseClient = actual.getPurchaseStripe();
		expect(purchaseClient.getApiField("timeout")).toBe(actual.STRIPE_REQUEST_TIMEOUT_MS);
		expect(actual.STRIPE_REQUEST_TIMEOUT_MS).toBe(20_000);
		expect(purchaseClient.getMaxNetworkRetries()).toBe(1);
		const shared = actual.getStripe();
		expect(shared.getApiField("timeout")).toBe(80_000);
		expect(shared.getMaxNetworkRetries()).toBe(2);
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

	it("S3: the purchase no longer takes the old new-org: advisory key — a lock held on it does not hold the purchase back", async () => {
		const oldPod = deferred();
		let oldPodInside = false;
		const old = withPurchaseLock(`new-org:${USER}`, async () => {
			oldPodInside = true;
			await oldPod.promise;
		});
		await waitFor(() => oldPodInside);
		try {
			// While the advisory key is held, the purchase runs to the end under the lease alone.
			await expect(purchase("A")).resolves.toMatchObject({ kind: "intent" });
			expect(fake.writes.some((w) => w.call === "subscriptions.create")).toBe(true);
		} finally {
			oldPod.resolve();
			await old;
		}
	});

	it("C52: A's lease expires before its mint returns; B mints; exactly one secret leaves, and A closes Z out", async () => {
		const stall = deferred();
		fake.state.stallMint = stall.promise;
		const aResult = purchase("A");
		await waitFor(() => fake.writes.some((w) => w.call === "subscriptions.create"));

		// A stalls past its lease; B takes it over and runs while A is still inside its mint.
		await expireLease(KEY);
		// B no longer waits behind A on the old advisory key (S3), so it runs to the end while A is still
		// stalled — and then A wakes. Awaited in that order, so B's sweep deterministically runs before Z exists.
		const b = await purchase("B");

		stall.resolve();
		const a = await aResult;

		const secrets = [a, b].filter((r) => r.kind === "intent");
		expect(secrets).toHaveLength(1);
		expect(a).toEqual({
			kind: "refused",
			message:
				"Another purchase on this account is being started right now, so nothing new was started. Wait a moment and try again.",
		});
		expect(b).toMatchObject({ kind: "intent" });

		// Z is A's subscription. Apart from the two mints, the only Stripe writes either request made are
		// A's close-out of Z: B's sweep ran before Z existed.
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

describeIfDb("the org-plan purchase under the advisory key AND the org-plan: lease — ADR 0004 C20, C25 (O4)", () => {
	const OWNER = randomUUID();
	const ORG = randomUUID();
	const CUSTOMER = `cus_it_orgplan_${randomUUID().slice(0, 8)}`;
	const KEY = `org-plan:${ORG}`;
	const actor: Actor = { credential: "session", userId: OWNER, orgId: ORG, entitlements: ENTITLEMENTS };
	const saved: Record<string, string | undefined> = {};

	/** The org-plan purchase as request `by` ("A" or "B") makes it, on the org's one customer. */
	function intent(by: string): ReturnType<typeof createSubscriptionIntent> {
		return runWithActor(actor, async () => {
			fake.state.by = by;
			return createSubscriptionIntent("team", { currency: "eur" });
		});
	}

	/** Whether the advisory key `org-plan:<org>` is free right now: taken and given back at once, or not. */
	async function advisoryKeyFree(): Promise<boolean> {
		return getServiceDb().transaction(async (tx) => {
			const [row] = await tx.execute(
				sql`select pg_try_advisory_xact_lock(hashtextextended(${`purchase:${KEY}`}, 0)) as free`,
			);
			return row?.free === true;
		});
	}

	beforeAll(async () => {
		for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_TEAM", "NEXT_PUBLIC_APP_URL"]) {
			saved[k] = process.env[k];
		}
		process.env.STRIPE_SECRET_KEY = "sk_test_integration_never_used";
		process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration_never_used";
		process.env.STRIPE_PRICE_TEAM = "price_it_team";
		process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
		const db = getServiceDb();
		await seedAuthz(); // the built-in role rows the owner grant references
		await db.insert(user).values({ id: OWNER, email: `it-orgplan-${OWNER}@example.test` });
		await db.insert(organization).values({ id: ORG, name: "Org Plan Leased", slug: `it-orgplan-${ORG.slice(0, 8)}` });
		await db.insert(member).values({ organizationId: ORG, userId: OWNER, role: "owner" });
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: OWNER,
			effect: "allow",
			role_id: BUILTIN_ROLE_IDS.owner,
			resource_type: "org",
			resource_id: null,
		});
		await db.insert(organizationBilling).values({
			organizationId: ORG,
			plan: "community",
			status: "none",
			stripeCustomerId: CUSTOMER,
		});
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
		await purgeAuthzActivityLog(eq(authzActivityLog.org_id, ORG));
		await db.delete(purchaseLeases).where(eq(purchaseLeases.key, KEY));
		await db.delete(organizationBilling).where(eq(organizationBilling.organizationId, ORG));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(eq(user.id, OWNER));
	});

	// A pin: the purchase before O4 also waited on this key. What it adds is that the lease is not taken first.
	it("C25: an old pod's advisory key alone holds the purchase back, before it takes the lease", async () => {
		const oldPod = deferred();
		let oldPodInside = false;
		const old = withPurchaseLock(KEY, async () => {
			oldPodInside = true;
			await oldPod.promise;
		});
		await waitFor(() => oldPodInside);
		let result: Awaited<ReturnType<typeof createSubscriptionIntent>> | undefined;
		const running = intent("A").then((r) => {
			result = r;
		});
		try {
			await new Promise((r) => setTimeout(r, 600));
			// Waiting on the advisory key: no lease taken yet, no Stripe write made.
			expect(result).toBeUndefined();
			expect(await holderOf(KEY)).toBeNull();
			expect(fake.writes).toEqual([]);
		} finally {
			oldPod.resolve();
			await old;
		}
		await running;
		expect(result).toMatchObject({ clientSecret: expect.stringMatching(/^cs_/) });
	});

	it("C25: while the purchase mints it holds both keys, and gives both back when it returns", async () => {
		const stall = deferred();
		fake.state.stallMint = stall.promise;
		const running = intent("A");
		await waitFor(() => fake.writes.some((w) => w.call === "subscriptions.create"));

		expect(await holderOf(KEY)).not.toBeNull();
		expect(await advisoryKeyFree()).toBe(false);

		stall.resolve();
		await expect(running).resolves.toMatchObject({ clientSecret: expect.stringMatching(/^cs_/) });
		expect(await holderOf(KEY)).toBeNull();
		expect(await advisoryKeyFree()).toBe(true);
	});

	it("C20: A's lease expires before its mint returns, and the trial takes it over and mints; A hands out no secret and closes its subscription out", async () => {
		const db = getServiceDb();
		const stall = deferred();
		fake.state.stallMint = stall.promise;
		const aResult = intent("A");
		await waitFor(() => fake.writes.some((w) => w.call === "subscriptions.create"));
		const aHolder = await holderOf(KEY);

		try {
			// A stalls past its lease. The trial is lease-only, so it takes the expired lease over and runs to the
			// end while A still holds the advisory key.
			await expireLease(KEY);
			await runWithActor(actor, async () => {
				fake.state.by = "B";
				await startProTrial({ currency: "eur" });
			});
			const trialMints = fake.writes.filter((w) => w.call === "subscriptions.create" && w.by === "B");
			expect(trialMints).toHaveLength(1);
			expect(trialMints[0]?.id).toMatch(new RegExp(`^trial-${KEY}-`));
			expect(trialMints[0]?.id).not.toContain(aHolder ?? "no holder");
			expect(await advisoryKeyFree()).toBe(false);

			fake.state.by = "A";
			stall.resolve();
			const a = await aResult;
			expect(a).toEqual({
				error:
					"Another purchase on this account is being started right now, so nothing new was started. Wait a moment and try again.",
			});
			const subs = [...fake.subs.values()];
			const z = subs.find((s) => s.status !== "trialing");
			const trial = subs.find((s) => s.status === "trialing");
			if (!z || !trial) throw new Error("expected A's subscription Z and the trial");
			// Apart from the two mints, the only Stripe writes are A's close-out of Z.
			expect(
				fake.writes.filter((w) => w.call !== "subscriptions.create").map(({ by, call, id, params }) => ({ by, call, id, params })),
			).toEqual([
				{ by: "A", call: "invoices.voidInvoice", id: z.latest_invoice, params: undefined },
				{ by: "A", call: "subscriptions.cancel", id: z.id, params: { cancellation_details: { comment: "alethia:closeout" } } },
			]);
			expect(z.status).toBe("canceled");
			// One live subscription, the trial, and nothing payable: the row names the trial.
			const [row] = await db
				.select({ sub: organizationBilling.stripeSubscriptionId, status: organizationBilling.status })
				.from(organizationBilling)
				.where(eq(organizationBilling.organizationId, ORG));
			expect(row).toEqual({ sub: trial.id, status: "trialing" });
			expect(await holderOf(KEY)).toBeNull();
		} finally {
			stall.resolve();
			await aResult.catch(() => undefined);
			await db
				.update(organizationBilling)
				.set({ plan: "community", status: "none", stripeSubscriptionId: null, currentPeriodEnd: null })
				.where(eq(organizationBilling.organizationId, ORG));
			await db.update(user).set({ proTrialConsumedAt: null }).where(eq(user.id, OWNER));
		}
	});
});
