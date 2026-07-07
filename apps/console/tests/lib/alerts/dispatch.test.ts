// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alert delivery dispatch + retry (lib/alerts/dispatch.ts). Mocked boundary: a drizzle chain whose
// claim UPDATE (`.returning`) and the channel/due SELECT (`.limit`) resolve independently, plus a
// stub channel sender. Drives the claim race, channel-gone/disabled → dead, send→sent, and the
// failed→backoff vs dead-at-max-attempts ledger transitions (the retry state machine).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/channels", () => ({ getChannelSender: vi.fn() }));

import { deliverOne, sweepDueDeliveries } from "@/lib/alerts/dispatch";
import { getServiceDb } from "@/lib/db";
import { getChannelSender } from "@/lib/alerts/channels";

/** Chain: claim `.returning` → [claimed]|[]; channel/due `.limit` → [channel]|due; `.set` recorded. */
function mockDb(opts: {
	claimed?: Record<string, unknown> | null;
	channel?: Record<string, unknown> | null;
	due?: unknown[];
}) {
	const sets: Record<string, unknown>[] = [];
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		update: () => db,
		set: (v: Record<string, unknown>) => {
			sets.push(v);
			return db;
		},
		where: () => db,
		select: () => db,
		from: () => db,
		returning: () => Promise.resolve(opts.claimed ? [opts.claimed] : []),
		limit: () => Promise.resolve(opts.due ?? (opts.channel ? [opts.channel] : [])),
		then: (resolve: (v: unknown) => void) => resolve(undefined), // bare status-update awaits
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { sets };
}

/** A claimed delivery row (status-update target). */
const claim = (over: Record<string, unknown> = {}) => ({
	id: "d1",
	channel_id: "c1",
	attempts: 0,
	max_attempts: 3,
	context: { title: "x" },
	...over,
});

function mockSender(send: () => Promise<void> = async () => {}) {
	const sender = { send: vi.fn(send) };
	vi.mocked(getChannelSender).mockReturnValue(sender as never);
	return sender;
}

beforeEach(() => vi.clearAllMocks());

describe("deliverOne — claim", () => {
	it("does nothing when the row can't be claimed (another worker owns it)", async () => {
		mockDb({ claimed: null });
		const sender = mockSender();
		await deliverOne(claim() as never);
		expect(sender.send).not.toHaveBeenCalled();
	});
});

describe("deliverOne — channel gone / disabled → dead", () => {
	it("marks dead when the delivery has no channel_id", async () => {
		const { sets } = mockDb({ claimed: claim({ channel_id: null }) });
		const sender = mockSender();
		await deliverOne(claim({ channel_id: null }) as never);
		expect(sender.send).not.toHaveBeenCalled();
		expect(sets.at(-1)).toMatchObject({ status: "dead", last_error: "channel removed", attempts: 1 });
	});

	it("marks dead when the channel row is missing", async () => {
		const { sets } = mockDb({ claimed: claim(), channel: null });
		await deliverOne(claim() as never);
		expect(sets.at(-1)).toMatchObject({ status: "dead", last_error: "channel removed" });
	});

	it("marks dead when the channel is disabled", async () => {
		const { sets } = mockDb({ claimed: claim(), channel: { id: "c1", enabled: false, type: "slack" } });
		await deliverOne(claim() as never);
		expect(sets.at(-1)).toMatchObject({ status: "dead", last_error: "channel disabled" });
	});
});

describe("deliverOne — send outcomes", () => {
	it("marks sent on a successful send", async () => {
		const { sets } = mockDb({ claimed: claim(), channel: { id: "c1", enabled: true, type: "slack" } });
		const sender = mockSender(async () => {});
		await deliverOne(claim() as never);
		expect(sender.send).toHaveBeenCalledWith(
			{ id: "c1", enabled: true, type: "slack" },
			{ title: "x" },
		);
		expect(sets.at(-1)).toMatchObject({ status: "sent", attempts: 1, last_error: null, next_attempt_at: null });
	});

	it("marks failed + schedules a backoff retry when under max attempts", async () => {
		const { sets } = mockDb({
			claimed: claim({ attempts: 0, max_attempts: 3 }),
			channel: { id: "c1", enabled: true, type: "slack" },
		});
		mockSender(async () => {
			throw new Error("boom");
		});
		const before = Date.now();
		await deliverOne(claim() as never);
		const last = sets.at(-1)!;
		expect(last).toMatchObject({ status: "failed", attempts: 1, last_error: "boom" });
		// backoff for attempt 1 = min(60s·2¹, 1h) = 120s out.
		const delay = (last.next_attempt_at as Date).getTime() - before;
		expect(delay).toBeGreaterThanOrEqual(120_000);
		expect(delay).toBeLessThan(130_000);
	});

	it("marks dead (no retry) once attempts hit max_attempts", async () => {
		const { sets } = mockDb({
			claimed: claim({ attempts: 2, max_attempts: 3 }), // this attempt = 3 = max
			channel: { id: "c1", enabled: true, type: "slack" },
		});
		mockSender(async () => {
			throw new Error("boom");
		});
		await deliverOne(claim() as never);
		expect(sets.at(-1)).toMatchObject({ status: "dead", attempts: 3, next_attempt_at: null });
	});
});

describe("sweepDueDeliveries", () => {
	it("returns 0 when nothing is due", async () => {
		mockDb({ due: [] });
		expect(await sweepDueDeliveries()).toBe(0);
	});

	it("returns the count of due deliveries it processed", async () => {
		// claims are lost (returning []), so each deliverOne early-returns — we just assert the count.
		mockDb({ due: [claim({ id: "a" }), claim({ id: "b" })], claimed: null });
		expect(await sweepDueDeliveries()).toBe(2);
	});
});
