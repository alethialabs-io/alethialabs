// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The link-paddle-customer route: fails closed without the provisioning secret or with a wrong
// bearer, answers a malformed body 400, a refusal 409 with its reason, and a link with its result.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvisionError } from "@/lib/platform/provision";

const linkPaddleCustomer = vi.fn();
vi.mock("@/lib/platform/paddle-customer", () => ({
	linkPaddleCustomer: (...args: unknown[]) => linkPaddleCustomer(...args),
}));

import { POST } from "@/app/api/internal/platform/link-paddle-customer/route";

const ORG = "00000000-0000-4000-8000-000000000001";
const CTM = `ctm_${"a".repeat(26)}`;
const original = process.env.PLATFORM_PROVISION_SECRET;
afterEach(() => {
	process.env.PLATFORM_PROVISION_SECRET = original;
	vi.clearAllMocks();
});

/** A request to the route with `body` and the bearer `token`. */
function post(body: unknown, token = "s3cret"): Request {
	process.env.PLATFORM_PROVISION_SECRET = "s3cret";
	return new Request("http://localhost/api/internal/platform/link-paddle-customer", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/internal/platform/link-paddle-customer", () => {
	it("answers 503 when provisioning is not configured", async () => {
		const req = post({ orgId: ORG, customerId: CTM });
		delete process.env.PLATFORM_PROVISION_SECRET;
		expect((await POST(req)).status).toBe(503);
		expect(linkPaddleCustomer).not.toHaveBeenCalled();
	});

	it("answers 401 to a wrong bearer", async () => {
		expect((await POST(post({ orgId: ORG, customerId: CTM }, "nope"))).status).toBe(401);
		expect(linkPaddleCustomer).not.toHaveBeenCalled();
	});

	it("answers 400 to a body without an org uuid", async () => {
		expect((await POST(post({ orgId: "acme", customerId: CTM }))).status).toBe(400);
		expect(linkPaddleCustomer).not.toHaveBeenCalled();
	});

	it("passes the link on, defaulting `replace` to null, and answers its result", async () => {
		linkPaddleCustomer.mockResolvedValue({ previous: null, customerId: CTM, changed: true, verified: true });
		const res = await POST(post({ orgId: ORG, customerId: CTM }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, previous: null, customerId: CTM, changed: true, verified: true });
		expect(linkPaddleCustomer).toHaveBeenCalledWith({ orgId: ORG, customerId: CTM, replace: null });
	});

	it("answers a refusal 409 with its reason", async () => {
		linkPaddleCustomer.mockRejectedValue(new ProvisionError("This organization is already linked."));
		const res = await POST(post({ orgId: ORG, customerId: CTM }));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "This organization is already linked." });
	});
});
