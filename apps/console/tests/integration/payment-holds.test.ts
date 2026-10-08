// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the payment_holds table and its store (ADR 0002 §4.1, S4, #5755) against real Postgres —
// ADR 0002's `I` cases for this slice. The store has no caller yet, so these are the only proof that its
// fences are in the SQL itself:
//
//   C51  an operator release meets the open-row unique index: release, then E0 on the same subscription
//        writes a SECOND row; a second OPEN row is refused — by the store and by the index itself.
//   C65  a state write prepared on `version` n changes no row after a release committed n+1.
//   C25  (the hold-write half deferred from S2) a stale lease holder's state write is rejected, and so
//        is a write under another payer's lease.
//   C74  a nudge (hint write) and a notice claim never touch `version`, so neither makes a state write
//        miss; the claim is once per hold and state.
//   C92  (the release half) a release to `voided_unpaid` closes the open setup with `hold_released` in
//        the SAME transaction; a release to `adopted` leaves it open.
//   ---  RLS: `payment_holds` is service-role only.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimHoldNotice,
	type HoldRef,
	nudgeHold,
	openHold,
	type OpenHoldInput,
	payerLeaseKey,
	releaseHold,
	reserveRefundAttempt,
	unclaimHoldNotice,
	writeHoldState,
} from "@/lib/billing/payment-holds/store";
import { type PurchaseLease, releasePurchaseLease, tryAcquirePurchaseLease } from "@/lib/billing/purchase-lease";
import { getServiceDb, withScope } from "@/lib/db";
import { paymentHolds, type PaymentHoldRow, pendingOrgSetups, purchaseLeases, user } from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

const payers: string[] = [];
const subscriptions: string[] = [];

/** A fresh payer and that payer's live lease. */
async function payerWithLease(): Promise<{ payer: string; lease: PurchaseLease }> {
	const payer = randomUUID();
	payers.push(payer);
	const lease = await tryAcquirePurchaseLease(payerLeaseKey(payer));
	if (!lease) throw new Error("fixture: a fresh payer's lease was not free");
	return { payer, lease };
}

/** A fresh subscription id, cleaned up after the file. */
function newSubscription(): string {
	const id = `sub_it_hold_${randomUUID().slice(0, 12)}`;
	subscriptions.push(id);
	return id;
}

/** E0's input for `payer` on `subscriptionId`, in `closing`. */
function e0(payer: string, subscriptionId: string): OpenHoldInput {
	return {
		subscriptionId,
		customerId: "cus_it_hold",
		payerKey: payer,
		invoiceId: `in_${subscriptionId}`,
		state: "closing",
		nextCheckAt: new Date(Date.now() + 5 * 60_000),
		openedBy: "purchase",
		openedByUserId: payer,
	};
}

/** Opens a hold that the test expects to be written, and returns its row. */
async function opened(lease: PurchaseLease, input: OpenHoldInput): Promise<PaymentHoldRow> {
	const result = await openHold(lease, input);
	if (result.kind !== "opened") throw new Error(`fixture: the open returned ${result.kind}`);
	return result.hold;
}

/** The row as the database has it now. */
async function readHold(id: string): Promise<PaymentHoldRow> {
	const [row] = await getServiceDb().select().from(paymentHolds).where(eq(paymentHolds.id, id));
	if (!row) throw new Error(`hold ${id} is gone`);
	return row;
}

/** The ref a state write is prepared on, from a row read. */
function refOf(row: PaymentHoldRow): HoldRef {
	return { id: row.id, version: row.version };
}

/** Pushes `key`'s lease into the past, as if its holder had stalled past its lifetime. */
async function expireLease(key: string): Promise<void> {
	await getServiceDb()
		.update(purchaseLeases)
		.set({ expires_at: sql`now() - interval '1 second'` })
		.where(eq(purchaseLeases.key, key));
}

afterAll(async () => {
	const db = getServiceDb();
	for (const sub of subscriptions) await db.delete(paymentHolds).where(eq(paymentHolds.subscription_id, sub));
	for (const payer of payers) await db.delete(purchaseLeases).where(eq(purchaseLeases.key, payerLeaseKey(payer)));
});

