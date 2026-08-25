// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: orgHasSelfRunners — the org scope on a SERVICE-ROLE path, which RLS does not cover.
//
// Why this file exists: `lib/queries/**` is excluded from the unit coverage scope under the
// rationale "Real-SQL modules verified by the integration tier … Each has a green integration
// suite". For `lib/queries/runner-capabilities.ts` that was false — no integration test named it
// and no unit test did either. It was covered by nothing, and it is the gate deciding whether
// Runners is a customer surface for an org at all.
//
// Why it must be an integration test: the function calls `getServiceDb()`, whose role BYPASSES
// row-level security. The org boundary is therefore enforced by the explicit
// `eq(runners.org_id, orgId)` predicate in that one query and by nothing else — so the assertion
// that matters is a real query against a database that also holds other orgs' rows. A mock would
// assert the shape of a call, not the boundary.
//
// The query carries TWO predicates (org_id, and operator = 'self'), so each is tested on its own
// axis: dropping either one has to fail a case here, or this suite would pass on half a query.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { orgHasSelfRunners } from "@/lib/queries/runner-capabilities";
import { describeIfDb } from "./db";

/** Operates its own runner — the only org that must answer true. */
const ORG_WITH_SELF = randomUUID();
/** A DIFFERENT org that also operates its own runner. Exists purely so that a query missing its
 *  org predicate would find a self runner and wrongly answer true for somebody else. */
const ORG_OTHER_WITH_SELF = randomUUID();
/** Has a runner, but a MANAGED one — platform-internal, so not a customer surface. */
const ORG_WITH_MANAGED_ONLY = randomUUID();

const R_SELF = randomUUID();
const R_OTHER_SELF = randomUUID();
const R_MANAGED = randomUUID();
const ALL = [R_SELF, R_OTHER_SELF, R_MANAGED];

describeIfDb("orgHasSelfRunners — org scope on the service path", () => {
	beforeAll(async () => {
		await getServiceDb()
			.insert(runners)
			.values([
				{
					id: R_SELF,
					name: `it-rc-self-${R_SELF.slice(0, 8)}`,
					// `runners_operator_owner_ck` is CHECK ((operator = 'managed') = (user_id IS NULL))
					// and `runners_provisioning_ck` is CHECK ((operator = 'self') = (provisioning IS NOT
					// NULL)) — so a self-operated row must carry both a user_id and a provisioning value.
					operator: "self",
					provisioning: "registered",
					user_id: ORG_WITH_SELF,
					org_id: ORG_WITH_SELF,
					token_hash: `h-${R_SELF}`,
					status: "ONLINE",
				},
				{
					id: R_OTHER_SELF,
					name: `it-rc-other-${R_OTHER_SELF.slice(0, 8)}`,
					operator: "self",
					provisioning: "registered",
					user_id: ORG_OTHER_WITH_SELF,
					org_id: ORG_OTHER_WITH_SELF,
					token_hash: `h-${R_OTHER_SELF}`,
					status: "ONLINE",
				},
				{
					id: R_MANAGED,
					name: `it-rc-managed-${R_MANAGED.slice(0, 8)}`,
					operator: "managed",
					user_id: null,
					// DELIBERATELY non-null, and production never produces this: managed runners are
					// the shared platform pool and carry `org_id NULL` (programmables.sql — "Managed
					// runners (org_id NULL, shared pool)"). Nothing constrains it today, and the
					// fixture needs an org that owns a runner in order to isolate the OPERATOR axis
					// — with org_id NULL this org would own nothing and the case would collapse into
					// the org-predicate case above, testing one axis twice.
					//
					// Recorded because it is a real coupling: if a CHECK ((operator = 'managed') =
					// (org_id IS NULL)) is ever added — the obvious companion to the existing
					// runners_operator_owner_ck — this suite breaks in `beforeAll` and will look
					// like a schema problem rather than a fixture that was always leaning on the
					// absence of that constraint.
					org_id: ORG_WITH_MANAGED_ONLY,
					token_hash: `h-${R_MANAGED}`,
					status: "ONLINE",
				},
			]);
	});

	afterAll(async () => {
		await getServiceDb().delete(runners).where(inArray(runners.id, ALL));
	});

	it("is true for an org that operates its own runner", async () => {
		await expect(orgHasSelfRunners(ORG_WITH_SELF)).resolves.toBe(true);
	});

	it("does not leak another org's self runner — isolates the org predicate", async () => {
		// This org owns NOTHING, while two other orgs own self runners. Only the `org_id` predicate
		// makes this false; drop it and the query finds R_SELF or R_OTHER_SELF and answers true.
		await expect(orgHasSelfRunners(randomUUID())).resolves.toBe(false);
	});

	it("does not count a MANAGED runner as self-operated — isolates the operator predicate", async () => {
		// The mirror case, varying the OTHER axis: this org does have a runner, so the org predicate
		// alone is satisfied. Only `operator = 'self'` makes it false. Without a case on this axis a
		// dropped operator predicate would go undetected.
		await expect(orgHasSelfRunners(ORG_WITH_MANAGED_ONLY)).resolves.toBe(false);
	});

	it("is true for the second self-operating org too, not just the first", async () => {
		// Guards against an answer that is accidentally keyed on something other than the org — a
		// single positive case can pass for the wrong reason.
		await expect(orgHasSelfRunners(ORG_OTHER_WITH_SELF)).resolves.toBe(true);
	});
});
