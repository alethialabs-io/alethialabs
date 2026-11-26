// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Paddle webhook route (app/api/webhooks/paddle/route.ts), end to end through the REAL signature
// check, normalizer and applyBillingEvent; only the ledger, the store and the alert sink are fakes.
// Proves: fail closed without config (503) and on a config that will not load (503); a missing,
// forged or stale signature is 400 and touches nothing; a genuine delivery is applied once and a
// duplicate is acknowledged; a refusal is still 200; a verified but unparseable body and a handler
// failure are 500 with the ledger row marked `error`; an oversized body is 413.

import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG, envelope, subscriptionData, transactionData } from "../../fixtures/paddle-events";

const SECRET = "pdl_ntfset_route_test";

const h = vi.hoisted(() => ({
	configured: true,
	configThrows: false,
	ledger: new Map<string, string>(),
	rows: new Map<string, Record<string, unknown>>(),
	orgs: new Set<string>(),
	alert: vi.fn(async () => true),
	capture: vi.fn(async () => undefined),
	failWrite: false,
}));

vi.mock("@/lib/billing/paddle/config", () => ({
	isPaddleConfigured: () => h.configured,
	getPaddleConfig: () => {
		if (h.configThrows) throw new Error("Invalid Paddle config: prices.team: required");
		return { webhookSecret: SECRET, prices: CATALOG.prices };
	},
}));

vi.mock("@/lib/billing/webhook-events", () => ({
	claimWebhookEvent: vi.fn(async (provider: string, id: string) => {
		const key = `${provider}:${id}`;
		const status = h.ledger.get(key);
		if (status === undefined) {
			h.ledger.set(key, "processing");
			return { claimed: true };
		}
		return { claimed: false, alreadyDone: status === "done" };
	}),
	runWebhookEventExactlyOnce: vi.fn(async (provider: string, id: string, _t: string, fn: () => Promise<void>) => {
		const key = `${provider}:${id}`;
		if (h.ledger.get(key) === "done") return "skipped_done";
		await fn();
		h.ledger.set(key, "done");
		return "handled";
	}),
	markWebhookEventError: vi.fn(async (provider: string, id: string) => {
		h.ledger.set(`${provider}:${id}`, "error");
	}),
}));

vi.mock("@/lib/billing/events/store", () => ({
	postgresBillingEventStore: {
		orgExists: async (id: string) => h.orgs.has(id),
		orgForSubscription: async (sub: string) => {
			for (const [org, row] of h.rows) if (row.paddleSubscriptionId === sub) return org;
			return null;
		},
		businessOwner: async () => null,
		// The record check has its own tests (apply-billing-event.test.ts); here every org has one.
		orgHasRecordOf: async () => true,
		withLockedRow: async (
			orgId: string,
			fn: (row: null, write: (p: Record<string, unknown>) => Promise<void>) => Promise<unknown>,
		) =>
			fn(null, async (patch) => {
				if (h.failWrite) throw new Error("connection reset");
				h.rows.set(orgId, { ...h.rows.get(orgId), ...patch });
			}),
		upsertTransaction: async () => true,
		getTransaction: async () => null,
		markTransaction: async () => undefined,
		grantPackCredits: async () => true,
		reversePackCredits: async () => 0,
	},
}));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: h.alert }));
vi.mock("@/lib/analytics/server", () => ({ captureServerException: h.capture }));

import { POST } from "@/app/api/webhooks/paddle/route";

const ORG = randomUUID();