describeIfDb("payment_holds — C51: the open-row unique index", () => {
	it("an operator release frees the subscription: E0 then writes a SECOND row, and a second OPEN row is refused", async () => {
		const { payer, lease } = await payerWithLease();
		const sub = newSubscription();
		const first = await opened(lease, e0(payer, sub));

		// While the first is open, E0 on the same subscription writes nothing and names the open row (T0h).
		const conflict = await openHold(lease, e0(payer, sub));
		expect(conflict).toEqual({ kind: "already_open", hold: first });

		const released = await releaseHold(lease, refOf(first), { reason: "operator", releasedBy: randomUUID(), note: "it" });
		expect(released?.hold.state).toBe("released");

		// The subscription is still `incomplete`: the next sweep's E0 must be able to hold it again.
		const second = await opened(lease, e0(payer, sub));
		expect(second.id).not.toBe(first.id);
		expect(await openHold(lease, e0(payer, sub))).toEqual({ kind: "already_open", hold: second });

		const rows = await getServiceDb().select().from(paymentHolds).where(eq(paymentHolds.subscription_id, sub));
		expect(rows.map((r) => r.state).sort()).toEqual(["closing", "released"]);
	});

	it("the index itself refuses a second open row written past the store", async () => {
		const { payer, lease } = await payerWithLease();
		const sub = newSubscription();
		await opened(lease, e0(payer, sub));
		const refused = await refusalText(() =>
			getServiceDb()
				.insert(paymentHolds)
				.values({
					subscription_id: sub,
					customer_id: "cus_it_hold",
					payer_key: payer,
					invoice_id: `in_${sub}`,
					state: "refund_due",
					next_check_at: new Date(),
					opened_by: "backfill",
				}),
		);
		expect(refused).toMatch(/payment_holds_open_subscription_uidx/);
	});
});

