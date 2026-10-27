// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `safeDeliver` — outbound alert delivery releases its connection (#6125 review). A delivery reads
// only the status, so the response body is cancelled and the per-request connection pool closed as
// soon as the response arrives, instead of being left to undici's keep-alive reaper. `safeFetch`, whose
// callers may read the body (the OIDC discovery fetch), leaves both open. undici is stubbed; the
// target is a public IP literal, which `dns.lookup` resolves to itself without a network.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ closed: 0, cancelled: 0 }));
vi.mock("undici", () => ({
	Agent: class {
		/** Counts pool closes. */
		close() {
			h.closed++;
			return Promise.resolve();
		}
	},
	fetch: vi.fn(async () => ({
		status: 200,
		ok: true,
		headers: new Headers(),
		body: {
			cancel: () => {
				h.cancelled++;
				return Promise.resolve();
			},
		},
	})),
}));

import { safeDeliver, safeFetch } from "@/lib/net/ssrf-guard";

beforeEach(() => {
	h.closed = 0;
	h.cancelled = 0;
});

describe("safeDeliver", () => {
	it("cancels the body and closes the per-request pool once the response arrives", async () => {
		const res = await safeDeliver("https://1.1.1.1/hook", { method: "POST" });
		expect(res.status).toBe(200);
		expect(h.cancelled).toBe(1);
		expect(h.closed).toBe(1);
	});

	it("safeFetch leaves the body to its caller (control)", async () => {
		await safeFetch("https://1.1.1.1/hook");
		expect(h.cancelled).toBe(0);
		expect(h.closed).toBe(0);
	});
});
