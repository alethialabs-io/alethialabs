// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// scripts/pending-org-setups.ts `close-setup` (ADR 0002 §5.4, C90 and C97; #5714) — the operator's exit
// for an open paid setup no reader can close. The script does not exist on dev, so every case fails
// there at the import.
//
// The database is a queue here (each awaited query pops the next result) and Stripe is mocked: these pin
// the command's DECISIONS — when it refuses, what it writes, when it logs. The compare-and-set predicate
// itself is pinned against Postgres in tests/integration/pending-org-setups.test.ts.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));

import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { closeSetup, main } from "@/scripts/pending-org-setups";

/** A thenable drizzle-ish chain whose terminal `await` pops the next queued result; records `.set` payloads. */
function makeDb() {
	const queue: unknown[][] = [];
	const sets: unknown[] = [];
	const chain: Record<string, unknown> = {};
	for (const m of ["from", "where", "limit", "returning"]) chain[m] = () => chain;
	chain.set = (values: unknown) => {
		sets.push(values);
		return chain;
	};
	chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
		Promise.resolve(queue.shift() ?? []).then(resolve, reject);
	// Raw statements (`tx.execute`): the lock timeout, the committed-hold probe and the LOCK. They do not
	// pop `queue`; each records its SQL text and answers from `executeResults` (default: no rows).
	const executed: string[] = [];
	const executeResults: unknown[] = [];
	const execute = vi.fn(async (query: SQL) => {
		executed.push(new PgDialect().sqlToQuery(query).sql);
		const next = executeResults.shift();
		if (next instanceof Error) throw next;
		return Array.isArray(next) ? next : [];
	});
	const select = vi.fn(() => chain);
	const update = vi.fn(() => chain);
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ select, update, execute }));
	const db = { select, update, transaction };
	return { db, queue, sets, executed, executeResults };
}

/** The setup row as the database holds it. */
function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "row-1",
		user_id: "user-1",
		subscription_id: "sub_x",
		created_org_id: "org-1",
		created_at: new Date("2026-10-08T10:00:00Z"),
		linked_at: null,
		closed_at: null,
		...overrides,
	};
}

let db: ReturnType<typeof makeDb>;
const retrieve = vi.fn();
let printed: string[];
let info: ReturnType<typeof vi.spyOn>;
const print = (line: string) => {
	printed.push(line);
};

/** The stable event names written to console.info. */
function events(): string[] {
	return info.mock.calls.flatMap((c: unknown[]) => {
		try {
			const parsed: unknown = JSON.parse(String(c[0]));
			const name = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "event") : null;
			return typeof name === "string" ? [name] : [];
		} catch {
			return [];
		}
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	db = makeDb();
	printed = [];
	vi.mocked(getServiceDb).mockReturnValue(db.db as never);
	vi.mocked(getStripe).mockReturnValue({ subscriptions: { retrieve } } as never);
	info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
	info.mockRestore();
});

const args = { subscriptionId: "sub_x", reason: "creator unreachable; refunded in Stripe", operator: "op-1" };

describe("close-setup (C90)", () => {
	it("refuses with no --reason, and reads and writes nothing", async () => {
		for (const reason of [undefined, "", "   "]) {
			await expect(closeSetup({ ...args, reason }, print)).resolves.toMatchObject({ kind: "refused" });
		}
		expect(db.db.select).not.toHaveBeenCalled();
		expect(retrieve).not.toHaveBeenCalled();
		expect(db.db.update).not.toHaveBeenCalled();
	});

	it("refuses with no --operator", async () => {
		await expect(closeSetup({ ...args, operator: undefined }, print)).resolves.toMatchObject({ kind: "refused" });
		expect(db.db.update).not.toHaveBeenCalled();
	});

	it("refuses a live or incomplete X, and writes nothing", async () => {
		for (const status of ["active", "trialing", "past_due", "incomplete"]) {
			db.queue.push([row()]);
			retrieve.mockResolvedValueOnce({ id: "sub_x", status, metadata: {} });
			await expect(closeSetup(args, print)).resolves.toMatchObject({ kind: "refused" });
		}
		expect(db.db.update).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});

	it("refuses on any other read failure, and writes nothing", async () => {
		db.queue.push([row()]);
		retrieve.mockRejectedValueOnce(Object.assign(new Error("api down"), { type: "StripeAPIError" }));
		await expect(closeSetup(args, print)).resolves.toMatchObject({ kind: "refused" });
		expect(db.db.update).not.toHaveBeenCalled();
	});

	it("closes on an ended X — closed_at, closed_reason operator, closed_by, closed_note — and writes the audit event once", async () => {
		for (const status of ["canceled", "incomplete_expired"]) {
			info.mockClear();
			db.sets.length = 0;
			db.queue.push([row()]);
			retrieve.mockResolvedValueOnce({ id: "sub_x", status, metadata: { created_by: "user-1" } });
			db.queue.push([row({ closed_at: new Date() })]);
			await expect(closeSetup(args, print)).resolves.toEqual({ kind: "closed", xRead: "ended" });
			expect(db.sets).toEqual([
				expect.objectContaining({
					closed_at: expect.any(Date),
					closed_reason: "operator",
					closed_by: "op-1",
					closed_note: "creator unreachable; refunded in Stripe",
				}),
			]);
			expect(events()).toEqual(["billing.pending_org_setup.closed"]);
			const line: unknown = JSON.parse(String(info.mock.calls[0]?.[0]));
			expect(line).toMatchObject({ x_read: "ended", operator: "op-1", subscription_id: "sub_x" });
		}
	});

	it("a second run matches no open row: it changes nothing and emits no event", async () => {
		db.queue.push([row({ closed_at: new Date() })]);
		retrieve.mockResolvedValueOnce({ id: "sub_x", status: "canceled", metadata: {} });
		db.queue.push([]); // the compare-and-set matches nothing
		await expect(closeSetup(args, print)).resolves.toEqual({ kind: "not_open" });
		expect(events()).toEqual([]);
	});

	it("refuses a subscription no setup record names", async () => {
		db.queue.push([]);
		await expect(closeSetup(args, print)).resolves.toMatchObject({ kind: "refused" });
		expect(retrieve).not.toHaveBeenCalled();
	});
});

