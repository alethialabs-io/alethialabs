// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// linkPaddleCustomer — the staff app's "Link Paddle customer" action, console side. Over an in-memory
// store and a real Paddle client whose fetch is stubbed, so the Paddle half runs the client's own
// envelope and error parsing rather than a mock of it:
//  - a malformed id is refused before anything is read;
//  - a first link writes and reports whether Paddle confirmed the customer;
//  - a DIFFERENT stored id is replaced only when the caller names it as the one to replace;
//  - the same id is a no-op that writes nothing and asks Paddle nothing;
//  - Paddle's 404 (or an unreachable Paddle) refuses, and nothing is written;
//  - a write that loses a race with another change is refused, not reported as done.

import { describe, expect, it, vi } from "vitest";
import { createPaddleClient, type PaddleClient } from "@/lib/billing/paddle/api";
import {
	type LinkPaddleCustomerDeps,
	linkPaddleCustomer,
	type PaddleCustomerStore,
} from "@/lib/platform/paddle-customer";
import { ProvisionError } from "@/lib/platform/provision";

const ORG = "00000000-0000-4000-8000-000000000001";
const CTM_A = `ctm_${"a".repeat(26)}`;
const CTM_B = `ctm_${"0123456789abcdefghijklmnop"}`;

/** An in-memory store holding `initial` for ORG; `writes` records every successful write. */
function memoryStore(initial: string | null, opts: { loseRace?: boolean } = {}) {
	let value = initial;
	const writes: string[] = [];
	const store: PaddleCustomerStore = {
		orgExists: async (orgId) => orgId === ORG,
		current: async () => value,
		write: async (_orgId, customerId, expected) => {
			if (opts.loseRace || value !== expected) return false;
			value = customerId;
			writes.push(customerId);
			return true;
		},
	};
	return { store, writes, read: () => value };
}

/** A Paddle client whose fetch answers `status` with `body`; `calls` records each requested URL. */
function paddle(status: number, body: unknown) {
	const calls: string[] = [];
	const client: PaddleClient = createPaddleClient({
		apiKey: "pdl_sdbx_apikey_test",
		environment: "sandbox",
		fetch: async (url) => {
			calls.push(String(url));
			return new Response(JSON.stringify(body), { status });
		},
	});
	return { client, calls };
}

/** The deps for a store and an optional Paddle client (null = Paddle not configured here). */
function deps(store: PaddleCustomerStore, client: PaddleClient | null): LinkPaddleCustomerDeps {
	return { store, client: () => client };
}

/** The ProvisionError `run` rejects with. */
async function refusal(run: Promise<unknown>): Promise<ProvisionError> {
	const err: unknown = await run.then(
		() => null,
		(e: unknown) => e,
	);
	if (err instanceof ProvisionError) return err;
	throw new Error(`expected a ProvisionError, got ${String(err)}`);
}

const found = (id: string) => ({ data: { id, status: "active", email: "billing@example.com" }, meta: { request_id: "r" } });
const notFound = { error: { type: "request_error", code: "entity_not_found", detail: "no such customer" }, meta: { request_id: "r" } };

