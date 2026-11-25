// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The minimal Paddle client (Paddle Billing L1): base URL by environment, bearer auth, typed errors,
// zod-parsed envelopes. `fetch` is injected, so nothing here touches the network.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPaddleClient, PaddleApiError, paddleUrl, parsePaddleData } from "@/lib/billing/paddle/api";

const KEY = `pdl_sdbx_apikey_${"c".repeat(20)}`;

/** A fetch stub answering `status` with `body` (JSON-encoded), recording what it was called with. */
function fetchAnswering(status: number, body: unknown) {
	return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe("paddleUrl", () => {
	it("targets the sandbox and live APIs by environment", () => {
		expect(paddleUrl("sandbox", "/event-types")).toBe("https://sandbox-api.paddle.com/event-types");
		expect(paddleUrl("live", "/event-types")).toBe("https://api.paddle.com/event-types");
	});

	it("adds defined query parameters only", () => {
		expect(paddleUrl("live", "/transactions", { status: "paid", after: undefined, per_page: 50 })).toBe(
			"https://api.paddle.com/transactions?status=paid&per_page=50",
		);
	});
});

describe("createPaddleClient", () => {
	it("sends bearer auth and the API version, and returns the parsed data", async () => {
		const f = fetchAnswering(200, {
			data: [{ name: "transaction.completed", group: "Transaction", extra: true }],
			meta: { request_id: "req_1" },
		});
		const client = createPaddleClient({ apiKey: KEY, environment: "sandbox", fetch: f });
		const types = await client.getEventTypes();
		expect(types.map((t) => t.name)).toEqual(["transaction.completed"]);

		const [url, init] = f.mock.calls[0];
		expect(url).toBe("https://sandbox-api.paddle.com/event-types");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(headers.get("paddle-version")).toBe("1");
		expect(init?.method).toBe("GET");
		expect(init?.body).toBeUndefined();
	});

	it("sends a JSON body with a content type", async () => {
		const f = fetchAnswering(201, { data: { id: "txn_1" } });
		const client = createPaddleClient({ apiKey: KEY, environment: "live", fetch: f });
		const out = await client.request(
			{ method: "POST", path: "/transactions", body: { items: [] } },
			z.object({ id: z.string() }),
		);
		expect(out.id).toBe("txn_1");
		const init = f.mock.calls[0][1];
		expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
		expect(init?.body).toBe(JSON.stringify({ items: [] }));
	});

	it("turns a Paddle error envelope into a typed http error", async () => {
		const f = fetchAnswering(404, {
			error: { type: "request_error", code: "not_found", detail: "Entity not found" },
			meta: { request_id: "req_404" },
		});
		const client = createPaddleClient({ apiKey: KEY, environment: "sandbox", fetch: f });
		const err = await client.getEventTypes().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PaddleApiError);
		if (!(err instanceof PaddleApiError)) return;
		expect(err.kind).toBe("http");
		expect(err.status).toBe(404);
		expect(err.code).toBe("not_found");
		expect(err.requestId).toBe("req_404");
		expect(err.outcomeUnknown).toBe(false);
		expect(err.message).not.toContain(KEY);
	});

	it("reports a body it does not understand as invalid_response", async () => {
		const client = createPaddleClient({
			apiKey: KEY,
			environment: "sandbox",
			fetch: fetchAnswering(200, { data: [{ nom: "x" }] }),
		});
		await expect(client.getEventTypes()).rejects.toMatchObject({ kind: "invalid_response", status: 200 });
	});

	it("reports a network failure as an outcome-unknown error", async () => {
		const f = vi.fn<typeof fetch>(async () => {
			throw new TypeError("fetch failed");
		});
		const client = createPaddleClient({ apiKey: KEY, environment: "sandbox", fetch: f });
		const err = await client.getEventTypes().catch((e: unknown) => e);
		expect(err).toMatchObject({ kind: "network", outcomeUnknown: true });
	});

	it("times out a hung request as an outcome-unknown error", async () => {
		const f = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const client = createPaddleClient({ apiKey: KEY, environment: "sandbox", fetch: f, timeoutMs: 5 });
		const err = await client.getEventTypes().catch((e: unknown) => e);
		expect(err).toMatchObject({ kind: "timeout", outcomeUnknown: true });
	});
});

describe("parsePaddleData", () => {
	it("returns the data member of a success envelope", () => {
		expect(parsePaddleData(z.object({ id: z.string() }), { data: { id: "sub_1" }, meta: {} })).toEqual({ id: "sub_1" });
	});

	it("names the failing paths without echoing values", () => {
		let message = "";
		try {
			parsePaddleData(z.object({ id: z.string() }), { data: { id: 42, secret: "do-not-echo" } });
		} catch (err) {
			message = err instanceof PaddleApiError ? err.message : "";
		}
		expect(message).toContain("data.id");
		expect(message).not.toContain("do-not-echo");
	});
});
