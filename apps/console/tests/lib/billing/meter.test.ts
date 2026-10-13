// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe billing-meter reporting (lib/billing/meter.ts). Mocked boundary: stub Stripe + a drizzle
// chain whose SELECT (`.limit`) and claim UPDATE (`.returning`) resolve independently, so we can
// drive the minutes math, the every guard, the idempotent claim, and the rollback-on-error path.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/config", () => ({
	isStripeConfigured: vi.fn(),
	RUNNER_MINUTES_METER_EVENT: "runner_minutes",
}));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { reportJobUsageOnce, reportRunnerMinutes } from "@/lib/billing/meter";
import { isStripeConfigured } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";

function mockStripe() {
	const create = vi.fn(async () => ({}));
	vi.mocked(getStripe).mockReturnValue({ billing: { meterEvents: { create } } } as never);
	return { create };
}

/** Chain whose select terminates at `.limit` (→ selectRows) and claim update at `.returning`. */
function mockDb(selectRows: unknown[], updateRows: unknown[] = [{ id: "j1" }]) {
	const setSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		limit: () => Promise.resolve(selectRows),
		returning: () => Promise.resolve(updateRows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isStripeConfigured).mockReturnValue(true);
});

describe("reportRunnerMinutes", () => {
	it("sends a rounded meter event and returns true", async () => {
		const { create } = mockStripe();
		expect(await reportRunnerMinutes("j1", "cus_1", 5.7)).toBe(true);
		expect(create).toHaveBeenCalledWith({
			event_name: "runner_minutes",
			identifier: "runner_minutes-job-j1",
			payload: { value: "6", stripe_customer_id: "cus_1" }, // round(5.7)=6, as string
		});
	});

	it("no-ops (false) when unwired, customerless, or minutes ≤ 0", async () => {
		const { create } = mockStripe();
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		expect(await reportRunnerMinutes("j1", "cus_1", 5)).toBe(false);
		vi.mocked(isStripeConfigured).mockReturnValue(true);
		expect(await reportRunnerMinutes("j1", null, 5)).toBe(false);
		expect(await reportRunnerMinutes("j1", "cus_1", 0)).toBe(false);
		expect(create).not.toHaveBeenCalled();
	});
});

const managedRow = (over: Record<string, unknown> = {}) => ({
	operator: "managed",
	startedAt: new Date("2026-01-01T00:00:00Z"),
	completedAt: new Date("2026-01-01T00:02:00Z"), // 2 minutes
	reportedAt: null,
	customerId: "cus_1",
	...over,
});

describe("reportJobUsageOnce — guards", () => {
	it("no-ops when Stripe isn't configured (no DB touch)", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		await reportJobUsageOnce("j1");
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("no-ops for self-operated, already-reported, or untimed jobs", async () => {
		const { create } = mockStripe();
		mockDb([managedRow({ operator: "self" })]);
		await reportJobUsageOnce("j1");
		mockDb([managedRow({ reportedAt: new Date() })]);
		await reportJobUsageOnce("j1");
		mockDb([managedRow({ completedAt: null })]);
		await reportJobUsageOnce("j1");
		expect(create).not.toHaveBeenCalled();
	});

	it("no-ops when the idempotent claim is lost to a concurrent request", async () => {
		const { create } = mockStripe();
		mockDb([managedRow()], []); // claim update returns no row → already taken
		await reportJobUsageOnce("j1");
		expect(create).not.toHaveBeenCalled();
	});
});

describe("reportJobUsageOnce — report + rollback", () => {
	it("reports the computed minutes once after winning the claim", async () => {
		const { create } = mockStripe();
		mockDb([managedRow()], [{ id: "j1" }]); // claim won
		await reportJobUsageOnce("j1");
		expect(create).toHaveBeenCalledWith({
			event_name: "runner_minutes",
			identifier: "runner_minutes-job-j1",
			payload: { value: "2", stripe_customer_id: "cus_1" }, // 2 minutes
		});
	});

	it("rolls the claim watermark back and rethrows when Stripe fails", async () => {
		const create = vi.fn(async () => {
			throw new Error("stripe down");
		});
		vi.mocked(getStripe).mockReturnValue({ billing: { meterEvents: { create } } } as never);
		const { setSpy } = mockDb([managedRow()], [{ id: "j1" }]);
		await expect(reportJobUsageOnce("j1")).rejects.toThrow("stripe down");
		// last set() call releases the claim (usage_reported_at → null)
		expect(setSpy).toHaveBeenLastCalledWith({ usage_reported_at: null });
	});
});

// #5746: the claim is released when Stripe throws, and a throw does not prove Stripe did not
// record the event (an accepted event whose reply was lost throws too). The only thing that
// stops the retry billing the job a second time is Stripe deduplicating it by identifier — so
// the identifier must be present on every call and identical across attempts for one job.
describe("reportJobUsageOnce — meter identifier (#5746)", () => {
	/** The `identifier` each create() call carried, in call order. */
	function sentIdentifiers(create: ReturnType<typeof vi.fn>): unknown[] {
		return create.mock.calls.map((call: unknown[]) => {
			const params: unknown = call[0];
			return typeof params === "object" && params !== null && "identifier" in params
				? params.identifier
				: undefined;
		});
	}

	it("sends the same identifier on a retry after the reply was lost", async () => {
		// Attempt 1: Stripe accepted the event, but the reply never arrived (the SDK throws).
		const create = vi
			.fn()
			.mockRejectedValueOnce(new Error("socket timeout"))
			.mockResolvedValueOnce({});
		vi.mocked(getStripe).mockReturnValue({ billing: { meterEvents: { create } } } as never);
		const { setSpy } = mockDb([managedRow()], [{ id: "j1" }]);
		await expect(reportJobUsageOnce("j1")).rejects.toThrow("socket timeout");
		expect(setSpy).toHaveBeenLastCalledWith({ usage_reported_at: null }); // claim released

		// Attempt 2: the released claim lets a later call report again.
		await reportJobUsageOnce("j1");

		expect(create).toHaveBeenCalledTimes(2);
		const [first, second] = sentIdentifiers(create);
		expect(first).toBe("runner_minutes-job-j1");
		expect(second).toBe(first);
	});

	it("derives the identifier from the job, so two jobs never share one", async () => {
		const { create } = mockStripe();
		mockDb([managedRow()], [{ id: "j1" }]);
		await reportJobUsageOnce("j1");
		mockDb([managedRow()], [{ id: "j2" }]);
		await reportJobUsageOnce("j2");
		expect(sentIdentifiers(create)).toEqual([
			"runner_minutes-job-j1",
			"runner_minutes-job-j2",
		]);
	});
});
