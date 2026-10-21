// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `grantBindingViolation` reads the answer of the SQL function `grant_org_binding_violation`. The
// function itself — and the trigger built on it — runs against real Postgres in
// tests/integration/grant-org-binding.test.ts; this pins the TypeScript half of the contract: a
// NULL is "bound", a known code is returned as itself, and an unknown code is an error rather
// than a pass.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted((): { rows: unknown[]; calls: number } => ({ rows: [], calls: 0 }));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		execute: async () => {
			h.calls += 1;
			return h.rows;
		},
	}),
}));

import { GRANT_BINDING_MESSAGE, grantBindingViolation } from "@/lib/authz/grant-binding";

const INPUT: Parameters<typeof grantBindingViolation>[0] = {
	orgId: "11111111-1111-4111-8111-111111111111",
	principalType: "user",
	principalId: "22222222-2222-4222-8222-222222222222",
	roleId: null,
	resource: { resourceType: "project", resourceId: "33333333-3333-4333-8333-333333333333" },
};

beforeEach(() => {
	h.rows = [];
	h.calls = 0;
});

describe("grantBindingViolation", () => {
	it("reads a NULL reason as bound", async () => {
		h.rows = [{ reason: null }];
		expect(await grantBindingViolation(INPUT)).toBeNull();
		expect(h.calls).toBe(1);
	});

	it("returns each known reason as itself, and every one has a message", async () => {
		for (const reason of ["foreign_role", "foreign_team", "foreign_resource"]) {
			h.rows = [{ reason }];
			const got = await grantBindingViolation(INPUT);
			expect(got).toBe(reason);
			expect(got === null ? "" : GRANT_BINDING_MESSAGE[got]).not.toBe("");
		}
	});

	it("throws on a code it does not know, instead of reading it as bound", async () => {
		h.rows = [{ reason: "foreign_widget" }];
		await expect(grantBindingViolation(INPUT)).rejects.toThrow(/unknown code: foreign_widget/);
	});
});
