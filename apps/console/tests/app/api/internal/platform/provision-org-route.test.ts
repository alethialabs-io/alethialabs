// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The provision-org route's slug cap (#5509). It is the org-slug rule's own length, 63: against the
// previous head the body schema allowed 64, so a 64-character slug passed the route. A slug over the
// cap is answered with the reason, not a bare "invalid request body".

import { afterEach, describe, expect, it, vi } from "vitest";

const provisionOrg = vi.fn().mockResolvedValue({ orgId: "org_1", invitationId: "inv_1" });
vi.mock("@/lib/platform/provision", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/platform/provision")>();
	return { ...real, provisionOrg: (...args: unknown[]) => provisionOrg(...args) };
});

import { POST } from "@/app/api/internal/platform/provision-org/route";

const original = process.env.PLATFORM_PROVISION_SECRET;
afterEach(() => {
	process.env.PLATFORM_PROVISION_SECRET = original;
	vi.clearAllMocks();
});

/** An authorized provision-org request for `slug`. */
function post(slug: string): Request {
	process.env.PLATFORM_PROVISION_SECRET = "s3cret";
	return new Request("http://localhost/api/internal/platform/provision-org", {
		method: "POST",
		headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
		body: JSON.stringify({ name: "Acme", slug, ownerEmail: "owner@example.com" }),
	});
}

describe("POST /api/internal/platform/provision-org — the slug cap", () => {
	it("refuses a 64-character slug with the length as the reason, and provisions nothing", async () => {
		const res = await POST(post("a".repeat(64)));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Invalid slug: Use at most 63 characters." });
		expect(provisionOrg).not.toHaveBeenCalled();
	});

	it("passes a 63-character slug on to provisionOrg", async () => {
		const res = await POST(post("a".repeat(63)));
		expect(res.status).toBe(201);
		expect(provisionOrg).toHaveBeenCalledWith(expect.objectContaining({ slug: "a".repeat(63) }));
	});
});
