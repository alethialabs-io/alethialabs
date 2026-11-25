// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managing a Paddle subscription (L4): cancel at period end, resume (withdraw the scheduled cancel),
// change plan with the documented proration choice, the portal link, and live prices from the
// pricing preview. The fake client answers through the real envelope + response schemas.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { type PaddleClient, type PaddleRequest, parsePaddleData } from "@/lib/billing/paddle/api";
import type { PaddleConfig } from "@/lib/billing/paddle/config";
import { createPaddleProvider, paddleManagementUrl } from "@/lib/billing/paddle/provider";
import {
	cancelPaddleSubscriptionAtPeriodEnd,
	changePaddleSubscriptionPlan,
	paddleLivePrices,
	paddlePortalUrl,
	prorationModeFor,
	resumePaddleSubscription,
} from "@/lib/billing/paddle/subscriptions";
import { CATALOG, PRICE_AI_MAX, PRICE_AI_PLUS, PRICE_ENTERPRISE, PRICE_TEAM } from "../../fixtures/paddle-events";

/** A fake client recording requests; `respond` returns the `data` member. */
function fakeClient(respond: (req: PaddleRequest) => unknown): { client: PaddleClient; calls: PaddleRequest[] } {
	const calls: PaddleRequest[] = [];
	const client: PaddleClient = {
		environment: "sandbox",
		async request<T extends z.ZodType>(req: PaddleRequest, data: T): Promise<z.infer<T>> {
			calls.push(req);
			return parsePaddleData(data, { data: respond(req) });
		},
		getEventTypes: async () => [],
	};
	return { client, calls };
}

/** A Paddle subscription entity carrying one line. */
function sub(priceId: string, quantity = 1, scheduled: { action: string; effective_at: string } | null = null) {
	return {
		id: "sub_01",
		status: "active",
		items: [{ quantity, price: { id: priceId } }],
		scheduled_change: scheduled,
		current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
	};
}

const config = { prices: CATALOG.prices };

describe("prorationModeFor", () => {
	it("bills an upgrade now and a downgrade at renewal", () => {
		expect(prorationModeFor({ rank: 1, quantity: 1 }, { rank: 2, quantity: 1 })).toBe("prorated_immediately");
		expect(prorationModeFor({ rank: 1, quantity: 2 }, { rank: 1, quantity: 5 })).toBe("prorated_immediately");
		expect(prorationModeFor({ rank: 2, quantity: 1 }, { rank: 1, quantity: 1 })).toBe("prorated_next_billing_period");
		expect(prorationModeFor({ rank: 1, quantity: 5 }, { rank: 1, quantity: 2 })).toBe("prorated_next_billing_period");
		// A higher plan with fewer seats is still an upgrade: the rank decides first.
		expect(prorationModeFor({ rank: 1, quantity: 9 }, { rank: 2, quantity: 1 })).toBe("prorated_immediately");
	});
});

describe("changePaddleSubscriptionPlan", () => {
	it("upgrades AI Plus → AI Max with immediate proration", async () => {
		const { client, calls } = fakeClient((req) => (req.method === "GET" ? sub(PRICE_AI_PLUS) : sub(PRICE_AI_MAX)));
		const out = await changePaddleSubscriptionPlan(client, "sub_01", { kind: "ai_tier", tier: "ai_max" }, config);
		expect(out.proration).toBe("prorated_immediately");
		expect(calls.at(-1)).toEqual({
			method: "PATCH",
			path: "/subscriptions/sub_01",
			body: { items: [{ price_id: PRICE_AI_MAX, quantity: 1 }], proration_billing_mode: "prorated_immediately" },
		});
	});

	it("downgrades Enterprise → Pro, and fewer Pro seats, at the next renewal", async () => {
		const ent = fakeClient((req) => (req.method === "GET" ? sub(PRICE_ENTERPRISE) : sub(PRICE_TEAM, 3)));
		const down = await changePaddleSubscriptionPlan(ent.client, "sub_01", { kind: "plan", plan: "team", seats: 3 }, config);
		expect(down.proration).toBe("prorated_next_billing_period");
		const seats = fakeClient((req) => (req.method === "GET" ? sub(PRICE_TEAM, 5) : sub(PRICE_TEAM, 2)));
		const fewer = await changePaddleSubscriptionPlan(seats.client, "sub_01", { kind: "plan", plan: "team", seats: 2 }, config);
		expect(fewer.proration).toBe("prorated_next_billing_period");
		expect(seats.calls.at(-1)?.body).toEqual({
			items: [{ price_id: PRICE_TEAM, quantity: 2 }],
			proration_billing_mode: "prorated_next_billing_period",
		});
	});

	it("never swaps a plan onto an AI subscription", async () => {
		const { client, calls } = fakeClient(() => sub(PRICE_AI_PLUS));
		await expect(
			changePaddleSubscriptionPlan(client, "sub_01", { kind: "plan", plan: "team" }, config),
		).rejects.toThrow(/not a plan subscription/);
		expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
	});
});