/** A signed POST of `body`, at `ts` (defaults to now). */
function signedRequest(body: string, opts: { ts?: number; secret?: string; header?: string | null } = {}): Request {
	const ts = opts.ts ?? Math.floor(Date.now() / 1000);
	const h1 = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}:${body}`).digest("hex");
	const headers = new Headers({ "content-type": "application/json" });
	const header = opts.header === undefined ? `ts=${ts};h1=${h1}` : opts.header;
	if (header !== null) headers.set("paddle-signature", header);
	return new Request("http://local/api/webhooks/paddle", { method: "POST", body, headers });
}

/** A subscription.created body for ORG with a fresh event id. */
function subscriptionBody(eventId = `evt_${randomUUID()}`): string {
	return JSON.stringify(
		envelope("subscription.created", subscriptionData({ custom_data: { organizationId: ORG, kind: "plan" } }), {
			event_id: eventId,
		}),
	);
}

beforeEach(() => {
	h.configured = true;
	h.configThrows = false;
	h.failWrite = false;
	h.ledger.clear();
	h.rows.clear();
	h.orgs.clear();
	h.orgs.add(ORG);
	h.alert.mockClear();
	h.capture.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("POST /api/webhooks/paddle", () => {
	it("is 503 when Paddle is not configured, before reading anything", async () => {
		h.configured = false;
		const res = await POST(signedRequest(subscriptionBody()));
		expect(res.status).toBe(503);
		expect(h.ledger.size).toBe(0);
	});

	it("is 503 when the config will not load (fail closed)", async () => {
		h.configThrows = true;
		const res = await POST(signedRequest(subscriptionBody()));
		expect(res.status).toBe(503);
		expect(h.rows.size).toBe(0);
	});

	it("is 400 for a missing, forged or stale signature, and touches nothing", async () => {
		const body = subscriptionBody();
		const missing = await POST(signedRequest(body, { header: null }));
		expect(missing.status).toBe(400);
		expect(await missing.text()).toContain("missing_header");
		expect((await POST(signedRequest(body, { secret: "pdl_ntfset_attacker" }))).status).toBe(400);
		const stale = await POST(signedRequest(body, { ts: Math.floor(Date.now() / 1000) - 3600 }));
		expect(stale.status).toBe(400);
		expect(await stale.text()).toContain("stale_timestamp");
		expect(h.ledger.size).toBe(0);
		expect(h.rows.size).toBe(0);
	});

	it("applies a genuine delivery once and acknowledges the duplicate", async () => {
		const body = subscriptionBody("evt_once");
		const first = await POST(signedRequest(body));
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ received: true });
		expect(h.rows.get(ORG)).toMatchObject({ billingProvider: "paddle", paddleSubscriptionId: "sub_01test", plan: "team" });
		expect(h.ledger.get("paddle:evt_once")).toBe("done");

		const again = await POST(signedRequest(body));
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ received: true, duplicate: true });
	});

	it("acknowledges a refused event with 200 (redelivery would change nothing)", async () => {
		h.orgs.clear();
		const res = await POST(signedRequest(subscriptionBody()));
		expect(res.status).toBe(200);
		expect(h.rows.size).toBe(0);
		expect(h.alert).toHaveBeenCalledTimes(1);
	});

	it("acknowledges an event type it does not handle", async () => {
		const body = JSON.stringify(envelope("customer.created", { id: "ctm_1" }, { event_id: "evt_ignored" }));
		const res = await POST(signedRequest(body));
		expect(res.status).toBe(200);
		expect(h.ledger.get("paddle:evt_ignored")).toBe("done");
	});

	it("is 500 for a verified body that does not parse", async () => {
		const body = JSON.stringify(envelope("transaction.completed", transactionData({ details: null })));
		const res = await POST(signedRequest(body));
		expect(res.status).toBe(500);
		expect(h.capture).toHaveBeenCalledTimes(1);
	});

	it("is 500 when applying fails, with the ledger row marked error for the retry", async () => {
		h.failWrite = true;
		const res = await POST(signedRequest(subscriptionBody("evt_fail")));
		expect(res.status).toBe(500);
		expect(h.ledger.get("paddle:evt_fail")).toBe("error");
	});

	it("is 500 for an adjustment whose transaction is not mirrored yet, so Paddle redelivers", async () => {
		const body = JSON.stringify(
			envelope(
				"adjustment.created",
				{ id: "adj_1", action: "refund", type: "full", transaction_id: "txn_1", status: "approved", currency_code: "EUR", totals: { total: "100" } },
				{ event_id: "evt_adj" },
			),
		);
		const res = await POST(signedRequest(body));
		expect(res.status).toBe(500);
		expect(h.ledger.get("paddle:evt_adj")).toBe("error");
	});

	it("is 413 for an oversized body", async () => {
		const res = await POST(signedRequest("x".repeat(600 * 1024)));
		expect(res.status).toBe(413);
	});
});