describe("linkPaddleCustomer", () => {
	it.each(["", "ctm_short", `CTM_${"a".repeat(26)}`, `ctm_${"A".repeat(26)}`, `cus_${"a".repeat(26)}`, `ctm_${"a".repeat(27)}`])(
		"refuses %j as not a Paddle customer id, before reading anything",
		async (customerId) => {
			const store = memoryStore(null);
			const orgExists = vi.spyOn(store.store, "orgExists");
			const err = await refusal(linkPaddleCustomer({ orgId: ORG, customerId, replace: null }, deps(store.store, null)));
			expect(err.message).toMatch(/ctm_ followed by 26/);
			expect(orgExists).not.toHaveBeenCalled();
		},
	);

	it("refuses an organization that does not exist", async () => {
		const store = memoryStore(null);
		const err = await refusal(
			linkPaddleCustomer(
				{ orgId: "00000000-0000-4000-8000-000000000002", customerId: CTM_A, replace: null },
				deps(store.store, null),
			),
		);
		expect(err.message).toBe("Organization not found.");
	});

	it("links an org with no customer, confirming it with Paddle first", async () => {
		const store = memoryStore(null);
		const p = paddle(200, found(CTM_A));
		const r = await linkPaddleCustomer({ orgId: ORG, customerId: ` ${CTM_A} `, replace: null }, deps(store.store, p.client));
		expect(r).toEqual({ previous: null, customerId: CTM_A, changed: true, verified: true });
		expect(store.read()).toBe(CTM_A);
		expect(p.calls).toEqual([`https://sandbox-api.paddle.com/customers/${CTM_A}`]);
	});

	it("links without asking Paddle when Paddle is not configured, and says it was not verified", async () => {
		const store = memoryStore(null);
		const r = await linkPaddleCustomer({ orgId: ORG, customerId: CTM_A, replace: null }, deps(store.store, null));
		expect(r).toEqual({ previous: null, customerId: CTM_A, changed: true, verified: false });
	});

	it("refuses to replace a different stored id unless the caller names it", async () => {
		const store = memoryStore(CTM_A);
		const p = paddle(200, found(CTM_B));
		const unconfirmed = await refusal(
			linkPaddleCustomer({ orgId: ORG, customerId: CTM_B, replace: null }, deps(store.store, p.client)),
		);
		expect(unconfirmed.message).toContain(`already linked to Paddle customer ${CTM_A}`);
		const wrongOne = await refusal(
			linkPaddleCustomer({ orgId: ORG, customerId: CTM_B, replace: `ctm_${"z".repeat(26)}` }, deps(store.store, p.client)),
		);
		expect(wrongOne.message).toContain("Confirm replacing it");
		expect(store.writes).toEqual([]);
		expect(p.calls).toEqual([]);
	});

	it("replaces the stored id when the caller names it as the one to replace", async () => {
		const store = memoryStore(CTM_A);
		const p = paddle(200, found(CTM_B));
		const r = await linkPaddleCustomer({ orgId: ORG, customerId: CTM_B, replace: CTM_A }, deps(store.store, p.client));
		expect(r).toEqual({ previous: CTM_A, customerId: CTM_B, changed: true, verified: true });
		expect(store.read()).toBe(CTM_B);
	});

	it("does nothing when the org already holds exactly that id", async () => {
		const store = memoryStore(CTM_A);
		const p = paddle(200, found(CTM_A));
		const r = await linkPaddleCustomer({ orgId: ORG, customerId: CTM_A, replace: null }, deps(store.store, p.client));
		expect(r).toEqual({ previous: CTM_A, customerId: CTM_A, changed: false, verified: false });
		expect(store.writes).toEqual([]);
		expect(p.calls).toEqual([]);
	});

	it("refuses a customer Paddle does not know, naming the environment, and writes nothing", async () => {
		const store = memoryStore(null);
		const err = await refusal(
			linkPaddleCustomer({ orgId: ORG, customerId: CTM_A, replace: null }, deps(store.store, paddle(404, notFound).client)),
		);
		expect(err.message).toBe(
			`Paddle (sandbox) has no customer ${CTM_A}. Check the id, and that it belongs to the sandbox environment.`,
		);
		expect(store.writes).toEqual([]);
	});

	it("refuses when Paddle cannot answer, and writes nothing", async () => {
		const store = memoryStore(null);
		const err = await refusal(
			linkPaddleCustomer(
				{ orgId: ORG, customerId: CTM_A, replace: null },
				deps(store.store, paddle(503, { error: { code: "service_unavailable" } }).client),
			),
		);
		expect(err.message).toMatch(/^Could not confirm the customer with Paddle: .*503.*Nothing was stored/);
		expect(store.writes).toEqual([]);
	});

	it("refuses when Paddle answers a different customer", async () => {
		const store = memoryStore(null);
		const err = await refusal(
			linkPaddleCustomer({ orgId: ORG, customerId: CTM_A, replace: null }, deps(store.store, paddle(200, found(CTM_B)).client)),
		);
		expect(err.message).toContain("different customer");
		expect(store.writes).toEqual([]);
	});

	it("refuses a write that lost a race with another change", async () => {
		const store = memoryStore(null, { loseRace: true });
		const err = await refusal(
			linkPaddleCustomer({ orgId: ORG, customerId: CTM_A, replace: null }, deps(store.store, null)),
		);
		expect(err.message).toContain("changed while this was being saved");
	});
});
