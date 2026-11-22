// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The trial's server seams (lib/billing/trial/index.ts, REL-L19 #6907): the offer reads the launch
// state, a start spends every ceiling or none, and a refusal names the ceiling that was full. The
// store is replaced (its SQL is exercised against Postgres in tests/integration/trial-ceilings.test.ts);
// the decision and the launch state are real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	reserveTrialSlots: vi.fn(),
	releaseTrialSlots: vi.fn(),
	peekFullCounter: vi.fn(),
}));
vi.mock("@/lib/billing/trial/store", () => store);
const request = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => request);

import { ABUSE_LIMITS } from "@/lib/abuse/limits";
import { TEST_MODE_MARKET_FLAG } from "@/lib/billing/eligibility";
import { trialNetworkKey } from "@/lib/billing/trial/ceilings";
import {
	personTrialAvailable,
	releaseTrial,
	reserveTrial,
	TrialNotAllowedError,
	trialSalesOpen,
} from "@/lib/billing/trial";
import type { TrialCounter } from "@/lib/billing/trial/ceilings";
import { getAuthConfig } from "@/lib/config/auth";
import { log } from "@/lib/observability/log";

/** The counters the last reservation was asked for. */
function reservedCounters(): TrialCounter[] {
	const call = store.reserveTrialSlots.mock.calls.at(-1);
	if (!call) throw new Error("reserveTrialSlots was not called");
	return call[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	request.headers.mockResolvedValue(new Headers({ [getAuthConfig().trustedIpHeader]: "198.51.100.7" }));
	store.reserveTrialSlots.mockImplementation(async (counters: TrialCounter[]) => ({
		ok: true,
		slots: counters.map((c) => ({ key: c.key, windowStart: new Date(0) })),
	}));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("trialSalesOpen", () => {
	it("is closed while the launch state has no open market — the trial is the paid state", () => {
		expect(trialSalesOpen({})).toBe(false);
	});

	it("opens only on a Stripe test-mode console carrying the release gate's waiver", () => {
		expect(trialSalesOpen({ STRIPE_SECRET_KEY: "sk_test_x", [TEST_MODE_MARKET_FLAG]: "1" })).toBe(true);
		expect(trialSalesOpen({ STRIPE_SECRET_KEY: "sk_live_x", [TEST_MODE_MARKET_FLAG]: "1" })).toBe(false);
		expect(trialSalesOpen({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
	});
});

describe("reserveTrial", () => {
	it("spends the organization, the person and the request's network together", async () => {
		const reservation = await reserveTrial({ orgId: "org-1", email: "ada@example.test" });
		const counters = reservedCounters();
		expect(counters.map((c) => c.refusal)).toEqual(["trial_org_used", "trial_person_limit", "trial_network_limit"]);
		expect(counters[2]?.key).toBe(trialNetworkKey("198.51.100.7", getAuthConfig().secret));
		expect(reservation.slots).toHaveLength(3);
	});

	it("does not count a network when the request has no trusted client address, and says so", async () => {
		request.headers.mockResolvedValue(new Headers());
		const warned = vi.spyOn(log, "warn").mockImplementation(() => {});
		await reserveTrial({ orgId: "org-1", email: "ada@example.test" });
		expect(reservedCounters().map((c) => c.refusal)).toEqual(["trial_org_used", "trial_person_limit"]);
		expect(warned).toHaveBeenCalledWith(expect.stringMatching(/no trusted client address/));
	});

	it("has no network to count outside a request", async () => {
		request.headers.mockRejectedValue(new Error("headers() was called outside a request scope"));
		vi.spyOn(log, "warn").mockImplementation(() => {});
		await reserveTrial({ orgId: "org-1", email: "ada@example.test" });
		expect(reservedCounters()).toHaveLength(2);
	});

	it.each([
		["trial_org_used", /organization has already used/],
		["trial_person_limit", /account has already used/],
		["trial_network_limit", /from your network/],
	] as const)("throws %s with its message, logging the reason only", async (refusal, message) => {
		store.reserveTrialSlots.mockImplementation(async (counters: TrialCounter[]) => ({
			ok: false,
			refused: counters.find((c) => c.refusal === refusal),
		}));
		const warned = vi.spyOn(log, "warn").mockImplementation(() => {});
		const attempt = reserveTrial({ orgId: "org-1", email: "ada@example.test" });
		await expect(attempt).rejects.toBeInstanceOf(TrialNotAllowedError);
		await expect(attempt).rejects.toThrow(message);
		expect(warned).toHaveBeenCalledWith("[billing] trial start refused by a ceiling", { reason: refusal });
		expect(JSON.stringify(warned.mock.calls)).not.toContain("198.51");
		expect(JSON.stringify(warned.mock.calls)).not.toContain("ada@");
	});

	it("propagates a store failure, so the trial does not start", async () => {
		store.reserveTrialSlots.mockRejectedValue(new Error("database unavailable"));
		await expect(reserveTrial({ orgId: "org-1", email: "ada@example.test" })).rejects.toThrow(/database unavailable/);
	});
});

describe("releaseTrial", () => {
	it("gives the slots back", async () => {
		const slots = [{ key: "trial:org:org-1", windowStart: new Date(0) }];
		await releaseTrial({ slots });
		expect(store.releaseTrialSlots).toHaveBeenCalledWith(slots);
	});

	it("logs and swallows a failed release, so the caller's own failure is the one reported", async () => {
		store.releaseTrialSlots.mockRejectedValue(new Error("boom"));
		const logged = vi.spyOn(log, "error").mockImplementation(() => {});
		await expect(releaseTrial({ slots: [] })).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalledWith("[billing] trial reservation release failed", { error: "Error" });
	});
});

describe("personTrialAvailable", () => {
	it("peeks at the person counter alone, under the table's per-person number", async () => {
		store.peekFullCounter.mockResolvedValue(null);
		expect(await personTrialAvailable("ada@example.test")).toBe(true);
		const [counters] = store.peekFullCounter.mock.calls[0] ?? [];
		expect(counters).toHaveLength(1);
		expect(counters?.[0]).toMatchObject({
			refusal: "trial_person_limit",
			limit: ABUSE_LIMITS.trial_per_person.defaultValue,
		});
	});

	it("is false once the person counter is full", async () => {
		store.peekFullCounter.mockImplementation(async (counters: TrialCounter[]) => counters[0]);
		expect(await personTrialAvailable("ada@example.test")).toBe(false);
	});
});
