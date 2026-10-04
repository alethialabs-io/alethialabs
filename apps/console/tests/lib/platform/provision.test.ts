// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// provisionOrg's slug refusals (#5509). Each names its reason — too long, the characters, or
// reserved — so the operator who typed the slug in the staff app knows what to change. Against the
// previous head the first two both answered "Invalid slug.", which did not say that a
// 64-character slug was over the cap by one.
//
// The refusals come before any database read, so the database is a stub that fails the test if
// it is reached.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
	getServiceDb: () => {
		throw new Error("provisionOrg reached the database for a slug it should have refused");
	},
}));

import { ProvisionError, provisionOrg } from "@/lib/platform/provision";

/** provisionOrg's refusal for `slug`, with an otherwise valid request. */
async function refusalFor(slug: string): Promise<ProvisionError> {
	try {
		await provisionOrg({ name: "Acme", slug, ownerEmail: "owner@example.com" });
	} catch (err) {
		if (err instanceof ProvisionError) return err;
		throw err;
	}
	throw new Error("expected provisionOrg to refuse");
}

describe("provisionOrg — the slug refusal names its reason", () => {
	it("refuses a 64-character slug as too long", async () => {
		expect((await refusalFor("a".repeat(64))).message).toBe("Invalid slug: Use at most 63 characters.");
	});

	it.each(["-acme", "acme--cloud", "acme_cloud"])("refuses %j for its characters", async (slug) => {
		expect((await refusalFor(slug)).message).toBe("Invalid slug: Use lowercase letters, numbers and hyphens.");
	});

	it("refuses a reserved slug as reserved", async () => {
		expect((await refusalFor("docs")).message).toBe("That slug is reserved.");
	});
});
