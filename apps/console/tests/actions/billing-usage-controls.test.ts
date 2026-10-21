// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The usage controls' server half (#6127, F047): `saveAiSpendLimits` and `setUsageHardCap` through
// the mutation contract. The client validates first, but the SERVER is the boundary — a crafted
// request must get the same answer the form gives — so each refusal is asserted here with the
// database write it must not make.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, update, set, where, returning } = vi.hoisted(() => {
	const returning = vi.fn();
	const where = vi.fn(() => ({ returning }));
	const set = vi.fn(() => ({ where }));
	const update = vi.fn(() => ({ set }));
	return { authorize: vi.fn(), update, set, where, returning };
});

vi.mock("@/lib/authz/guard", () => ({
	authorize,
	authorizeQuiet: vi.fn(),
	authorizeInOrg: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({ update }) }));

import { saveAiSpendLimits, setUsageHardCap } from "@/app/server/actions/billing";
import { MAX_WEEKLY_CAP_CREDITS } from "@/components/settings/usage/spend-limits";
import { ForbiddenError } from "@/lib/authz/types";

beforeEach(() => {
	vi.clearAllMocks();
	authorize.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
	returning.mockResolvedValue([{ id: "billing-row" }]);
});

describe("saveAiSpendLimits", () => {
	it("stores both limits in credits and answers with what it stored", async () => {
		const result = await saveAiSpendLimits({ orgWeeklyCapCredits: 50_000, perUserWeeklyCapCredits: null });
		expect(result).toEqual({ ok: true, data: { orgWeeklyCapCredits: 50_000, perUserWeeklyCapCredits: null } });
		expect(authorize).toHaveBeenCalledWith("manage_billing", { type: "billing" });
		expect(set).toHaveBeenCalledWith(
			expect.objectContaining({ aiOrgWeeklyCapCredits: 50_000, aiPerUserWeeklyCapCredits: null }),
		);
	});

	it.each([
		["a negative limit", -5, "A limit can't be negative."],
		["an overflowing one (the F047 probe's 1e20)", 1e20, "A limit can be at most $10,000.00 a week."],
		["one just over the ceiling", MAX_WEEKLY_CAP_CREDITS + 1, "A limit can be at most $10,000.00 a week."],
		["a fraction of a credit", 1.5, "A limit is a whole number of credits."],
		["a fraction of a cent (the form only ever sends whole cents)", 12_345, "A limit is a whole number of cents."],
	])("refuses %s as a validation error on that field, and writes nothing", async (_label, value, message) => {
		const result = await saveAiSpendLimits({ orgWeeklyCapCredits: value, perUserWeeklyCapCredits: null });
		// The field's FIRST message is the one the form shows; a value can break more than one rule.
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "validation", message, fields: { orgWeeklyCapCredits: expect.arrayContaining([message]) } },
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("accepts the ceiling itself", async () => {
		const result = await saveAiSpendLimits({
			orgWeeklyCapCredits: MAX_WEEKLY_CAP_CREDITS,
			perUserWeeklyCapCredits: 0,
		});
		expect(result.ok).toBe(true);
	});

	it("refuses an org with no billing record instead of reporting a save that wrote no row", async () => {
		returning.mockResolvedValue([]);
		const result = await saveAiSpendLimits({ orgWeeklyCapCredits: 1_000, perUserWeeklyCapCredits: null });
		expect(result).toMatchObject({ ok: false, error: { kind: "conflict" } });
	});

	it("a member without the billing permission is refused as forbidden", async () => {
		authorize.mockRejectedValue(new ForbiddenError("manage_billing", { type: "billing" }));
		const result = await saveAiSpendLimits({ orgWeeklyCapCredits: 1_000, perUserWeeklyCapCredits: null });
		expect(result).toEqual({
			ok: false,
			error: { kind: "forbidden", message: "You don't have permission to do that." },
		});
		expect(update).not.toHaveBeenCalled();
	});
});

describe("setUsageHardCap", () => {
	it("flips the pause and answers with the new value", async () => {
		expect(await setUsageHardCap({ enabled: true })).toEqual({ ok: true, data: { enabled: true } });
		expect(set).toHaveBeenCalledWith(expect.objectContaining({ usageHardCap: true }));
		expect(where).toHaveBeenCalled();
	});

	it("refuses an org with no billing record", async () => {
		returning.mockResolvedValue([]);
		const result = await setUsageHardCap({ enabled: false });
		expect(result).toMatchObject({ ok: false, error: { kind: "conflict" } });
	});
});
