// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The hold scope's lease key (ADR 0004 D1, §2 "Lease key"; O1 #6001): `leaseKeyFor` and its SQL twin
// `leaseKeySql`, which the store's state-write fence evaluates over the row. The fence itself is pinned
// against Postgres (tests/integration/payment-holds.test.ts, C4); these pin the two renderings and that
// they agree, scope by scope.

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { leaseKeyFor, leaseKeySql, PAYMENT_HOLD_SCOPES } from "@/lib/db/schema";

describe("leaseKeyFor", () => {
	it("names the payer user's lease for new_org and the org's for org_plan", () => {
		expect(leaseKeyFor("new_org", "user-1")).toBe("user:user-1");
		expect(leaseKeyFor("org_plan", "org-1")).toBe("org-plan:org-1");
	});

	it("gives two scopes with the same payer string two different leases", () => {
		expect(leaseKeyFor("new_org", "same")).not.toBe(leaseKeyFor("org_plan", "same"));
	});

	it("throws for a scope it has no prefix for, rather than naming a lease", () => {
		// A value that reached it untyped (a row read past the check, say): called without the type.
		expect(() => Reflect.apply(leaseKeyFor, undefined, ["ai", "org-1"])).toThrow(/ai is not a payment-hold scope/);
	});
});

describe("leaseKeySql", () => {
	const rendered = new PgDialect().sqlToQuery(leaseKeySql());

	it("is a CASE over the row's scope, concatenated with its payer key, with no bound parameters", () => {
		expect(rendered.sql).toBe(
			"((CASE payment_holds.scope WHEN 'new_org' THEN 'user:' WHEN 'org_plan' THEN 'org-plan:' END) || payment_holds.payer_key)",
		);
		expect(rendered.params).toEqual([]);
	});

	it("has no ELSE: a scope outside the list yields NULL, which matches no lease", () => {
		expect(rendered.sql).not.toMatch(/\bELSE\b/);
	});

	it("carries, for every scope, the same prefix leaseKeyFor gives it", () => {
		for (const scope of PAYMENT_HOLD_SCOPES) {
			expect(rendered.sql).toContain(`WHEN '${scope}' THEN '${leaseKeyFor(scope, "")}'`);
		}
	});
});