describe("cancel and resume", () => {
	it("cancels at the end of the billing period", async () => {
		const { client, calls } = fakeClient(() => sub(PRICE_TEAM, 1, { action: "cancel", effective_at: "2026-12-01T00:00:00Z" }));
		await cancelPaddleSubscriptionAtPeriodEnd(client, "sub_01");
		expect(calls).toEqual([
			{ method: "POST", path: "/subscriptions/sub_01/cancel", body: { effective_from: "next_billing_period" } },
		]);
	});

	it("resumes by clearing the scheduled cancellation, and refuses to clear any other change", async () => {
		const scheduled = fakeClient((req) =>
			req.method === "GET" ? sub(PRICE_TEAM, 1, { action: "cancel", effective_at: "2026-12-01T00:00:00Z" }) : sub(PRICE_TEAM),
		);
		await resumePaddleSubscription(scheduled.client, "sub_01");
		expect(scheduled.calls.at(-1)).toEqual({ method: "PATCH", path: "/subscriptions/sub_01", body: { scheduled_change: null } });

		const nothing = fakeClient(() => sub(PRICE_TEAM));
		await resumePaddleSubscription(nothing.client, "sub_01");
		expect(nothing.calls.map((c) => c.method)).toEqual(["GET"]);

		const paused = fakeClient(() => sub(PRICE_TEAM, 1, { action: "pause", effective_at: "2026-12-01T00:00:00Z" }));
		await expect(resumePaddleSubscription(paused.client, "sub_01")).rejects.toThrow(/scheduled pause/);
	});
});

describe("portal", () => {
	it("opens a portal session deep-linked to the org's subscriptions", async () => {
		const { client, calls } = fakeClient(() => ({
			id: "cpls_1",
			urls: { general: { overview: "https://customer-portal.paddle.com/cpl_1?token=t" }, subscriptions: [] },
		}));
		const url = await paddleManagementUrl("org", {
			config: () => {
				throw new Error("not read");
			},
			nowMs: () => 0,
			client: () => client,
			orgRow: async () => ({ paddleCustomerId: "ctm_1", paddleSubscriptionId: "sub_plan", aiPaddleSubscriptionId: null }),
		});
		expect(url).toBe("https://customer-portal.paddle.com/cpl_1?token=t");
		expect(calls).toEqual([
			{ method: "POST", path: "/customers/ctm_1/portal-sessions", body: { subscription_ids: ["sub_plan"] } },
		]);
	});

	it("has nothing to open for an org without a Paddle customer", async () => {
		const { client } = fakeClient(() => ({}));
		await expect(
			paddleManagementUrl("org", { config: () => { throw new Error("x"); }, nowMs: () => 0, client: () => client, orgRow: async () => null }),
		).resolves.toBeNull();
		await expect(paddlePortalUrl(fakeClient(() => ({ urls: { general: { overview: "nope" } } })).client, "ctm_1", [])).rejects.toThrow();
	});
});

describe("live prices (O1)", () => {
	it("reads the pre-tax unit subtotal per currency from a US and a eurozone preview", async () => {
		const { client, calls } = fakeClient((req) => {
			const body = req.body;
			const country =
				typeof body === "object" && body !== null && "address" in body && typeof body.address === "object" && body.address !== null && "country_code" in body.address
					? body.address.country_code
					: null;
			const eur = country === "DE";
			return {
				currency_code: eur ? "EUR" : "USD",
				details: {
					line_items: [
						{ price: { id: PRICE_TEAM }, unit_totals: { subtotal: eur ? "1900" : "2000" } },
						{ price: { id: PRICE_AI_PLUS }, unit_totals: { subtotal: eur ? "900" : "1000" } },
						{ price: { id: "pri_someone_else" }, unit_totals: { subtotal: "1" } },
					],
				},
			};
		});
		const prices = await paddleLivePrices(client, config);
		expect(prices.plans.team).toEqual({ usd: { minor: 2000, currency: "usd" }, eur: { minor: 1900, currency: "eur" } });
		expect(prices.aiTiers.ai_plus).toEqual({ usd: { minor: 1000, currency: "usd" }, eur: { minor: 900, currency: "eur" } });
		expect(calls.every((c) => c.path === "/pricing-preview")).toBe(true);
	});

	it("leaves out a currency whose preview failed or answered in another currency", async () => {
		const { client } = fakeClient((req) => {
			const body = JSON.stringify(req.body);
			if (body.includes('"DE"')) return { currency_code: "USD", details: { line_items: [] } };
			return { currency_code: "USD", details: { line_items: [{ price: { id: PRICE_TEAM }, unit_totals: { subtotal: "2000" } }] } };
		});
		const prices = await paddleLivePrices(client, config);
		expect(prices.plans.team).toEqual({ usd: { minor: 2000, currency: "usd" } });
	});
});

describe("the adapter wires L4's methods", () => {
	it("cancel, resume and changePlan reach Paddle with the ref's subscription", async () => {
		const { client, calls } = fakeClient((req) =>
			req.method === "GET" ? sub(PRICE_TEAM, 1, { action: "cancel", effective_at: "2026-12-01T00:00:00Z" }) : sub(PRICE_TEAM),
		);
		const cfg = (): PaddleConfig => ({
			environment: "sandbox",
			apiKey: "pdl_sdbx_apikey_x",
			webhookSecret: "s",
			clientToken: "test_x",
			prices: CATALOG.prices,
			products: {},
			appUrl: "https://x.invalid",
		});
		const provider = createPaddleProvider({ config: cfg, nowMs: () => 0, client: () => client });
		const ref = { organizationId: "o", subscriptionId: "sub_01", slot: "plan" as const };
		await provider.cancelAtPeriodEnd(ref);
		await provider.resume(ref);
		await provider.changePlan(ref, { kind: "plan", plan: "team", seats: 4 });
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /subscriptions/sub_01/cancel",
			"GET /subscriptions/sub_01",
			"PATCH /subscriptions/sub_01",
			"GET /subscriptions/sub_01",
			"PATCH /subscriptions/sub_01",
		]);
	});
});