describe("close-setup under the hold lock (#6052)", () => {
	it("caps the lock wait, probes for a committed hold, then takes payment_holds in SHARE mode — all before the write", async () => {
		db.queue.push([row()]);
		retrieve.mockResolvedValueOnce({ id: "sub_x", status: "canceled", metadata: {} });
		db.queue.push([row({ closed_at: new Date() })]);
		await expect(closeSetup(args, print)).resolves.toEqual({ kind: "closed", xRead: "ended" });
		expect(db.db.transaction).toHaveBeenCalledTimes(1);
		expect(db.executed).toEqual([
			expect.stringMatching(/set_config\('lock_timeout'/),
			expect.stringMatching(/FROM payment_holds WHERE subscription_id = \$1 AND state <> 'released'/),
			"LOCK TABLE payment_holds IN SHARE MODE",
		]);
		expect(db.db.update).toHaveBeenCalledTimes(1);
	});

	it("a committed open hold short-cuts the close: no lock, no write, and the hold's refusal", async () => {
		db.queue.push([row()]);
		retrieve.mockResolvedValueOnce({ id: "sub_x", status: "canceled", metadata: {} });
		db.executeResults.push([], [{ "?column?": 1 }]);
		db.queue.push([{ state: "closing" }]); // openHoldState, after the close matched nothing
		await expect(closeSetup(args, print)).resolves.toMatchObject({
			kind: "refused",
			reason: expect.stringMatching(/open payment hold \(closing\)/),
		});
		expect(db.executed).not.toContain("LOCK TABLE payment_holds IN SHARE MODE");
		expect(db.db.update).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});

	it("a lock not free within the timeout (55P03) refuses, writes nothing and emits nothing", async () => {
		db.queue.push([row()]);
		retrieve.mockResolvedValueOnce({ id: "sub_x", status: "canceled", metadata: {} });
		db.executeResults.push([], [], Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
		await expect(closeSetup(args, print)).resolves.toMatchObject({
			kind: "refused",
			reason: expect.stringMatching(/not free within 2s\); nothing was written/),
		});
		expect(db.db.update).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});

	it("any other database failure is thrown, not turned into a refusal", async () => {
		db.queue.push([row()]);
		retrieve.mockResolvedValueOnce({ id: "sub_x", status: "canceled", metadata: {} });
		db.executeResults.push(Object.assign(new Error("connection reset"), { code: "08006" }));
		await expect(closeSetup(args, print)).rejects.toThrow("connection reset");
		expect(db.db.update).not.toHaveBeenCalled();
	});
});

describe("close-setup on an X Stripe cannot find (C97)", () => {
	it("prints that it is not found, and with a --reason closes it with x_read = resource_missing", async () => {
		db.queue.push([row()]);
		retrieve.mockRejectedValueOnce(Object.assign(new Error("No such subscription"), { code: "resource_missing" }));
		db.queue.push([row({ closed_at: new Date() })]);
		await expect(closeSetup(args, print)).resolves.toEqual({ kind: "closed", xRead: "resource_missing" });
		expect(printed.join("\n")).toMatch(/sub_x not found in this Stripe account/);
		const line: unknown = JSON.parse(String(info.mock.calls[0]?.[0]));
		expect(line).toMatchObject({ event: "billing.pending_org_setup.closed", x_read: "resource_missing" });
	});

	it("still refuses with no --reason", async () => {
		await expect(closeSetup({ ...args, reason: undefined }, print)).resolves.toMatchObject({ kind: "refused" });
		expect(retrieve).not.toHaveBeenCalled();
	});
});

describe("the command line", () => {
	it("exits 1 on a refusal and on a malformed call, 0 when it closed", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await expect(main(["close-setup", "sub_x"])).resolves.toBe(1);
		await expect(main(["close-setup"])).resolves.toBe(1);
		await expect(main(["list"])).resolves.toBe(1);
		db.queue.push([row()]);
		retrieve.mockResolvedValueOnce({ id: "sub_x", status: "canceled", metadata: {} });
		db.queue.push([row({ closed_at: new Date() })]);
		await expect(
			main(["close-setup", "sub_x", "--reason", "refunded", "--operator=op-1"]),
		).resolves.toBe(0);
		expect(db.sets).toEqual([expect.objectContaining({ closed_by: "op-1", closed_note: "refunded" })]);
		err.mockRestore();
		log.mockRestore();
	});
});