describeIfDb("payment_holds — C65 and C25: every state write is fenced on version AND on the payer's lease", () => {
	it("C65: a write prepared on version n changes no row after a release committed n+1", async () => {
		const { payer, lease } = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		const prepared = refOf(hold);
		expect(prepared.version).toBe(0);

		const released = await releaseHold(lease, prepared, { reason: "operator", releasedBy: randomUUID() });
		expect(released?.hold.version).toBe(1);

		expect(await writeHoldState(lease, prepared, { state: "invoice_payable", attempts: 3 })).toBeNull();
		expect(await reserveRefundAttempt(lease, prepared)).toBeNull();
		expect(await releaseHold(lease, prepared, { reason: "voided_unpaid" })).toBeNull();
		const after = await readHold(hold.id);
		expect(after).toMatchObject({ state: "released", release_reason: "operator", version: 1, attempts: 0, refund_attempt: 0 });
	});

	it("C65: of two writes prepared on the same version, only the first lands", async () => {
		const { payer, lease } = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		const a = await writeHoldState(lease, refOf(hold), { state: "cancel_unproven", attempts: 1 });
		expect(a).toMatchObject({ state: "cancel_unproven", attempts: 1, version: 1 });
		expect(await writeHoldState(lease, refOf(hold), { state: "invoice_payable" })).toBeNull();
		expect((await readHold(hold.id)).state).toBe("cancel_unproven");
	});

	it("a state entry stamps state_since; a write that keeps the state does not", async () => {
		const { payer, lease } = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		await getServiceDb()
			.update(paymentHolds)
			.set({ state_since: sql`now() - interval '1 hour'` })
			.where(eq(paymentHolds.id, hold.id));
		const old = await readHold(hold.id);
		const kept = await writeHoldState(lease, refOf(old), { state: "closing", attempts: 1 });
		expect(kept?.state_since).toEqual(old.state_since);
		const moved = await writeHoldState(lease, { id: hold.id, version: 1 }, { state: "cancel_unproven" });
		expect(moved?.state_since.getTime()).toBeGreaterThan(old.state_since.getTime());
	});

	it("T5: the refund attempt is reserved by a fenced state write, and the first number consumed is 0", async () => {
		const { payer, lease } = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		const first = await reserveRefundAttempt(lease, refOf(hold));
		expect(first?.attempt).toBe(0);
		if (!first) throw new Error("the first reservation wrote nothing");
		const second = await reserveRefundAttempt(lease, refOf(first.hold));
		expect(second?.attempt).toBe(1);
		expect(second?.hold.version).toBe(2);
	});

	it("C25: after the lease is taken over, the stale holder's open, state write, reservation and release all write nothing", async () => {
		const { payer, lease: stale } = await payerWithLease();
		const sub = newSubscription();
		const hold = await opened(stale, e0(payer, sub));

		await expireLease(payerLeaseKey(payer));
		const taker = await tryAcquirePurchaseLease(payerLeaseKey(payer));
		if (!taker) throw new Error("fixture: the expired lease was not taken over");

		expect(await writeHoldState(stale, refOf(hold), { state: "cancel_unproven", attempts: 1 })).toBeNull();
		expect(await reserveRefundAttempt(stale, refOf(hold))).toBeNull();
		expect(await releaseHold(stale, refOf(hold), { reason: "voided_unpaid" })).toBeNull();
		expect(await openHold(stale, e0(payer, newSubscription()))).toEqual({ kind: "lease_lost" });
		expect(await readHold(hold.id)).toMatchObject({ state: "closing", version: 0, attempts: 0, refund_attempt: 0 });

		// The new holder's write, prepared on the same version, lands.
		expect(await writeHoldState(taker, refOf(hold), { state: "cancel_unproven" })).toMatchObject({ version: 1 });
		await releasePurchaseLease(taker);
	});

	it("C25: an expired lease nobody took over still fences — a lapsed holder writes nothing", async () => {
		const { payer, lease } = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		await expireLease(payerLeaseKey(payer));
		expect(await writeHoldState(lease, refOf(hold), { attempts: 1 })).toBeNull();
		expect(await openHold(lease, e0(payer, newSubscription()))).toEqual({ kind: "lease_lost" });
	});

	it("a live lease of ANOTHER payer cannot write this payer's hold", async () => {
		const { payer, lease } = await payerWithLease();
		const other = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		expect(await writeHoldState(other.lease, refOf(hold), { state: "cancel_unproven" })).toBeNull();
		expect(await releaseHold(other.lease, refOf(hold), { reason: "operator" })).toBeNull();
		await expect(openHold(other.lease, e0(payer, newSubscription()))).rejects.toThrow(/needs that payer's lease/);
		expect((await readHold(hold.id)).version).toBe(0);
	});
});

describeIfDb("payment_holds — C74: hint writes and notice claims never touch version", () => {
	it("a nudge between the read and the state write changes nudged_at only, and the state write still lands", async () => {
		const { payer, lease } = await payerWithLease();
		const sub = newSubscription();
		const hold = await opened(lease, e0(payer, sub));
		const prepared = refOf(hold);

		expect(await nudgeHold(sub)).toBe(1);
		const nudged = await readHold(hold.id);
		expect(nudged.nudged_at).not.toBeNull();
		expect({ ...nudged, nudged_at: null, updated_at: hold.updated_at }).toEqual(hold);

		const written = await writeHoldState(lease, prepared, { state: "cancel_unproven", observedAt: new Date() });
		expect(written).toMatchObject({ state: "cancel_unproven", version: 1 });
		// The state write leaves the hint as it is.
		expect(written?.nudged_at).toEqual(nudged.nudged_at);
	});

	it("a nudge leaves a released hold alone", async () => {
		const { payer, lease } = await payerWithLease();
		const sub = newSubscription();
		const hold = await opened(lease, e0(payer, sub));
		await releaseHold(lease, refOf(hold), { reason: "voided_unpaid" });
		expect(await nudgeHold(sub)).toBe(0);
		expect((await readHold(hold.id)).nudged_at).toBeNull();
	});

	it("a notice is claimed once per hold and state, never bumps version, and an unclaim lets the next tick retry", async () => {
		const { payer, lease } = await payerWithLease();
		const hold = await opened(lease, e0(payer, newSubscription()));
		const prepared = refOf(hold);

		expect(await claimHoldNotice(hold.id, "refund_pending")).toBe(true);
		expect(await claimHoldNotice(hold.id, "refund_pending")).toBe(false);
		const claimed = await readHold(hold.id);
		expect(claimed).toMatchObject({ notified_state: "refund_pending", version: 0 });
		expect(claimed.notified_at).not.toBeNull();
		expect(claimed.updated_at).toEqual(hold.updated_at);

		// The send threw: the claim is given back, and the next claim of that state wins again.
		await unclaimHoldNotice(hold.id, "refund_pending");
		expect(await readHold(hold.id)).toMatchObject({ notified_state: null, notified_at: null });
		expect(await claimHoldNotice(hold.id, "refund_pending")).toBe(true);

		// An unclaim of a state that is no longer the claim leaves the newer claim alone.
		expect(await claimHoldNotice(hold.id, "released:refunded")).toBe(true);
		await unclaimHoldNotice(hold.id, "refund_pending");
		expect((await readHold(hold.id)).notified_state).toBe("released:refunded");

		expect(await writeHoldState(lease, prepared, { state: "refund_pending" })).toMatchObject({ version: 1 });
	});
});

describeIfDb("payment_holds — C92, the release half: a release decides the setup in the same transaction", () => {
	const USER = randomUUID();

	beforeAll(async () => {
		await getServiceDb().insert(user).values({ id: USER, email: `it-hold-${USER}@example.test` });
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(pendingOrgSetups).where(eq(pendingOrgSetups.user_id, USER));
		await db.delete(purchaseLeases).where(eq(purchaseLeases.key, payerLeaseKey(USER)));
		await db.delete(user).where(eq(user.id, USER));
	});

	/** Records an open setup for `subscriptionId`, and returns its id. */
	async function openSetup(subscriptionId: string, linked = false): Promise<string> {
		const [row] = await getServiceDb()
			.insert(pendingOrgSetups)
			.values({
				user_id: USER,
				subscription_id: subscriptionId,
				customer_id: "cus_it_hold",
				intended_name: "Held",
				intended_slug: `held-${subscriptionId.slice(-8)}`,
				...(linked ? { linked_at: new Date() } : {}),
			})
			.returning({ id: pendingOrgSetups.id });
		if (!row) throw new Error("fixture: no setup was recorded");
		return row.id;
	}

	/** The setup row with `id`. */
	async function readSetup(id: string) {
		const [row] = await getServiceDb().select().from(pendingOrgSetups).where(eq(pendingOrgSetups.id, id));
		if (!row) throw new Error(`setup ${id} is gone`);
		return row;
	}

	/** The user's lease, taken fresh for one test and given back after it. */
	async function userLease(): Promise<PurchaseLease> {
		await getServiceDb().delete(purchaseLeases).where(eq(purchaseLeases.key, payerLeaseKey(USER)));
		const lease = await tryAcquirePurchaseLease(payerLeaseKey(USER));
		if (!lease) throw new Error("fixture: the user's lease was not free");
		return lease;
	}

	it("a release to voided_unpaid closes the open setup with hold_released; other setups are untouched", async () => {
		const lease = await userLease();
		const sub = newSubscription();
		const setup = await openSetup(sub);
		const elsewhere = await openSetup(newSubscription());
		const hold = await opened(lease, e0(USER, sub));

		expect((await readSetup(setup)).closed_at).toBeNull();
		const released = await releaseHold(lease, refOf(hold), { reason: "voided_unpaid" });
		expect(released?.closedSetupId).toBe(setup);
		expect(released?.hold).toMatchObject({ state: "released", release_reason: "voided_unpaid", next_check_at: null });
		expect(await readSetup(setup)).toMatchObject({ closed_reason: "hold_released" });
		expect((await readSetup(setup)).closed_at).not.toBeNull();
		expect((await readSetup(elsewhere)).closed_at).toBeNull();
		await releasePurchaseLease(lease);
	});

	it.each(["deleted_draft", "refunded", "already_refunded", "expired_unpaid", "operator"] as const)(
		"a release to %s closes the open setup too",
		async (reason) => {
			const lease = await userLease();
			const sub = newSubscription();
			const setup = await openSetup(sub);
			const hold = await opened(lease, e0(USER, sub));
			expect((await releaseHold(lease, refOf(hold), { reason }))?.closedSetupId).toBe(setup);
			expect((await readSetup(setup)).closed_reason).toBe("hold_released");
			await releasePurchaseLease(lease);
		},
	);

	it("a release to adopted leaves the setup open", async () => {
		const lease = await userLease();
		const sub = newSubscription();
		const setup = await openSetup(sub);
		const hold = await opened(lease, e0(USER, sub));
		const released = await releaseHold(lease, refOf(hold), { reason: "adopted" });
		expect(released).toMatchObject({ closedSetupId: null, hold: { state: "released", release_reason: "adopted" } });
		expect(await readSetup(setup)).toMatchObject({ closed_at: null, closed_reason: null });
		await releasePurchaseLease(lease);
	});

	it("a release leaves a LINKED setup as it is: it is no longer open", async () => {
		const lease = await userLease();
		const sub = newSubscription();
		const setup = await openSetup(sub, true);
		const hold = await opened(lease, e0(USER, sub));
		expect((await releaseHold(lease, refOf(hold), { reason: "voided_unpaid" }))?.closedSetupId).toBeNull();
		expect(await readSetup(setup)).toMatchObject({ closed_at: null, closed_reason: null });
		await releasePurchaseLease(lease);
	});

	it("a release whose state write misses touches no setup", async () => {
		const lease = await userLease();
		const sub = newSubscription();
		const setup = await openSetup(sub);
		const hold = await opened(lease, e0(USER, sub));
		expect(await releaseHold(lease, { id: hold.id, version: hold.version + 1 }, { reason: "voided_unpaid" })).toBeNull();
		expect((await readSetup(setup)).closed_at).toBeNull();
		await releasePurchaseLease(lease);
	});

	it("SAME transaction: a failure AFTER the setup's close, at COMMIT, rolls the close back with the release", async () => {
		const lease = await userLease();
		const sub = newSubscription();
		const setup = await openSetup(sub);
		const hold = await opened(lease, e0(USER, sub));

		// The failure is injected at COMMIT of the release's transaction, i.e. AFTER the setup's close has
		// run: a test-only DEFERRED constraint trigger on payment_holds, fired by this subscription's
		// release only (its WHEN), raises when that transaction commits. If the close ran in the same
		// transaction it is rolled back with the release and the setup is still open below. A close made
		// on any other connection has already committed by then, and the setup is found closed. (Failing
		// the close itself cannot tell the two apart: either way nothing after it commits.) The suite runs
		// files serially (vitest.integration.config.ts), and the trigger is dropped in the finally.
		const fn = `it_hold_fail_${randomUUID().replaceAll("-", "")}`;
		const db = getServiceDb();
		await db.execute(
			sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'it: the release failed at commit'; END $$`),
		);
		await db.execute(
			sql.raw(`CREATE CONSTRAINT TRIGGER ${fn} AFTER UPDATE ON payment_holds
				DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
				WHEN (NEW.subscription_id = '${sub}' AND NEW.state = 'released') EXECUTE FUNCTION ${fn}()`),
		);
		try {
			const failed = await refusalText(() => releaseHold(lease, refOf(hold), { reason: "voided_unpaid" }));
			expect(failed).toMatch(/the release failed at commit/);
		} finally {
			await db.execute(sql.raw(`DROP TRIGGER ${fn} ON payment_holds`));
			await db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
		}
		// The hold is still open, at the version the failed release was prepared on, and the setup's close
		// — which DID run before the commit failed — was rolled back with it.
		expect(await readHold(hold.id)).toMatchObject({ state: "closing", version: 0, release_reason: null });
		expect(await readSetup(setup)).toMatchObject({ closed_at: null, closed_reason: null });

		// And the retry, with the commit working again, does both.
		expect((await releaseHold(lease, refOf(hold), { reason: "voided_unpaid" }))?.closedSetupId).toBe(setup);
		expect((await readSetup(setup)).closed_reason).toBe("hold_released");
		await releasePurchaseLease(lease);
	});
});

describe("payment_holds — RLS", () => {
	describeIfDb("the table", () => {
		it("is service-role only — RLS enabled, no policy", async () => {
			const [rls] = await getServiceDb().execute(sql`
				select c.relrowsecurity as rls,
				       (select count(*)::int from pg_policies p where p.tablename = 'payment_holds') as policies
				from pg_class c where c.relname = 'payment_holds'`);
			expect(rls).toEqual({ rls: true, policies: 0 });
		});

		it.skipIf(!APP_ROLE_DISTINCT)("an app-role session can neither read nor write a hold", async () => {
			const owner = randomUUID();
			const read = await refusalText(() => withScope({ ownerId: owner, orgId: owner }, (tx) => tx.select().from(paymentHolds)));
			expect(read).toMatch(/permission denied/);
			const write = await refusalText(() =>
				withScope({ ownerId: owner, orgId: owner }, (tx) =>
					tx.update(paymentHolds).set({ state: "released" }).where(eq(paymentHolds.payer_key, owner)),
				),
			);
			expect(write).toMatch(/permission denied/);
		});
	});
});
